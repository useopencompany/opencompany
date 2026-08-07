import { describe, expect, it, vi } from "vitest";
import { recordChatModelRoutingAttempt } from "./chat-model-routing";
import { chatModelRoutingAttempts } from "./schema";

describe("Goat chat model routing attempts", () => {
  it("persists prompt-free classifier diagnostics and usage", async () => {
    const values = vi.fn(async (_value: unknown) => undefined);
    const insert = vi.fn(() => ({ values }));

    await recordChatModelRoutingAttempt({
      workspaceId: "workspace_1",
      userWorkosId: "user_1",
      chatSessionId: "session_1",
      userMessageId: "message_1",
      classifierModel: "google/gemini-3.1-flash-lite",
      selectedModel: "moonshotai/kimi-k3",
      tier: "frontier",
      reason: "router_fallback",
      outcome: "invalid",
      durationMs: 640,
      errorCategory: "output_length",
      finishReason: "length",
      promptLength: 42,
      attachmentCount: 0,
      inputTokens: 20,
      outputTokens: 30,
      totalTokens: 50,
      db: { insert },
    });

    expect(insert).toHaveBeenCalledWith(chatModelRoutingAttempts);
    expect(values).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      userWorkosId: "user_1",
      chatSessionId: "session_1",
      userMessageId: "message_1",
      classifierModel: "google/gemini-3.1-flash-lite",
      selectedModel: "moonshotai/kimi-k3",
      tier: "frontier",
      reason: "router_fallback",
      outcome: "invalid",
      durationMs: 640,
      errorCategory: "output_length",
      finishReason: "length",
      providerStatusCode: null,
      providerRetryable: null,
      promptLength: 42,
      attachmentCount: 0,
      inputTokens: 20,
      outputTokens: 30,
      totalTokens: 50,
    });
    expect(values.mock.calls[0]?.[0]).not.toHaveProperty("prompt");
  });
});
