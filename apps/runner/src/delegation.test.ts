import { agentSessions, agents } from "@opencompany/db/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentConfig } from "./agent-loop-test-support";
import {
  createAgentDelegationHandler,
  isDelegatedChildActive,
  MAX_AGENT_DELEGATION_DEPTH,
} from "./delegation";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn() }));
const jobMocks = vi.hoisted(() => ({ enqueueRunnerJob: vi.fn(async () => ({ id: 1 })) }));

vi.mock("./db", () => ({ getDb: dbMocks.getDb }));
vi.mock("./jobs", () => ({ enqueueRunnerJob: jobMocks.enqueueRunnerJob }));
vi.mock("./events", () => ({ appendRuntimeEvent: vi.fn(async () => ({ id: 1 })) }));
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
