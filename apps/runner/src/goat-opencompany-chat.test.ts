import { ensureGoatMonthlyIncludedUsage } from "@opencompany/db/goat-billing";
import { hasPositiveGoatCreditBalance } from "@opencompany/db/goat-credits";
import type { GoatChatMessage, GoatChatMessageAttachment } from "@opencompany/db/goat-schema";
import type { GoatStoredChatMessage } from "@opencompany/goat-agent/chat-ui";
import type { LanguageModelUsage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { GoatCodexChatLeaseLostError } from "./goat-codex-chat-errors";
import {
  consumeGoatOpenCompanyChatStream,
  goatOpenCompanyModelMessagesFromStored,
  hasGoatHostedTurnCredits,
} from "./goat-opencompany-chat";
import {
  GoatOpenCompanyChatInterruptedError,
  type GoatOpenCompanyChatProjection,
} from "./goat-opencompany-chat-projector";

vi.mock("@opencompany/db/goat-billing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@opencompany/db/goat-billing")>()),
  ensureGoatMonthlyIncludedUsage: vi.fn(),
}));

vi.mock("@opencompany/db/goat-credits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@opencompany/db/goat-credits")>()),
  hasPositiveGoatCreditBalance: vi.fn(),
}));

describe("hosted turn credit gate", () => {
  it("refreshes the calendar-month allowance before reading the balance", async () => {
    vi.mocked(ensureGoatMonthlyIncludedUsage).mockResolvedValue({
      ok: true,
      plan: "hobby",
      seatQuantity: 1,
      grants: 1,
      expirations: 0,
      balanceUsdMicros: 5_000_000,
      allowanceCents: 500,
    });
    vi.mocked(hasPositiveGoatCreditBalance).mockResolvedValue(true);
    const db = {} as never;

    await expect(hasGoatHostedTurnCredits("goat_ws_1", db)).resolves.toBe(true);
    expect(ensureGoatMonthlyIncludedUsage).toHaveBeenCalledWith("goat_ws_1", { db });
    expect(ensureGoatMonthlyIncludedUsage).toHaveBeenCalledBefore(
      vi.mocked(hasPositiveGoatCreditBalance),
    );
  });
});

