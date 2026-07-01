import {
  agentSessionEvents,
  agentSessionMessages,
  agentSessions,
  agents,
} from "@opencompany/db/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentConfig,
  createDelegationDb,
  defaultDelegationRollupRow,
} from "./agent-loop-test-support";
import {
  autoAwaitToolCallId,
  completeDelegatedChildRunForParent,
  createAgentDelegationHandler,
  ensureAutoAwaitToolCallForReplay,
  isDelegatedChildActive,
  MAX_AGENT_DELEGATION_DEPTH,
  persistDelegationToolResult,
  prepareAutoAwaitAtTurnEnd,
  resolveDelegationResume,
} from "./delegation";
import {
  buildAssistantModelMessage,
  buildModelMessages,
  toPersistedModelMessage,
} from "./model-messages";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn() }));
const jobMocks = vi.hoisted(() => ({ enqueueRunnerJob: vi.fn(async () => ({ id: 1 })) }));
const eventMocks = vi.hoisted(() => ({ appendRuntimeEvent: vi.fn(async () => ({ id: 1 })) }));
const leaseWrites = vi.hoisted(() => ({
  appendRuntimeEventForLease: vi.fn(async () => true),
  insertToolMessageForLease: vi.fn(async () => true),
  requireLeaseWrite: vi.fn(async (value: unknown) => value),
}));

vi.mock("./db", () => ({ getDb: dbMocks.getDb }));
vi.mock("./jobs", () => ({ enqueueRunnerJob: jobMocks.enqueueRunnerJob }));
vi.mock("./events", () => ({ appendRuntimeEvent: eventMocks.appendRuntimeEvent }));
vi.mock("./lease-writes", () => leaseWrites);
vi.mock("@opencompany/observability/braintrust", () => ({
  traceBraintrustStep: vi.fn(async (_name: string, run: () => Promise<unknown>) => run()),
}));

afterEach(() => {
  vi.clearAllMocks();
});

// A minimal getDb that answers the handful of reads/writes the spawn/resume paths make. `agent`
// is returned for agents lookups; `childRow` (when set) for the delegated-child lookup. Inserted
// session rows are captured so tests can assert the engine/status the child was created with.
function createSpawnDb(input: {
  agent?: Record<string, unknown> | null;
  childRow?: Record<string, unknown> | null;
}) {
  const insertedSessions: Record<string, unknown>[] = [];
  const db = {
    insertedSessions,
    select() {
      const query = {
        table: undefined as unknown,
        from(table: unknown) {
          query.table = table;
          return query;
        },
        innerJoin() {
          return query;
        },
        where() {
          return query;
        },
        orderBy() {
          return query;
        },
        async limit() {
          if (query.table === agents) return input.agent ? [input.agent] : [];
          if (query.table === agentSessions) return input.childRow ? [input.childRow] : [];
          return [];
        },
      };
      return query;
    },
    insert(table: unknown) {
      return {
        values(values: Record<string, unknown>) {
          if (table === agentSessions) insertedSessions.push(values);
          return {};
        },
      };
    },
    async transaction(callback: (tx: unknown) => Promise<unknown>) {
      return callback(db);
    },
  };
  return db;
}

function createAutoAwaitDb(input: {
  marker?: Record<string, unknown> | null;
  markerToolResult?: Record<string, unknown> | null;
  children?: Array<{
    id: string;
    status: string;
    runLeaseId: string | null;
    agentName?: string;
    agentPath?: string | null;
    lastError?: string | null;
  }>;
  childAnswer?: string | null;
}) {
  const children = input.children ?? [];
  const db = {
    select() {
      const query = {
        table: undefined as unknown,
        joinedAgents: false,
        from(table: unknown) {
          query.table = table;
          return query;
        },
        innerJoin() {
          query.joinedAgents = true;
          return query;
        },
        where() {
          return query;
        },
        orderBy() {
          return query;
        },
        async limit() {
          return rows();
        },
        then(resolve: (value: unknown[]) => void, reject: (reason: unknown) => void) {
          Promise.resolve(rows()).then(resolve, reject);
        },
      };
      const rows = () => {
        if (query.table === agentSessionEvents) {
          return input.marker ? [{ payload: input.marker }] : [];
        }
        if (query.table === agentSessionMessages) {
          if (input.markerToolResult) return [input.markerToolResult];
          return input.childAnswer === undefined ? [] : [{ content: input.childAnswer }];
        }
        if (query.table === agentSessions && query.joinedAgents) {
          return children.map((child) => ({
            id: child.id,
            status: child.status,
            runLeaseId: child.runLeaseId,
            lastError: child.lastError ?? null,
            agentName: child.agentName ?? "Research",
            agentPath: child.agentPath ?? "agents/research/research.agent",
          }));
        }
        if (query.table === agentSessions) {
          return children.map((child) => ({ id: child.id }));
        }
        return [];
      };
      return query;
    },
  };
  return db;
}

