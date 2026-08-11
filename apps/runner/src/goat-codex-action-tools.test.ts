import {
  GOAT_ACTION_TOOL_CONTRACT,
  type GoatActionGatewayRequest,
  type GoatActionGatewayResponse,
} from "@opencompany/agent-runtime";
import {
  createInMemoryGoatActionTurnGovernance,
  serveGoatActionRequest,
} from "@opencompany/goat-agent/actions/service";
import { describe, expect, it, vi } from "vitest";
import type { CodexAppServerDynamicToolCall } from "./codex-app-server";
import { createGoatCodexActionDynamicTools } from "./goat-codex-action-tools";

const context = {
  codexChatSessionId: "codex_session_1",
  codexChatTurnId: "codex_turn_1",
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

  it("binds list requests to the current persisted host session", async () => {
    const execute = vi.fn(
      async (): Promise<GoatActionGatewayResponse> => ({
        ok: true,
        sources: [{ id: "gmail", label: "Gmail", description: "Email" }],
      }),
    );
    const [listTool] = createGoatCodexActionDynamicTools(context, {
      execute,
    });

    const output = await listTool!.execute(call(GOAT_ACTION_TOOL_CONTRACT.list.name, {}));

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
      async (): Promise<GoatActionGatewayResponse> => ({
        ok: true,
        action: "gmail.search",
        result: [],
      }),
    );
    const [, useTool] = createGoatCodexActionDynamicTools(context, {
      execute,
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
    const [listTool] = createGoatCodexActionDynamicTools(context, {
      execute: async () => ({ ok: true, sources: [] }),
    });

    const output = await listTool!.execute(call(GOAT_ACTION_TOOL_CONTRACT.list.name, {}));

    expect(output).toMatchObject({ success: true });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("surfaces call_budget on call 17 from the shared service", async () => {
    const governance = createInMemoryGoatActionTurnGovernance();
    const execute = vi.fn(async ({ request }: { request: GoatActionGatewayRequest }) => {
      return serveGoatActionRequest({
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
    const [listTool, useTool] = createGoatCodexActionDynamicTools(context, {
      execute,
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
