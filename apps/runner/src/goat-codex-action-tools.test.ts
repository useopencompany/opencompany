import {
  GOAT_CODEX_LIST_ACTIONS_TOOL_NAME,
  GOAT_CODEX_USE_ACTION_TOOL_NAME,
} from "@opencompany/agent-runtime";
import { describe, expect, it, vi } from "vitest";
import type { CodexAppServerDynamicToolCall } from "./codex-app-server";
import { createGoatCodexActionDynamicTools } from "./goat-codex-action-tools";

const context = {
  codexChatSessionId: "codex_session_1",
  codexChatTurnId: "codex_turn_1",
  env: {
    goatAppUrl: "https://goat.example.com",
    internalToken: "internal-secret",
  },
  checkAbort: vi.fn(async () => undefined),
};

describe("createGoatCodexActionDynamicTools", () => {
  it("registers generic discovery and execution tools", () => {
    const tools = createGoatCodexActionDynamicTools(context);
    expect(tools.map((tool) => tool.spec.name)).toEqual([
      GOAT_CODEX_LIST_ACTIONS_TOOL_NAME,
      GOAT_CODEX_USE_ACTION_TOOL_NAME,
    ]);
  });

  it("binds list requests to the current host session and bearer", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        ok: true,
        sources: [{ id: "gmail", label: "Gmail", description: "Email" }],
      }),
    );
    const [listTool] = createGoatCodexActionDynamicTools(context, {
      fetch: fetchMock,
    });

    const output = await listTool!.execute(call(GOAT_CODEX_LIST_ACTIONS_TOOL_NAME, {}));

    expect(output.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://goat.example.com/api/internal/codex-actions"),
      expect.objectContaining({
        method: "POST",
        headers: {
          authorization: "Bearer internal-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          operation: "list",
          codexChatSessionId: "codex_session_1",
          codexChatTurnId: "codex_turn_1",
        }),
      }),
    );
  });

  it("uses the app-server call id and rejects malformed execution locally", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ ok: true, action: "gmail.search", result: [] }),
    );
    const [, useTool] = createGoatCodexActionDynamicTools(context, {
      fetch: fetchMock,
    });

    const valid = await useTool!.execute(
      call(GOAT_CODEX_USE_ACTION_TOOL_NAME, {
        action: "gmail.search",
        params: { query: "newer_than:1d" },
      }),
    );
    const invalid = await useTool!.execute(
      call(GOAT_CODEX_USE_ACTION_TOOL_NAME, { action: "gmail.search" }),
    );

    expect(valid.success).toBe(true);
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({
        operation: "execute",
        codexChatSessionId: "codex_session_1",
        codexChatTurnId: "codex_turn_1",
        action: "gmail.search",
        params: { query: "newer_than:1d" },
        toolCallId: "call_1",
      }),
    );
    expect(invalid.success).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns a structured error without calling the network when unconfigured", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const [listTool] = createGoatCodexActionDynamicTools(
      { ...context, env: { internalToken: "internal-secret" } },
      { fetch: fetchMock },
    );

    const output = await listTool!.execute(call(GOAT_CODEX_LIST_ACTIONS_TOOL_NAME, {}));

    expect(output).toMatchObject({ success: false });
    const contentItem = output.contentItems[0];
    expect(JSON.parse(contentItem?.type === "inputText" ? contentItem.text : "")).toMatchObject({
      ok: false,
      error: { code: "not_configured" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function call(tool: string, argumentsValue: unknown): CodexAppServerDynamicToolCall {
  return {
    threadId: "thread_1",
    turnId: "turn_1",
    callId: "call_1",
    namespace: null,
    tool,
    arguments: argumentsValue,
  };
}
