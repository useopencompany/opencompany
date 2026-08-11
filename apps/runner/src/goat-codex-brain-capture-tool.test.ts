import { GOAT_CODEX_SAVE_TO_BRAIN_TOOL_NAME } from "@opencompany/agent-runtime";
import { describe, expect, it, vi } from "vitest";
import type { CodexAppServerDynamicToolCall } from "./codex-app-server";
import { createGoatCodexBrainCaptureDynamicTool } from "./goat-codex-brain-capture-tool";

const context = {
  codexChatSessionId: "codex_session_1",
  codexChatTurnId: "codex_turn_1",
  checkAbort: vi.fn(async () => undefined),
};

describe("createGoatCodexBrainCaptureDynamicTool", () => {
  it("registers a capture-only save_to_brain tool", () => {
    const tool = createGoatCodexBrainCaptureDynamicTool(context);

    expect(tool.spec).toMatchObject({
      type: "function",
      name: GOAT_CODEX_SAVE_TO_BRAIN_TOOL_NAME,
      description: expect.stringContaining("explicitly"),
    });
    expect(tool.spec.inputSchema).not.toHaveProperty("properties.attachmentIds");
  });

  it("binds a faithful capture to the current persisted host turn", async () => {
    const execute = vi.fn(
      async () =>
        ({
          ok: true,
          status: "captured",
          draftId: "launch-decision",
          path: "inbox/launch-decision.md",
          title: "Launch decision",
        }) as const,
    );
    const tool = createGoatCodexBrainCaptureDynamicTool(context, { execute });

    const output = await tool.execute(
      call({
        content: "  The team approved the launch plan.  ",
        title: " Launch decision ",
        intent: " Keep the rationale ",
      }),
    );

    expect(output.success).toBe(true);
    expect(execute).toHaveBeenCalledWith({
      codexChatSessionId: "codex_session_1",
      codexChatTurnId: "codex_turn_1",
      content: "The team approved the launch plan.",
      title: "Launch decision",
      intent: "Keep the rationale",
    });
  });

  it("rejects an empty capture locally", async () => {
    const execute = vi.fn();
    const tool = createGoatCodexBrainCaptureDynamicTool(context, { execute });

    const output = await tool.execute(call({ title: "Nothing" }));

    expect(output.success).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects oversized content instead of silently falling back to a source pointer", async () => {
    const execute = vi.fn();
    const tool = createGoatCodexBrainCaptureDynamicTool(context, { execute });

    const output = await tool.execute(
      call({
        content: "x".repeat(64_001),
        sourceRef: "linear:issue:ENG-1",
      }),
    );

    expect(output.success).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns a structured error when the shared service throws", async () => {
    const tool = createGoatCodexBrainCaptureDynamicTool(context, {
      execute: async () => {
        throw new Error("persistence unavailable");
      },
    });

    const output = await tool.execute(call({ content: "Remember this." }));

    expect(output.success).toBe(false);
    const contentItem = output.contentItems[0];
    expect(JSON.parse(contentItem?.type === "inputText" ? contentItem.text : "{}")).toMatchObject({
      ok: false,
      error: expect.stringContaining("persistence unavailable"),
    });
  });

  it("does not call the network when the web origin is unavailable", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("web unavailable"));
    const tool = createGoatCodexBrainCaptureDynamicTool(context, {
      execute: async () => ({
        ok: true,
        status: "captured",
        draftId: "remember-this",
        path: "inbox/remember-this.md",
        title: "Remember this",
      }),
    });

    const output = await tool.execute(call({ content: "Remember this." }));

    expect(output.success).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

function call(argumentsValue: unknown): CodexAppServerDynamicToolCall {
  return {
    threadId: "thread_1",
    turnId: "turn_1",
    callId: "call_1",
    namespace: null,
    tool: GOAT_CODEX_SAVE_TO_BRAIN_TOOL_NAME,
    arguments: argumentsValue,
  };
}
