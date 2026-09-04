import type { StoredChatMessage } from "@opencompany/agent/chat-ui";
import { DEFAULT_CONTEXT_WINDOW_TOKENS } from "@opencompany/agent-runtime";
import type {
  ChatMessage,
  ProductChatContextCompactionState,
} from "@opencompany/db/product-schema";
import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import {
  compactProductChatContextIfNeeded,
  contextCompactionThreshold,
  contextWindowTokensForModel,
  estimateAssembledContextTokens,
} from "./opencompany-context-compaction";

describe("opencompany context compaction", () => {
  it("does not compact below the model-specific threshold", async () => {
    const messages = conversation(2, 20);
    const summarize = vi.fn();
    const persist = vi.fn();

    const result = await compactProductChatContextIfNeeded({
      storedMessages: messages,
      currentUserMessageId: "user_2",
      modelId: "openai/gpt-5.6-sol",
      system: "system invariants",
      tools: {},
      previousState: null,
      toModelMessages,
      summarize,
      persist,
    });

    expect(result.compacted).toBe(false);
    expect(result.messages).toEqual(await toModelMessages(messages));
    expect(summarize).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it("compacts the oldest complete turns while preserving the current request and recent tail", async () => {
    const messages = conversation(6, 8_000);
    const originalTranscript = JSON.stringify(messages);
    const persist = vi.fn(async () => undefined);

    const result = await compactProductChatContextIfNeeded({
      storedMessages: messages,
      currentUserMessageId: "user_6",
      modelId: "anthropic/claude-sonnet-5",
      contextWindowTokens: 50_000,
      system: "VERBATIM SYSTEM INVARIANTS",
      tools: {
        use_action: { description: "Execute a reviewed action", inputSchema: { type: "object" } },
      },
      previousState: null,
      toModelMessages,
      summarize: async () => ({ text: "## Objective\nContinue the synthetic task." }),
      persist,
    });

    expect(result.compacted).toBe(true);
    expect(result.state?.compactedFromMessageId).toBe("user_1");
    expect(result.state?.compactedThroughMessageId).toMatch(/^assistant_/);
    expect(result.state?.firstRetainedMessageId).toMatch(/^user_/);
    expect(JSON.stringify(result.messages)).toContain("current-request-6");
    expect(JSON.stringify(result.messages)).toContain("tool-call-id-6");
    expect(JSON.stringify(result.messages)).toContain("approval-id-6");
    expect(JSON.stringify(result.messages)).not.toContain("current-request-1");
    expect(result.state!.estimatedTokensAfter).toBeLessThan(result.state!.estimatedTokensBefore);
    expect(JSON.stringify(messages)).toBe(originalTranscript);
    expect(persist).toHaveBeenCalledOnce();
  });

  it("merges the previous checkpoint with newly aged-out turns instead of stacking summaries", async () => {
    const firstMessages = conversation(6, 8_000);
    const first = await compactProductChatContextIfNeeded({
      storedMessages: firstMessages,
      currentUserMessageId: "user_6",
      modelId: "anthropic/claude-sonnet-5",
      contextWindowTokens: 50_000,
      system: "system",
      tools: {},
      previousState: null,
      toModelMessages,
      summarize: async () => ({ text: "## Objective\nFirst checkpoint marker." }),
      persist: async () => undefined,
    });
    const previousState = first.state!;
    const messages = [...firstMessages, ...conversation(3, 8_000, 7)];
    let secondPrompt = "";

    const second = await compactProductChatContextIfNeeded({
      storedMessages: messages,
      currentUserMessageId: "user_9",
      modelId: "anthropic/claude-sonnet-5",
      contextWindowTokens: 50_000,
      system: "system",
      tools: {},
      previousState,
      toModelMessages,
      summarize: async (prompt) => {
        secondPrompt = prompt;
        return { text: "## Objective\nSecond checkpoint marker." };
      },
      persist: async () => undefined,
    });

    expect(second.compacted).toBe(true);
    expect(second.state?.generation).toBe(2);
    expect(secondPrompt).toContain("First checkpoint marker");
    expect(secondPrompt).not.toContain("current-request-1");
    expect(JSON.stringify(second.messages).match(/<internal_context_checkpoint>/g)).toHaveLength(1);
    expect(JSON.stringify(second.messages)).toContain("Second checkpoint marker");
  });

  it("leaves transcript and checkpoint state untouched when summary generation fails", async () => {
    const messages = conversation(6, 8_000);
    const originalTranscript = JSON.stringify(messages);
    const persist = vi.fn();

    await expect(
      compactProductChatContextIfNeeded({
        storedMessages: messages,
        currentUserMessageId: "user_6",
        modelId: "anthropic/claude-sonnet-5",
        contextWindowTokens: 50_000,
        system: "system",
        tools: {},
        previousState: null,
        toModelMessages,
        summarize: async () => {
          throw new Error("provider unavailable");
        },
        persist,
      }),
    ).rejects.toThrow("provider unavailable");
    expect(JSON.stringify(messages)).toBe(originalTranscript);
    expect(persist).not.toHaveBeenCalled();
  });

  it("falls back to canonical history when a persisted checkpoint points to a missing message", async () => {
    const messages = conversation(2, 20);
    const staleState: ProductChatContextCompactionState = {
      summary: "stale summary",
      model: "openai/gpt-5.6-sol",
      generation: 1,
      compactedFromMessageId: "missing_1",
      compactedThroughMessageId: "missing_2",
      firstRetainedMessageId: "missing_3",
      estimatedTokensBefore: 100,
      estimatedTokensAfter: 50,
    };

    const result = await compactProductChatContextIfNeeded({
      storedMessages: messages,
      currentUserMessageId: "user_2",
      modelId: "openai/gpt-5.6-sol",
      system: "system",
      tools: {},
      previousState: staleState,
      toModelMessages,
      summarize: vi.fn(),
      persist: vi.fn(),
    });

    expect(JSON.stringify(result.messages)).not.toContain("stale summary");
    expect(JSON.stringify(result.messages)).toContain("current-request-1");
    expect(result.state).toBeNull();
  });

  it("uses configured catalog windows and includes system and tool definitions in estimates", () => {
    expect(contextWindowTokensForModel("openai/gpt-5.6-sol")).toBe(1_050_000);
    expect(contextWindowTokensForModel("retired/provider-model")).toBe(
      DEFAULT_CONTEXT_WINDOW_TOKENS,
    );
    expect(contextCompactionThreshold(200_000)).toBe(160_000);

    const base = estimateAssembledContextTokens({
      system: "short",
      messages: [],
      tools: {},
    });
    expect(
      estimateAssembledContextTokens({
        system: "short plus more instructions",
        messages: [],
        tools: { use_action: { description: "x".repeat(2_000) } },
      }),
    ).toBeGreaterThan(base);
  });
});

function conversation(turnCount: number, contentLength: number, firstTurn = 1) {
  const messages: StoredChatMessage[] = [];
  for (let offset = 0; offset < turnCount; offset += 1) {
    const turn = firstTurn + offset;
    messages.push(
      storedMessage({
        id: `user_${turn}`,
        role: "user",
        content: `current-request-${turn} ${"u".repeat(contentLength)}`,
      }),
      storedMessage({
        id: `assistant_${turn}`,
        role: "assistant",
        content: `assistant-response-${turn} ${"a".repeat(contentLength)}`,
        debugTrace: {
          schemaVersion: "opencompany.chat.debug.v1",
          uiMessageParts: [
            {
              type: "tool-use_action",
              toolCallId: `tool-call-id-${turn}`,
              state: "output-available",
              input: { action: "linear.get_issue", params: { id: `PRO-${turn}` } },
              output: { ok: true },
              ...(turn === firstTurn + turnCount - 1
                ? { approval: { id: `approval-id-${turn}`, approved: true } }
                : {}),
            },
            { type: "text", text: `assistant-response-${turn}`, state: "done" },
          ],
        },
      }),
    );
  }
  return messages;
}

async function toModelMessages(messages: readonly StoredChatMessage[]): Promise<ModelMessage[]> {
  return messages.map((message) => ({
    role: message.role === "user" ? "user" : "assistant",
    content:
      message.role === "assistant"
        ? `${message.content}\n${JSON.stringify(message.debugTrace)}`
        : message.content,
  }));
}

function storedMessage(
  input: Pick<ChatMessage, "id" | "role" | "content"> & Partial<Pick<ChatMessage, "debugTrace">>,
): StoredChatMessage {
  return {
    id: input.id,
    sessionId: "chat_1",
    role: input.role,
    content: input.content,
    taskId: null,
    debugTrace: input.debugTrace ?? null,
    attachments: null,
    attachmentTexts: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    taskDisplayId: null,
    taskName: null,
    taskPrompt: null,
    taskStatus: null,
  };
}
