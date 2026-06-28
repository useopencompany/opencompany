import {
  agentSessionEvents,
  agentSessionMessages,
  agentSessions,
  agents,
} from "@opencompany/db/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentConfig } from "./agent-loop-test-support";
import {
  autoAwaitToolCallId,
  createAgentDelegationHandler,
  isDelegatedChildActive,
  MAX_AGENT_DELEGATION_DEPTH,
  prepareAutoAwaitAtTurnEnd,
} from "./delegation";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn() }));
const jobMocks = vi.hoisted(() => ({ enqueueRunnerJob: vi.fn(async () => ({ id: 1 })) }));
const eventMocks = vi.hoisted(() => ({ appendRuntimeEvent: vi.fn(async () => ({ id: 1 })) }));

vi.mock("./db", () => ({ getDb: dbMocks.getDb }));
vi.mock("./jobs", () => ({ enqueueRunnerJob: jobMocks.enqueueRunnerJob }));
vi.mock("./events", () => ({ appendRuntimeEvent: eventMocks.appendRuntimeEvent }));
vi.mock("./delegation-usage", () => ({ emitDelegatedUsageRollup: vi.fn(async () => {}) }));
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
          return input.markerToolResult ? [input.markerToolResult] : [];
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
      childSessionIds: ["ses_child_1", "ses_child_2"],
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
          childSessionIds: ["ses_child_1", "ses_child_2"],
          assistantMessageId: "msg_assistant",
        },
      }),
    );
  });

  it("uses a deterministic synthetic tool call id unique to the assistant message", () => {
    expect(autoAwaitToolCallId("msg_one")).toBe("auto-await:msg_one");
    expect(autoAwaitToolCallId("msg_two")).toBe("auto-await:msg_two");
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
