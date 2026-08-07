import { GOAT_CODEX_BRAIN_TOOL_CONTRACT_VERSION } from "@opencompany/brain";
import { describe, expect, it, vi } from "vitest";
import { createGoatCodexBrainDynamicTool, executeGoatCodexBrainTool } from "./codex-brain-tool";

function context() {
  return {
    brainRef: "brain_1",
    userWorkosId: "user_1",
    chatSessionId: "chat_1",
    userMessageId: "user_message_1",
    assistantMessageId: "assistant_message_1",
    env: { vercelAiGatewayApiKey: "gateway_key" },
    checkAbort: vi.fn(async () => undefined),
  };
}

function call(argumentsValue: unknown) {
  return {
    threadId: "thread_1",
    turnId: "turn_1",
    callId: "call_1",
    namespace: null,
    tool: "goat_brain",
    arguments: argumentsValue,
  };
}

function responseJson(response: Awaited<ReturnType<typeof executeGoatCodexBrainTool>>) {
  const item = response.contentItems[0];
  if (item?.type !== "inputText") throw new Error("Expected a text tool response.");
  return JSON.parse(item.text) as unknown;
}

function dependencies() {
  const values = vi.fn(async () => undefined);
  const db = {
    insert: vi.fn(() => ({ values })),
  };
  return {
    db,
    values,
    now: vi.fn(() => new Date("2026-07-24T12:00:00.000Z")),
    randomId: vi.fn(() => "trace_1"),
    getBrainAccess: vi.fn(async () => ({ id: "brain_1" })),
    search: vi.fn(async () => [
      {
        id: "page_1",
        title: "Pricing",
        type: "note",
        kind: "page",
        folder: "sales",
        status: "active",
        updatedAt: "2026-07-24T10:00:00.000Z",
        score: 1,
        signals: ["lexical"],
        snippet: "Current pricing",
        neighbors: [],
      },
    ]),
    getDocuments: vi.fn(),
    getTimeline: vi.fn(),
    listDocuments: vi.fn(),
  };
}

describe("Codex Brain dynamic tool", () => {
  it("publishes the read-only Brain contract", () => {
    const tool = createGoatCodexBrainDynamicTool(context());

    expect(GOAT_CODEX_BRAIN_TOOL_CONTRACT_VERSION).toBe("goat-codex-brain.v1");
    expect(tool.spec).toMatchObject({
      type: "function",
      name: "goat_brain",
      inputSchema: {
        type: "object",
        required: ["command"],
        properties: {
          command: { enum: ["query", "get", "timeline", "list"] },
          flags: {
            properties: {
              id: expect.any(Object),
              text: expect.any(Object),
              folder: expect.any(Object),
              type: expect.any(Object),
            },
          },
        },
      },
    });
  });

  it("rechecks access, executes a read, and writes an auditable tool run", async () => {
    const deps = dependencies();
    const result = await executeGoatCodexBrainTool({
      context: context(),
      call: call({
        command: "query",
        flags: { text: " pricing ", limit: 10, includeNeighbors: false },
      }),
      dependencies: deps as never,
    });

    expect(deps.getBrainAccess).toHaveBeenCalledWith(
      { userWorkosId: "user_1", brainRef: "brain_1" },
      { db: deps.db },
    );
    expect(deps.search).toHaveBeenCalledWith(
      expect.objectContaining({
        brainRef: "brain_1",
        gatewayApiKey: "gateway_key",
        db: deps.db,
      }),
      expect.objectContaining({
        text: "pricing",
        kind: "page",
        limit: 11,
        offset: 0,
        includeNeighbors: false,
      }),
    );
    expect(result.success).toBe(true);
    expect(responseJson(result)).toMatchObject({
      ok: true,
      brainRef: "brain_1",
      command: "query",
      result: {
        hits: [{ id: "page_1", title: "Pricing" }],
        pagination: { limit: 10, offset: 0, returned: 1, hasMore: false },
      },
      traceId: "goat_brain_run_trace_1",
    });
    expect(deps.values).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "goat_brain_run_trace_1",
        brainRef: "brain_1",
        toolCallId: "call_1",
        sourceRef: "codex-chat:user_message_1",
        action: "query",
        ok: true,
      }),
    );
  });

  it("fails closed when Brain access was revoked and still records the attempt", async () => {
    const deps = dependencies();
    deps.getBrainAccess.mockResolvedValueOnce(null as never);

    const result = await executeGoatCodexBrainTool({
      context: context(),
      call: call({ command: "query", flags: { text: "pricing" } }),
      dependencies: deps as never,
    });

    expect(result.success).toBe(false);
    expect(responseJson(result)).toMatchObject({
      ok: false,
      error: "You no longer have access to this Brain.",
    });
    expect(deps.search).not.toHaveBeenCalled();
    expect(deps.values).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
  });

  it("rejects non-retrieval commands before touching the read plane", async () => {
    const deps = dependencies();

    const result = await executeGoatCodexBrainTool({
      context: context(),
      call: call({ command: "doctor" }),
      dependencies: deps as never,
    });

    expect(result.success).toBe(false);
    expect(responseJson(result)).toMatchObject({
      error: 'The Codex Brain tool does not support "doctor".',
    });
    expect(deps.search).not.toHaveBeenCalled();
    expect(deps.getDocuments).not.toHaveBeenCalled();
    expect(deps.getTimeline).not.toHaveBeenCalled();
    expect(deps.listDocuments).not.toHaveBeenCalled();
  });
});
