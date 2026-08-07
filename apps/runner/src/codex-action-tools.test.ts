import {
  GOAT_ACTION_TOOL_CONTRACT,
  type GoatActionGatewayRequest,
} from "@opencompany/agent-runtime";
import {
  createInMemoryGoatActionTurnGovernance,
  serveGoatActionRequest,
} from "@opencompany/core/actions/service";
import { describe, expect, it, vi } from "vitest";
import { createGoatCodexActionDynamicTools } from "./codex-action-tools";
import type { CodexAppServerDynamicToolCall } from "./codex-app-server";

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
      GOAT_ACTION_TOOL_CONTRACT.list.name,
      GOAT_ACTION_TOOL_CONTRACT.execute.name,
    ]);
    expect(tools.map((tool) => tool.spec.inputSchema)).toEqual([
      GOAT_ACTION_TOOL_CONTRACT.list.inputSchema,
      GOAT_ACTION_TOOL_CONTRACT.execute.inputSchema,
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

    const output = await listTool!.execute(call(GOAT_ACTION_TOOL_CONTRACT.list.name, {}));

    expect(output.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://goat.example.com/api/internal/action-gateway"),
      expect.objectContaining({
        method: "POST",
        headers: {
          authorization: "Bearer internal-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          operation: "list",
          sessionId: "codex_session_1",
          turnId: "codex_turn_1",
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
      call(GOAT_ACTION_TOOL_CONTRACT.execute.name, {
        action: "gmail.search",
        params: { query: "newer_than:1d" },
      }),
    );
    const invalid = await useTool!.execute(
      call(GOAT_ACTION_TOOL_CONTRACT.execute.name, { action: "gmail.search" }),
    );

    expect(valid.success).toBe(true);
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({
        operation: "execute",
        sessionId: "codex_session_1",
        turnId: "codex_turn_1",
        action: "gmail.search",
        params: { query: "newer_than:1d" },
        invocationId: "call_1",
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

    const output = await listTool!.execute(call(GOAT_ACTION_TOOL_CONTRACT.list.name, {}));

    expect(output).toMatchObject({ success: false });
    const contentItem = output.contentItems[0];
    expect(JSON.parse(contentItem?.type === "inputText" ? contentItem.text : "")).toMatchObject({
      ok: false,
      error: { code: "not_configured" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces call_budget on call 17 from the shared service", async () => {
    const governance = createInMemoryGoatActionTurnGovernance();
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as GoatActionGatewayRequest;
      const result = await serveGoatActionRequest({
        request,
        catalog: {
          sources: [{ id: "gmail", label: "Gmail", description: "Email" }],
          actions: [
            {
              id: "gmail.search",
              source: "gmail",
              description: "Search email.",
              params: { type: "object" },
            },
          ],
        },
        governance,
        execute: async ({ action }) => ({ ok: true, action, result: [] }),
      });
      return Response.json(result);
    });
    const [listTool, useTool] = createGoatCodexActionDynamicTools(context, {
      fetch: fetchMock,
    });

    await listTool!.execute(
      call(GOAT_ACTION_TOOL_CONTRACT.list.name, { source: "gmail" }, "list_1"),
    );
    for (let callNumber = 1; callNumber <= 16; callNumber += 1) {
      const result = await useTool!.execute(
        call(
          GOAT_ACTION_TOOL_CONTRACT.execute.name,
          { action: "gmail.search", params: {} },
          `call_${callNumber}`,
        ),
      );
      expect(result.success).toBe(true);
    }
    const rejected = await useTool!.execute(
      call(
        GOAT_ACTION_TOOL_CONTRACT.execute.name,
        { action: "gmail.search", params: {} },
        "call_17",
      ),
    );

    expect(rejected.success).toBe(false);
    const content = rejected.contentItems[0];
    expect(JSON.parse(content?.type === "inputText" ? content.text : "")).toMatchObject({
      ok: false,
      error: { code: "call_budget" },
    });
  });
});

function call(
  tool: string,
  argumentsValue: unknown,
  callId = "call_1",
): CodexAppServerDynamicToolCall {
  return {
    threadId: "thread_1",
    turnId: "turn_1",
    callId,
    namespace: null,
    tool,
    arguments: argumentsValue,
  };
}