describe("consumeGoatOpenCompanyChatStream", () => {
  it("uses a responsive default cadence for durable text projections", async () => {
    let clock = 0;
    const project = vi.fn(async (_projection: GoatOpenCompanyChatProjection) => undefined);

    await consumeGoatOpenCompanyChatStream({
      fullStream: streamParts(
        { type: "text-start", id: "text_1" },
        { type: "text-delta", id: "text_1", text: "A" },
        () => {
          clock = 149;
          return { type: "text-delta", id: "text_1", text: "B" };
        },
        () => {
          clock = 150;
          return { type: "text-delta", id: "text_1", text: "C" };
        },
        { type: "text-end", id: "text_1" },
      ),
      sink: { project, recordStepUsage: vi.fn(async () => undefined) },
      signal: new AbortController().signal,
      now: () => clock,
    });

    expect(project.mock.calls[0]?.[0]).toMatchObject({
      parts: [{ type: "text", text: "A", state: "streaming" }],
    });
    expect(project.mock.calls[1]?.[0]).toMatchObject({
      parts: [{ type: "text", text: "ABC", state: "streaming" }],
    });
  });

  it("accumulates throttled text, reasoning, and the complete tool lifecycle", async () => {
    let clock = 0;
    const project = vi.fn(async (_projection: GoatOpenCompanyChatProjection) => undefined);
    const recordStepUsage = vi.fn(
      async (_input: { stepIndex: number; usage: LanguageModelUsage }) => undefined,
    );

    const result = await consumeGoatOpenCompanyChatStream({
      fullStream: streamParts(
        { type: "text-start", id: "text_1" },
        { type: "text-delta", id: "text_1", text: "Hello" },
        () => {
          clock = 100;
          return { type: "text-delta", id: "text_1", text: " world" };
        },
        () => {
          clock = 600;
          return { type: "reasoning-start", id: "reasoning_1" };
        },
        { type: "reasoning-delta", id: "reasoning_1", text: "Checking context" },
        {
          type: "tool-input-start",
          id: "tool_1",
          toolName: "goat_brain",
        },
        {
          type: "tool-call",
          toolCallId: "tool_1",
          toolName: "goat_brain",
          input: { command: "query", flags: { text: "launch" } },
          providerMetadata: { gateway: { callId: "call_1" } },
        },
        {
          type: "tool-result",
          toolCallId: "tool_1",
          toolName: "goat_brain",
          input: { command: "query", flags: { text: "launch" } },
          output: { ok: true, stdout: "Launch is Friday." },
          providerMetadata: { gateway: { resultId: "result_1" } },
        },
        {
          type: "finish-step",
          usage: {
            inputTokens: 120,
            outputTokens: 30,
            totalTokens: 150,
            inputTokenDetails: {
              noCacheTokens: 100,
              cacheReadTokens: 20,
              cacheWriteTokens: 0,
            },
            outputTokenDetails: {
              textTokens: 30,
              reasoningTokens: 0,
            },
            raw: undefined,
          },
        },
        {
          type: "text-end",
          id: "text_1",
          providerMetadata: { gateway: { textId: "text_final" } },
        },
        {
          type: "reasoning-end",
          id: "reasoning_1",
          providerMetadata: { gateway: { reasoningId: "reasoning_final" } },
        },
        {
          type: "finish",
          finishReason: "stop",
          totalUsage: {
            inputTokens: 130,
            outputTokens: 35,
            totalTokens: 165,
            inputTokenDetails: {
              noCacheTokens: 110,
              cacheReadTokens: 20,
              cacheWriteTokens: 0,
            },
            outputTokenDetails: {
              textTokens: 35,
              reasoningTokens: 0,
            },
            raw: undefined,
          },
        },
      ),
      sink: { project, recordStepUsage },
      signal: new AbortController().signal,
      now: () => clock,
      flushIntervalMs: 500,
    });

    expect(result).toMatchObject({
      finishReason: "stop",
      usage: { totalTokens: 165 },
      parts: [
        {
          type: "text",
          text: "Hello world",
          state: "done",
          providerMetadata: { gateway: { textId: "text_final" } },
        },
        {
          type: "reasoning",
          text: "Checking context",
          state: "done",
          providerMetadata: { gateway: { reasoningId: "reasoning_final" } },
        },
        {
          type: "tool-goat_brain",
          toolCallId: "tool_1",
          state: "output-available",
          input: { command: "query", flags: { text: "launch" } },
          output: { ok: true, stdout: "Launch is Friday." },
          callProviderMetadata: { gateway: { callId: "call_1" } },
          resultProviderMetadata: { gateway: { resultId: "result_1" } },
        },
      ],
    });
    expect(recordStepUsage).toHaveBeenCalledWith({
      stepIndex: 0,
      usage: expect.objectContaining({ totalTokens: 150 }),
    });

    const textOnlyWrites = project.mock.calls.filter(([projection]) => {
      const parts = projection.parts as Array<Record<string, unknown>>;
      return parts.length === 1 && parts[0]?.type === "text";
    });
    // The second delta at 100ms stays in memory; the 500ms throttle avoids a row write for it.
    expect(textOnlyWrites).toHaveLength(1);
    expect(project.mock.calls.at(-1)?.[0]).toEqual(result);
  });

  it("aborts without projecting newer output after the owning lease is lost", async () => {
    const controller = new AbortController();
    const leaseLost = new GoatCodexChatLeaseLostError();
    controller.abort(leaseLost);
    const project = vi.fn(async (_projection: GoatOpenCompanyChatProjection) => undefined);

    await expect(
      consumeGoatOpenCompanyChatStream({
        fullStream: streamParts({ type: "text-delta", id: "text_1", text: "stale" }),
        sink: {
          project,
          recordStepUsage: vi.fn(async () => undefined),
        },
        signal: controller.signal,
      }),
    ).rejects.toBe(leaseLost);
    expect(project).not.toHaveBeenCalled();
  });

  it("projects a native tool approval request as durable approval state", async () => {
    const project = vi.fn(async (_projection: GoatOpenCompanyChatProjection) => undefined);
    const result = await consumeGoatOpenCompanyChatStream({
      fullStream: streamParts(
        {
          type: "tool-call",
          toolCallId: "tool_approval_1",
          toolName: "use_action",
          input: { action: "crm.update", params: { id: "customer_1" } },
        },
        {
          type: "tool-approval-request",
          toolCallId: "tool_approval_1",
          approvalId: "approval_1",
        },
        { type: "finish", finishReason: "tool-calls" },
      ),
      sink: { project, recordStepUsage: vi.fn(async () => undefined) },
      signal: new AbortController().signal,
      flushIntervalMs: 0,
    });

    expect(result.parts).toEqual([
      expect.objectContaining({
        type: "tool-use_action",
        toolCallId: "tool_approval_1",
        state: "approval-requested",
        approval: { id: "approval_1" },
      }),
    ]);
    expect(project.mock.calls.at(-1)?.[0]).toEqual(result);
  });

  it("force-flushes the newest throttled text when the user interrupts", async () => {
    const controller = new AbortController();
    const interrupted = new GoatOpenCompanyChatInterruptedError();
    const project = vi.fn(async (_projection: GoatOpenCompanyChatProjection) => undefined);
    async function* interruptedStream() {
      yield { type: "text-start", id: "text_1" };
      yield { type: "text-delta", id: "text_1", text: "Partial text" };
      yield { type: "text-delta", id: "text_1", text: " plus newest delta" };
      controller.abort(interrupted);
      yield { type: "text-delta", id: "text_1", text: " must not appear" };
    }

    await expect(
      consumeGoatOpenCompanyChatStream({
        fullStream: interruptedStream(),
        sink: {
          project,
          recordStepUsage: vi.fn(async () => undefined),
        },
        signal: controller.signal,
        flushIntervalMs: 60_000,
      }),
    ).rejects.toBe(interrupted);

    expect(project.mock.calls.at(-1)?.[0]).toMatchObject({
      parts: [{ type: "text", text: "Partial text plus newest delta", state: "done" }],
    });
  });
});

