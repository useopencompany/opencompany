import {
  createInMemoryActionTurnGovernance,
  serveActionRequest,
} from "@opencompany/agent/actions/service";
import {
  ACTION_TOOL_CONTRACT,
  type ActionGatewayRequest,
  type ActionGatewayResponse,
} from "@opencompany/agent-runtime";
import { describe, expect, it, vi } from "vitest";
import { createCodexActionDynamicTools } from "./codex-action-tools";
import type { CodexAppServerDynamicToolCall } from "./codex-app-server";

const context = {
  codexChatSessionId: "codex_session_1",
  codexChatTurnId: "codex_turn_1",
  checkAbort: vi.fn(async () => undefined),
};

describe("createCodexActionDynamicTools", () => {
  it("registers generic discovery and execution tools", () => {
    const tools = createCodexActionDynamicTools(context);
    expect(tools.map((tool) => tool.spec.name)).toEqual([
      ACTION_TOOL_CONTRACT.list.name,
      ACTION_TOOL_CONTRACT.execute.name,
    ]);
    expect(tools.map((tool) => tool.spec.inputSchema)).toEqual([
      ACTION_TOOL_CONTRACT.list.inputSchema,
      ACTION_TOOL_CONTRACT.execute.inputSchema,
    ]);
  });

  it("binds list requests to the current persisted host session", async () => {
    const execute = vi.fn(
      async (): Promise<ActionGatewayResponse> => ({
        ok: true,
        sources: [{ id: "gmail", label: "Gmail", description: "Email" }],
      }),
    );
    const [listTool] = createCodexActionDynamicTools(context, {
      execute,
    });

    const output = await listTool!.execute(call(ACTION_TOOL_CONTRACT.list.name, {}));

    expect(output.success).toBe(true);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        request: {
          operation: "list",
          sessionId: "codex_session_1",
          turnId: "codex_turn_1",
        },
      }),
    );
  });

  it("uses the app-server call id and rejects malformed execution locally", async () => {
    const execute = vi.fn(
      async (): Promise<ActionGatewayResponse> => ({
        ok: true,
        action: "gmail.search",
        result: [],
      }),
    );
    const [, useTool] = createCodexActionDynamicTools(context, {
      execute,
    });

    const valid = await useTool!.execute(
      call(ACTION_TOOL_CONTRACT.execute.name, {
        action: "gmail.search",
        params: { query: "newer_than:1d" },
      }),
    );
    const invalid = await useTool!.execute(
      call(ACTION_TOOL_CONTRACT.execute.name, { action: "gmail.search" }),
    );

    expect(valid.success).toBe(true);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        request: {
          operation: "execute",
          sessionId: "codex_session_1",
          turnId: "codex_turn_1",
          action: "gmail.search",
          params: { query: "newer_than:1d" },
          invocationId: "call_1",
        },
      }),
    );
    expect(invalid.success).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not call the network when the web origin is unavailable", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("web unavailable"));
    const [listTool] = createCodexActionDynamicTools(context, {
      execute: async () => ({ ok: true, sources: [] }),
    });

    const output = await listTool!.execute(call(ACTION_TOOL_CONTRACT.list.name, {}));

    expect(output).toMatchObject({ success: true });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("surfaces call_budget on call 17 from the shared service", async () => {
    const governance = createInMemoryActionTurnGovernance();
    const execute = vi.fn(async ({ request }: { request: ActionGatewayRequest }) => {
      return serveActionRequest({
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
    });
    const [listTool, useTool] = createCodexActionDynamicTools(context, {
      execute,
    });

    await listTool!.execute(call(ACTION_TOOL_CONTRACT.list.name, { source: "gmail" }, "list_1"));
    for (let callNumber = 1; callNumber <= 16; callNumber += 1) {
      const result = await useTool!.execute(
        call(
          ACTION_TOOL_CONTRACT.execute.name,
          { action: "gmail.search", params: {} },
          `call_${callNumber}`,
        ),
      );
      expect(result.success).toBe(true);
    }
    const rejected = await useTool!.execute(
      call(ACTION_TOOL_CONTRACT.execute.name, { action: "gmail.search", params: {} }, "call_17"),
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