function createAutoAwaitReplayDb(input: {
  assistantContent: string;
  assistantModelMessage: Record<string, unknown> | null;
}) {
  const assistant = {
    id: "msg_assistant",
    content: input.assistantContent,
    modelMessage: input.assistantModelMessage,
  };
  const db = {
    assistant,
    execute: vi.fn(async (query: unknown) => {
      const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
      const modelMessageJson = chunks.find(
        (chunk) => typeof chunk === "string" && chunk.startsWith('{"role":"assistant","content":'),
      );
      if (typeof modelMessageJson === "string") {
        assistant.modelMessage = JSON.parse(modelMessageJson);
      }
      return [{ id: assistant.id }];
    }),
    select() {
      const query = {
        table: undefined as unknown,
        from(table: unknown) {
          query.table = table;
          return query;
        },
        where() {
          return query;
        },
        async limit() {
          return query.table === agentSessionMessages ? [assistant] : [];
        },
      };
      return query;
    },
  };
  return db;
}

function handler(overrides: Parameters<typeof createAgentDelegationHandler>[0] | object = {}) {
  return createAgentDelegationHandler({
    parentSessionId: "ses_parent",
    parentMessageId: "msg_parent",
    workspaceId: "wks_1",
    userId: "usr_1",
    depth: 0,
    agentReferences: [{ name: "Research", path: "agents/research/research.agent" }],
    ...overrides,
  });
}

