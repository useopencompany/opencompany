import { GOAT_CODEX_SAVE_TO_BRAIN_TOOL_NAME } from "@opencompany/agent-runtime";
import { describe, expect, it, vi } from "vitest";
import type { CodexAppServerDynamicToolCall } from "./codex-app-server";
import { createGoatCodexBrainCaptureDynamicTool } from "./goat-codex-brain-capture-tool";

const context = {
  codexChatSessionId: "codex_session_1",
  codexChatTurnId: "codex_turn_1",
  env: {
    goatAppUrl: "https://goat.example.com",
    internalToken: "internal-secret",
  },
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

  it("binds a faithful capture to the current host turn and bearer", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        ok: true,
        status: "captured",
        draftId: "launch-decision",
        path: "inbox/launch-decision.md",
        title: "Launch decision",
      }),
    );
    const tool = createGoatCodexBrainCaptureDynamicTool(context, { fetch: fetchMock });

    const output = await tool.execute(
      call({
        content: "  The team approved the launch plan.  ",
        title: " Launch decision ",
        intent: " Keep the rationale ",
      }),
    );

    expect(output.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://goat.example.com/api/internal/codex-brain-capture"),
      expect.objectContaining({
        method: "POST",
        headers: {
          authorization: "Bearer internal-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          codexChatSessionId: "codex_session_1",
          codexChatTurnId: "codex_turn_1",
          content: "The team approved the launch plan.",
          title: "Launch decision",
          intent: "Keep the rationale",
        }),
      }),
    );
  });

  it("rejects an empty capture locally", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const tool = createGoatCodexBrainCaptureDynamicTool(context, { fetch: fetchMock });

    const output = await tool.execute(call({ title: "Nothing" }));

    expect(output.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects oversized content instead of silently falling back to a source pointer", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const tool = createGoatCodexBrainCaptureDynamicTool(context, { fetch: fetchMock });

    const output = await tool.execute(
      call({
        content: "x".repeat(64_001),
        sourceRef: "linear:issue:ENG-1",
      }),
    );

    expect(output.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed success responses from the private gateway", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
    const tool = createGoatCodexBrainCaptureDynamicTool(context, { fetch: fetchMock });

    const output = await tool.execute(call({ content: "Remember this." }));

    expect(output.success).toBe(false);
    const contentItem = output.contentItems[0];
    expect(JSON.parse(contentItem?.type === "inputText" ? contentItem.text : "{}")).toMatchObject({
      ok: false,
      error: expect.stringContaining("HTTP 200"),
    });
  });

  it("returns a structured error without calling the network when unconfigured", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const tool = createGoatCodexBrainCaptureDynamicTool(
      { ...context, env: { internalToken: "internal-secret" } },
      { fetch: fetchMock },
    );

    const output = await tool.execute(call({ content: "Remember this." }));

    expect(output.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
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