describe("goatOpenCompanyModelMessagesFromStored", () => {
  it("keeps completed tool calls and results in follow-up model history", async () => {
    const messages = [
      storedMessage({
        id: "user_1",
        role: "user",
        content: "Look up launch day",
      }),
      storedMessage({
        id: "assistant_1",
        role: "assistant",
        content: "Launch is Friday.",
        debugTrace: {
          schemaVersion: "opencompany.chat.debug.v1",
          model: "anthropic/claude-sonnet-5",
          uiMessageParts: [
            {
              type: "tool-goat_brain",
              toolCallId: "tool_1",
              state: "output-available",
              input: { command: "query", flags: { text: "launch" } },
              output: { ok: true, stdout: "Launch is Friday." },
            },
            { type: "text", text: "Launch is Friday.", state: "done" },
          ],
        },
      }),
      storedMessage({
        id: "user_2",
        role: "user",
        content: "What should I prepare?",
      }),
      // Already-enqueued later turns must not leak into this turn's model context.
      storedMessage({
        id: "user_3",
        role: "user",
        content: "This belongs to a later queued turn.",
      }),
    ];

    const modelMessages = await goatOpenCompanyModelMessagesFromStored(messages, "user_2");

    expect(modelMessages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "user",
    ]);
    expect(JSON.stringify(modelMessages)).toContain("Launch is Friday.");
    expect(JSON.stringify(modelMessages)).not.toContain("later queued turn");
  });

  it("adds extracted attachment text to user messages", async () => {
    const messages = [
      storedMessage({
        id: "user_1",
        role: "user",
        content: "Review the attached report.",
        attachments: [attachment],
        attachmentTexts: { [attachment.id]: "Revenue was up 18% in Q2." },
      }),
    ];

    const modelMessages = await goatOpenCompanyModelMessagesFromStored(messages, "user_1", {
      modelId: "anthropic/claude-sonnet-5",
    });

    expect(JSON.stringify(modelMessages)).toContain("report.docx");
    expect(JSON.stringify(modelMessages)).toContain("Revenue was up 18% in Q2.");
  });

  it("replays the trusted approval response when a paused Run continues", async () => {
    const messages = [
      storedMessage({
        id: "user_approval",
        role: "user",
        content: "Look up the customer.",
      }),
      storedMessage({
        id: "assistant_approval",
        role: "assistant",
        content: "",
        debugTrace: {
          schemaVersion: "opencompany.chat.debug.v1",
          model: "anthropic/claude-sonnet-5",
          uiMessageParts: [
            {
              type: "tool-use_action",
              toolCallId: "tool_call_approval",
              state: "approval-responded",
              input: { action: "crm.lookup", params: { customer: "Acme" } },
              approval: { id: "approval_1", approved: true },
            },
          ],
        },
      }),
      storedMessage({
        id: "user_later",
        role: "user",
        content: "Do not include this queued turn.",
      }),
    ];

    const modelMessages = await goatOpenCompanyModelMessagesFromStored(messages, "user_approval", {
      includeCurrentAssistantMessage: true,
    });
    const serialized = JSON.stringify(modelMessages);

    expect(serialized).toContain("crm.lookup");
    expect(serialized).toContain('"approved":true');
    expect(serialized).not.toContain("Do not include this queued turn.");
  });

  it("dedupes copied workflow attachments during OpenCompany replay", async () => {
    const messages = [
      storedMessage({
        id: "user_1",
        role: "user",
        content: "Review the attached report.",
        attachments: [attachment],
        attachmentTexts: { [attachment.id]: "Revenue was up 18% in Q2." },
      }),
      storedMessage({
        id: "assistant_1",
        role: "assistant",
        content: "The first step finished.",
      }),
      storedMessage({
        id: "user_2",
        role: "user",
        content: "Continue the workflow.",
        attachments: [attachment],
        attachmentTexts: { [attachment.id]: "Revenue was up 18% in Q2." },
      }),
    ];

    const modelMessages = await goatOpenCompanyModelMessagesFromStored(messages, "user_2", {
      modelId: "anthropic/claude-sonnet-5",
    });
    const serialized = JSON.stringify(modelMessages);

    expect(serialized.match(/report\.docx/g)).toHaveLength(1);
    expect(serialized.match(/Revenue was up 18% in Q2\./g)).toHaveLength(1);
  });
});

async function* streamParts(
  ...parts: Array<Record<string, unknown> | (() => Record<string, unknown>)>
) {
  for (const part of parts) {
    yield typeof part === "function" ? part() : part;
  }
}

function storedMessage(
  input: Pick<GoatChatMessage, "id" | "role" | "content"> &
    Partial<Pick<GoatChatMessage, "debugTrace" | "attachments" | "attachmentTexts">>,
): GoatStoredChatMessage {
  return {
    id: input.id,
    sessionId: "goat_chat_1",
    role: input.role,
    content: input.content,
    taskId: null,
    debugTrace: input.debugTrace ?? null,
    attachments: input.attachments ?? null,
    attachmentTexts: input.attachmentTexts ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
    taskDisplayId: null,
    taskName: null,
    taskPrompt: null,
    taskStatus: null,
  };
}

const attachment: GoatChatMessageAttachment = {
  id: "goat_chat_att_1",
  kind: "docx",
  mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  filename: "report.docx",
  sizeBytes: 1024,
  blobPathname: "goat-chat/user_1/report.docx",
  blobUrl: "https://blob.test/goat-chat/user_1/report.docx",
};