describe("delegate_to_agent async spawn", () => {
  it("creates an opencompany child and enqueues a message job", async () => {
    const db = createSpawnDb({
      agent: {
        id: "agt_research",
        name: "Research",
        path: "agents/research/research.agent",
        config: agentConfig({ engine: "opencompany" }),
      },
    });
    dbMocks.getDb.mockReturnValue(db);

    const result = await handler()({
      agent: "research",
      prompt: "Investigate X",
      toolCallId: "call_1",
    });

    expect(result).toMatchObject({ ok: true, status: "running", engine: "opencompany" });
    expect(db.insertedSessions[0]).toMatchObject({
      source: "agent",
      engine: "opencompany",
      status: "created",
      delegationDepth: 1,
      parentSessionId: "ses_parent",
      parentToolCallId: "call_1",
    });
    expect(jobMocks.enqueueRunnerJob).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "message",
        sessionId: (result as { childSessionId: string }).childSessionId,
      }),
    );
  });

  it("creates a codex child on the target's own engine and enqueues a codex_turn job", async () => {
    const db = createSpawnDb({
      agent: {
        id: "agt_codex",
        name: "Coder",
        path: "agents/coder/coder.agent",
        config: agentConfig({ engine: "codex" }),
      },
    });
    dbMocks.getDb.mockReturnValue(db);

    const result = await handler({
      parentSessionId: "ses_parent",
      parentMessageId: "msg_parent",
      workspaceId: "wks_1",
      userId: "usr_1",
      depth: 0,
      agentReferences: [{ name: "Coder", path: "agents/coder/coder.agent" }],
    })({ agent: "coder", prompt: "Open a PR", toolCallId: "call_2" });

    expect(result).toMatchObject({ ok: true, engine: "codex" });
    expect(db.insertedSessions[0]).toMatchObject({
      engine: "codex",
      status: "ready",
      modelProvider: "openai",
    });
    expect(jobMocks.enqueueRunnerJob).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "codex_turn" }),
    );
  });

  it("enforces the delegation depth limit before any spawn", async () => {
    dbMocks.getDb.mockReturnValue(createSpawnDb({ agent: null }));
    const result = await handler({
      parentSessionId: "ses_parent",
      parentMessageId: "msg_parent",
      workspaceId: "wks_1",
      userId: "usr_1",
      depth: MAX_AGENT_DELEGATION_DEPTH,
      agentReferences: [{ name: "Research", path: "agents/research/research.agent" }],
    })({ agent: "research", prompt: "too deep", toolCallId: "call_3" });

    expect(result).toMatchObject({ ok: false, status: "failed" });
    expect(jobMocks.enqueueRunnerJob).not.toHaveBeenCalled();
  });

  it("fails when the target agent is not a configured reference", async () => {
    dbMocks.getDb.mockReturnValue(createSpawnDb({ agent: null }));
    const result = await handler()({
      agent: "unknown",
      prompt: "x",
      toolCallId: "call_4",
    });
    expect(result).toMatchObject({ ok: false, status: "failed" });
    expect(jobMocks.enqueueRunnerJob).not.toHaveBeenCalled();
  });

  it("refuses to spawn a private personal agent even if it appears in configured references", async () => {
    dbMocks.getDb.mockReturnValue(
      createSpawnDb({
        agent: {
          id: "agt_personal",
          name: "Personal",
          path: "agents/research/research.agent",
          userId: "usr_other",
          config: agentConfig({ engine: "opencompany" }),
        },
      }),
    );

    const result = await handler()({
      agent: "research",
      prompt: "Investigate X",
      toolCallId: "call_private",
    });

    expect(result).toMatchObject({
      ok: false,
      status: "failed",
      error: "Agent agents/research/research.agent was not found in this workspace.",
    });
    expect(jobMocks.enqueueRunnerJob).not.toHaveBeenCalled();
  });

  it("resumes an existing child on the child's own engine", async () => {
    const db = createSpawnDb({
      agent: null,
      childRow: {
        id: "ses_child",
        workspaceId: "wks_1",
        userId: "usr_1",
        agentId: "agt_codex",
        agentName: "Coder",
        agentPath: "agents/coder/coder.agent",
        status: "completed",
        engine: "codex",
        source: "agent",
        parentSessionId: "ses_parent",
        runLeaseId: null,
        archivedAt: null,
      },
    });
    dbMocks.getDb.mockReturnValue(db);

    const result = await handler()({
      sessionId: "ses_child",
      prompt: "keep going",
      toolCallId: "call_5",
    });

    expect(result).toMatchObject({ ok: true, status: "running", resumed: true, engine: "codex" });
    expect(jobMocks.enqueueRunnerJob).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "codex_turn", sessionId: "ses_child" }),
    );
  });

  it("refuses to resume a child that is still running", async () => {
    const db = createSpawnDb({
      agent: null,
      childRow: {
        id: "ses_child",
        workspaceId: "wks_1",
        userId: "usr_1",
        agentId: "agt_codex",
        agentName: "Coder",
        agentPath: "agents/coder/coder.agent",
        status: "running",
        engine: "codex",
        source: "agent",
        parentSessionId: "ses_parent",
        runLeaseId: "run_x",
        archivedAt: null,
      },
    });
    dbMocks.getDb.mockReturnValue(db);

    const result = await handler()({
      sessionId: "ses_child",
      prompt: "again",
      toolCallId: "call_6",
    });
    expect(result).toMatchObject({ ok: false, status: "failed" });
    expect(jobMocks.enqueueRunnerJob).not.toHaveBeenCalled();
  });
});

describe("prepareAutoAwaitAtTurnEnd", () => {
  const baseInput = {
    parentSessionId: "ses_parent",
    assistantMessageId: "msg_assistant",
    leaseId: "lease_1",
    leaseOwner: "runner_1",
  };

  it("proceeds when there are no active delegated children and no marker", async () => {
    dbMocks.getDb.mockReturnValue(createAutoAwaitDb({ children: [] }));

    await expect(prepareAutoAwaitAtTurnEnd(baseInput)).resolves.toEqual({ action: "proceed" });
    expect(eventMocks.appendRuntimeEvent).not.toHaveBeenCalled();
  });

  it("proceeds when an unresolved await marker already exists", async () => {
    dbMocks.getDb.mockReturnValue(
      createAutoAwaitDb({
        marker: {
          toolCallId: "call_await",
          toolName: "await_agents",
          mode: "all",
          childSessionIds: ["ses_child"],
          assistantMessageId: "msg_prior",
        },
        children: [{ id: "ses_child", status: "running", runLeaseId: "lease_child" }],
      }),
    );

    await expect(prepareAutoAwaitAtTurnEnd(baseInput)).resolves.toEqual({ action: "proceed" });
    expect(eventMocks.appendRuntimeEvent).not.toHaveBeenCalled();
  });

  it("ignores an already-resolved prior marker when active children remain", async () => {
    dbMocks.getDb.mockReturnValue(
      createAutoAwaitDb({
        marker: {
          toolCallId: "call_prior",
          toolName: "await_agents",
          mode: "all",
          childSessionIds: ["ses_old_child"],
          assistantMessageId: "msg_prior",
        },
        markerToolResult: { id: "msg_tool_prior" },
        children: [{ id: "ses_child", status: "running", runLeaseId: "lease_child" }],
      }),
    );

    await expect(prepareAutoAwaitAtTurnEnd(baseInput)).resolves.toEqual({
      action: "suspend",
      childSessionIds: ["ses_child"],
      toolCallId: "auto-await:msg_assistant",
    });
  });

  it("suspends active delegated children and writes a synthetic await marker", async () => {
    dbMocks.getDb.mockReturnValue(
      createAutoAwaitDb({
        children: [
          { id: "ses_child_1", status: "running", runLeaseId: "lease_child_1" },
          { id: "ses_child_2", status: "awaiting_delegation", runLeaseId: null },
          { id: "ses_child_done", status: "completed", runLeaseId: null },
        ],
      }),
    );

    const result = await prepareAutoAwaitAtTurnEnd(baseInput);

    expect(result).toEqual({
      action: "suspend",
      childSessionIds: ["ses_child_1", "ses_child_2", "ses_child_done"],
      toolCallId: "auto-await:msg_assistant",
    });
    expect(eventMocks.appendRuntimeEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sessionId: "ses_parent",
        messageId: "msg_assistant",
        type: "delegation.awaiting",
        payload: {
          toolCallId: "auto-await:msg_assistant",
          toolName: "await_agents",
          mode: "all",
          childSessionIds: ["ses_child_1", "ses_child_2", "ses_child_done"],
          assistantMessageId: "msg_assistant",
        },
      }),
    );
  });

  it("resumes a synthetic await with both already-finished and newly-finished children", async () => {
    dbMocks.getDb.mockReturnValue(
      createAutoAwaitDb({
        marker: {
          toolCallId: "auto-await:msg_assistant",
          toolName: "await_agents",
          mode: "all",
          childSessionIds: ["ses_child_done", "ses_child_slow"],
          assistantMessageId: "msg_assistant",
        },
        children: [
          { id: "ses_child_done", status: "completed", runLeaseId: null },
          { id: "ses_child_slow", status: "completed", runLeaseId: null },
        ],
        childAnswer: "Delegated answer.",
      }),
    );

    await expect(resolveDelegationResume({ parentSessionId: "ses_parent" })).resolves.toEqual({
      ready: true,
      toolCallId: "auto-await:msg_assistant",
      toolName: "await_agents",
      assistantMessageId: "msg_assistant",
      result: {
        agents: [
          {
            childSessionId: "ses_child_done",
            agent: { name: "Research", path: "agents/research/research.agent" },
            status: "completed",
            answer: "Delegated answer.",
          },
          {
            childSessionId: "ses_child_slow",
            agent: { name: "Research", path: "agents/research/research.agent" },
            status: "completed",
            answer: "Delegated answer.",
          },
        ],
        pending: 0,
      },
    });
  });

  it("uses a deterministic synthetic tool call id unique to the assistant message", () => {
    expect(autoAwaitToolCallId("msg_one")).toBe("auto-await:msg_one");
    expect(autoAwaitToolCallId("msg_two")).toBe("auto-await:msg_two");
  });
});

describe("completeDelegatedChildRunForParent", () => {
  it("rolls child sandbox usage cost up to the parent delegated usage event", async () => {
    const sandboxCostUsdMicros = 1_997;
    const db = createDelegationDb({
      sessions: [
        {
          id: "ses_child",
          workspaceId: "wks_1",
          userId: "usr_1",
          agentId: "agt_codex",
          status: "completed",
          source: "agent",
          parentSessionId: "ses_parent",
          parentMessageId: "msg_parent",
          parentToolCallId: "call_delegate",
          runLeaseId: null,
          archivedAt: null,
        },
      ],
      rollupRow: {
        ...defaultDelegationRollupRow(),
        totalCostUsdMicros: sandboxCostUsdMicros,
        sandboxCostUsdMicros,
      },
    });
    dbMocks.getDb.mockReturnValue(db);

    await completeDelegatedChildRunForParent({ childSessionId: "ses_child" });

    expect(eventMocks.appendRuntimeEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sessionId: "ses_parent",
        messageId: "msg_parent",
        type: "session.delegated_usage",
        payload: expect.objectContaining({
          childSessionId: "ses_child",
          parentToolCallId: "call_delegate",
          cost: expect.objectContaining({
            sandboxCostUsdMicros,
          }),
        }),
      }),
    );
    const appendRuntimeEventCalls = eventMocks.appendRuntimeEvent.mock.calls as unknown as Array<
      [unknown, { payload?: { cost?: { sandboxCostUsdMicros?: number } } }]
    >;
    expect(appendRuntimeEventCalls[0]?.[1].payload?.cost?.sandboxCostUsdMicros).toBeGreaterThan(0);
  });
});

describe("ensureAutoAwaitToolCallForReplay", () => {
  const baseInput = {
    sessionId: "ses_parent",
    assistantMessageId: "msg_assistant",
    leaseId: "lease_1",
    leaseOwner: "runner_1",
    toolCallId: "auto-await:msg_assistant",
  };

  it("persists a synthetic assistant tool call that replays with its delegated result", async () => {
    const db = createAutoAwaitReplayDb({
      assistantContent: "I will wait for the children.",
      assistantModelMessage: toPersistedModelMessage(
        buildAssistantModelMessage({
          content: "I will wait for the children.",
          parts: [{ type: "text", text: "I will wait for the children." }],
        }),
      ),
    });
    dbMocks.getDb.mockReturnValue(db);

    await ensureAutoAwaitToolCallForReplay(baseInput);
    await persistDelegationToolResult({
      sessionId: "ses_parent",
      assistantMessageId: "msg_assistant",
      leaseId: "lease_1",
      leaseOwner: "runner_1",
      toolCallId: "auto-await:msg_assistant",
      toolName: "await_agents",
      result: {
        agents: [{ childSessionId: "ses_child", status: "completed", answer: "Done." }],
        pending: 0,
      },
    });

    const toolMessageCalls = leaseWrites.insertToolMessageForLease.mock.calls as unknown[][];
    const insertedToolMessage = toolMessageCalls[0]?.[0] as {
      modelMessage: Record<string, unknown>;
    };
    const messages = buildModelMessages([
      {
        id: "msg_assistant",
        role: "assistant",
        content: db.assistant.content,
        modelMessage: db.assistant.modelMessage,
      },
      {
        id: "msg_tool",
        role: "tool",
        content: "",
        modelMessage: insertedToolMessage.modelMessage,
      },
    ]);

    expect(db.assistant.modelMessage).toMatchObject({
      role: "assistant",
      content: [
        { type: "text", text: "I will wait for the children." },
        {
          type: "tool-call",
          toolCallId: "auto-await:msg_assistant",
          toolName: "await_agents",
          input: { mode: "all" },
        },
      ],
    });
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      content: [
        { type: "text", text: "I will wait for the children." },
        {
          type: "tool-call",
          toolCallId: "auto-await:msg_assistant",
          toolName: "await_agents",
          input: { mode: "all" },
        },
      ],
    });
    expect(messages[1]).toMatchObject({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "auto-await:msg_assistant",
          toolName: "await_agents",
        },
      ],
    });
  });

  it("does not duplicate an existing synthetic assistant tool call", async () => {
    const syntheticPart = {
      type: "tool-call" as const,
      toolCallId: "auto-await:msg_assistant",
      toolName: "await_agents",
      input: { mode: "all" },
    };
    const db = createAutoAwaitReplayDb({
      assistantContent: "I will wait for the children.",
      assistantModelMessage: toPersistedModelMessage({
        role: "assistant",
        content: [{ type: "text", text: "I will wait for the children." }, syntheticPart],
      }),
    });
    dbMocks.getDb.mockReturnValue(db);

    await ensureAutoAwaitToolCallForReplay(baseInput);

    expect(db.execute).not.toHaveBeenCalled();
    expect(db.assistant.modelMessage).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "I will wait for the children." }, syntheticPart],
    });
  });
});

describe("isDelegatedChildActive", () => {
  it("treats running, pending, and self-delegating children as active", () => {
    for (const status of ["created", "ready", "provisioning", "running", "awaiting_delegation"]) {
      expect(isDelegatedChildActive({ status, runLeaseId: null })).toBe(true);
    }
    expect(isDelegatedChildActive({ status: "completed", runLeaseId: "run_x" })).toBe(true);
  });

  it("treats finished and human-parked children as terminal-for-parent", () => {
    for (const status of [
      "completed",
      "failed",
      "archived",
      "awaiting_approval",
      "awaiting_input",
    ]) {
      expect(isDelegatedChildActive({ status, runLeaseId: null })).toBe(false);
    }
  });
});
