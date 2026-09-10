import { PGlite } from "@electric-sql/pglite";
import type { CodexChatSession, CodexChatTurn, Task } from "@opencompany/db/product-schema";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexChatLeaseLostError } from "./codex-chat-errors";
import {
  claimNextCodexChatTurn,
  forceFailClaimedTurn,
  heartbeatCodexChatTurn,
} from "./codex-chat-worker";
import type { TaskTurnContext } from "./task-turn";

// The forced settlement is the last line of defense against the lease-reclaim loop:
// when the rich failure path throws, this statement is all that stands between one
// failed turn and an unbounded retry cycle. It must always parse and settle against
// a real Postgres, so it gets integration coverage instead of text assertions.

const dbHolder = vi.hoisted(() => ({
  execute: undefined as ((query: SQL) => Promise<unknown>) | undefined,
}));

vi.mock("./db", () => ({
  getDb: () => ({
    execute: (query: SQL) => {
      if (!dbHolder.execute) throw new Error("PGlite executor is not initialized");
      return dbHolder.execute(query);
    },
  }),
}));

vi.mock("./codex-chat", () => ({ runCodexChatTurn: vi.fn() }));
vi.mock("./opencompany-chat", () => ({ runProductChatTurn: vi.fn() }));
vi.mock("./codex-chat-events", () => ({
  createExternalEngineProjector: vi.fn(),
  loadCodexChatAssistantMessageParts: vi.fn(async () => []),
}));
vi.mock("./sandbox", () => ({
  armSandboxActiveTimeoutById: vi.fn(),
  armSandboxIdleTimeoutById: vi.fn(),
}));

const dialect = new PgDialect();

const SCHEMA = `
  CREATE SCHEMA goat;
  CREATE TABLE goat.chat_sessions (
    id text PRIMARY KEY,
    user_workos_id text NOT NULL,
    model text NOT NULL,
    engine text NOT NULL,
    kind text NOT NULL DEFAULT 'chat',
    has_unseen boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE goat.tasks (
    id text PRIMARY KEY,
    user_workos_id text NOT NULL,
    prompt text NOT NULL,
    model text NOT NULL,
    session_id text,
    status text NOT NULL DEFAULT 'queued',
    stage text NOT NULL DEFAULT 'queued',
    error text,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE goat.codex_chat_sessions (
    id text PRIMARY KEY,
    user_workos_id text NOT NULL,
    chat_session_id text NOT NULL,
    engine text NOT NULL,
    model text NOT NULL,
    active_turn_id text,
    status text NOT NULL DEFAULT 'queued',
    error text,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE goat.codex_chat_turns (
    id text PRIMARY KEY,
    user_workos_id text NOT NULL,
    codex_chat_session_id text NOT NULL,
    chat_session_id text NOT NULL,
    status text NOT NULL DEFAULT 'queued',
    prompt text NOT NULL,
    error text,
    lease_id text,
    lease_owner text,
    completed_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE goat.run_attempts (
    id text PRIMARY KEY,
    run_id text NOT NULL,
    number integer NOT NULL,
    status text NOT NULL,
    worker_id text NOT NULL,
    lease_id text,
    error_code text,
    error_message text,
    completed_at timestamptz
  );
`;

function turnFixture(): CodexChatTurn {
  return {
    id: "turn_1",
    userWorkosId: "user_1",
    codexChatSessionId: "runtime_1",
    chatSessionId: "chat_task_1",
    leaseId: "lease_1",
    leaseOwner: "runner_1",
    status: "running",
  } as CodexChatTurn;
}

function sessionFixture(): CodexChatSession {
  return {
    id: "runtime_1",
    userWorkosId: "user_1",
    chatSessionId: "chat_task_1",
    engine: "codex",
    model: "gpt-5.5",
    activeTurnId: "turn_1",
    status: "running",
  } as CodexChatSession;
}

function taskContextFixture(): TaskTurnContext {
  return {
    task: { id: "task_1", sessionId: "chat_task_1" } as Task,
    harnessSpec: {} as TaskTurnContext["harnessSpec"],
  };
}

describe("durable worker claims and settlement against real Postgres", () => {
  let pg: PGlite;

  beforeEach(async () => {
    vi.clearAllMocks();
    pg = await PGlite.create();
    await pg.exec(SCHEMA);
    await pg.exec(`
      INSERT INTO goat.chat_sessions (id, user_workos_id, model, engine, kind)
      VALUES ('chat_task_1', 'user_1', 'gpt-5.5', 'codex', 'task');
      INSERT INTO goat.tasks (id, user_workos_id, prompt, model, session_id, status, stage)
      VALUES ('task_1', 'user_1', 'Ship it.', 'gpt-5.5', 'chat_task_1', 'running', 'running');
      INSERT INTO goat.codex_chat_sessions (id, user_workos_id, chat_session_id, engine, model, active_turn_id, status)
      VALUES ('runtime_1', 'user_1', 'chat_task_1', 'codex', 'gpt-5.5', 'turn_1', 'running');
      INSERT INTO goat.codex_chat_turns (id, user_workos_id, codex_chat_session_id, chat_session_id, status, prompt, lease_id, lease_owner)
      VALUES ('turn_1', 'user_1', 'runtime_1', 'chat_task_1', 'running', 'Ship it.', 'lease_1', 'runner_1');
      INSERT INTO goat.run_attempts (id, run_id, number, status, worker_id, lease_id)
      VALUES ('attempt_1', 'turn_1', 1, 'running', 'runner_1', 'lease_1');
    `);
    dbHolder.execute = async (query: SQL) => {
      const compiled = dialect.sqlToQuery(query);
      return pg.query(compiled.sql, compiled.params as never[]);
    };
  });

  afterEach(async () => {
    dbHolder.execute = undefined;
    await pg.close();
  });

  async function prepareClaimSchema() {
    await pg.exec(`
      ALTER TABLE goat.chat_sessions ADD COLUMN closed_at timestamptz;
      ALTER TABLE goat.tasks ADD COLUMN archived_at timestamptz, ADD COLUMN reported_outcome text, ADD COLUMN outcome_comment text;
      ALTER TABLE goat.codex_chat_sessions ADD COLUMN host_tool_contract_version text, ADD COLUMN sandbox_timeout_armed_at timestamptz;
      ALTER TABLE goat.codex_chat_turns
        ADD COLUMN lease_expires_at timestamptz, ADD COLUMN run_after timestamptz,
        ADD COLUMN settings jsonb DEFAULT '{}', ADD COLUMN created_at timestamptz DEFAULT now(),
        ADD COLUMN attempts integer DEFAULT 1, ADD COLUMN recovery_attempts integer DEFAULT 0,
        ADD COLUMN engine_recovery_required boolean DEFAULT false, ADD COLUMN engine_turn_baseline_ids jsonb,
        ADD COLUMN event_sequence integer DEFAULT 0, ADD COLUMN interrupt_requested_at timestamptz,
        ADD COLUMN user_message_id text, ADD COLUMN assistant_message_id text, ADD COLUMN codex_turn_id text;
    `);
  }

  it("recovers cancellation after the heartbeat releases a canceled task's lease", async () => {
    await prepareClaimSchema();
    await pg.exec(`
      UPDATE goat.tasks SET status='canceled', stage='canceled';
      UPDATE goat.codex_chat_turns SET lease_expires_at=now() - interval '1 second';
    `);
    expect(
      await claimNextCodexChatTurn({ leaseOwner: "other_worker", leaseTtlMs: 60_000 }),
    ).toBeNull();
    await pg.exec(`
      UPDATE goat.codex_chat_turns SET interrupt_requested_at=now(), lease_expires_at=now() + interval '1 minute';
    `);
    expect(
      await heartbeatCodexChatTurn({
        turnId: "turn_1",
        leaseId: "lease_1",
        leaseOwner: "runner_1",
        leaseTtlMs: 60_000,
      }),
    ).toBe(false);
    const claimed = await claimNextCodexChatTurn({
      leaseOwner: "cleanup_worker",
      leaseTtlMs: 60_000,
    });
    expect(claimed).toMatchObject({
      id: "turn_1",
      status: "running",
      leaseOwner: "cleanup_worker",
    });
    expect(claimed?.interruptRequestedAt).toBeInstanceOf(Date);
    expect(
      await heartbeatCodexChatTurn({
        turnId: claimed!.id,
        leaseId: claimed!.leaseId!,
        leaseOwner: "cleanup_worker",
        leaseTtlMs: 60_000,
        cancellationRecovery: true,
      }),
    ).toBe(true);
    expect((await pg.query("SELECT status,stage FROM goat.tasks")).rows).toEqual([
      { status: "canceled", stage: "canceled" },
    ]);
    expect(
      await claimNextCodexChatTurn({ leaseOwner: "other_worker", leaseTtlMs: 60_000 }),
    ).toBeNull();
    await pg.exec(
      "UPDATE goat.codex_chat_turns SET lease_expires_at=now() - interval '1 second'; UPDATE goat.tasks SET archived_at=now()",
    );
    expect(
      await claimNextCodexChatTurn({ leaseOwner: "archive_cleanup_worker", leaseTtlMs: 60_000 }),
    ).toMatchObject({ id: "turn_1", interruptRequestedAt: claimed!.interruptRequestedAt });
    await pg.exec(
      "UPDATE goat.codex_chat_turns SET lease_expires_at=now() - interval '1 second', interrupt_requested_at=NULL",
    );
    expect(
      await claimNextCodexChatTurn({ leaseOwner: "other_worker", leaseTtlMs: 60_000 }),
    ).toBeNull();
  });

  it("claims an approved continuation left waiting by an older API, without waking other waiting or archived tasks", async () => {
    await prepareClaimSchema();
    await pg.exec(`
      UPDATE goat.tasks SET status='waiting';
      UPDATE goat.codex_chat_turns SET status='queued';
    `);
    const claim = () => claimNextCodexChatTurn({ leaseOwner: "new_worker", leaseTtlMs: 60_000 });
    expect(await claim()).toBeNull();
    await pg.exec(
      `UPDATE goat.codex_chat_turns SET settings='{"approvalContinuation":true}'; UPDATE goat.tasks SET archived_at=now();`,
    );
    expect(await claim()).toBeNull();
    await pg.exec("UPDATE goat.tasks SET archived_at=NULL");
    expect(await claim()).toMatchObject({
      id: "turn_1",
      status: "running",
      leaseOwner: "new_worker",
    });
    expect((await pg.query("SELECT status,stage FROM goat.tasks WHERE id='task_1'")).rows).toEqual([
      { status: "queued", stage: "queued" },
    ]);
  });

  it("fails the turn, attempt, runtime, and task in one statement", async () => {
    await expect(
      forceFailClaimedTurn({
        turn: turnFixture(),
        session: sessionFixture(),
        canonicalAttemptId: "attempt_1",
        taskContext: taskContextFixture(),
        message: "This chat run failed unexpectedly. Send your message again to retry.",
      }),
    ).resolves.toBeUndefined();

    const turn = await pg.query<{ status: string; error: string | null }>(
      "SELECT status, error FROM goat.codex_chat_turns WHERE id = 'turn_1'",
    );
    expect(turn.rows[0]?.status).toBe("failed");
    expect(turn.rows[0]?.error).toContain("failed unexpectedly");
    const attempt = await pg.query<{ status: string; error_code: string | null }>(
      "SELECT status, error_code FROM goat.run_attempts WHERE id = 'attempt_1'",
    );
    expect(attempt.rows[0]).toEqual({ status: "failed", error_code: "failure_write_failed" });
    const runtime = await pg.query<{ status: string; active_turn_id: string | null }>(
      "SELECT status, active_turn_id FROM goat.codex_chat_sessions WHERE id = 'runtime_1'",
    );
    expect(runtime.rows[0]).toEqual({ status: "failed", active_turn_id: null });
    const task = await pg.query<{ status: string; stage: string }>(
      "SELECT status, stage FROM goat.tasks WHERE id = 'task_1'",
    );
    expect(task.rows[0]).toEqual({ status: "failed", stage: "failed" });
    const chat = await pg.query<{ has_unseen: boolean }>(
      "SELECT has_unseen FROM goat.chat_sessions WHERE id = 'chat_task_1'",
    );
    expect(chat.rows[0]).toEqual({ has_unseen: true });
  });

  it("leaves the task untouched for plain chat turns", async () => {
    await forceFailClaimedTurn({
      turn: turnFixture(),
      session: sessionFixture(),
      canonicalAttemptId: "attempt_1",
      taskContext: null,
      message: "This chat run failed unexpectedly. Send your message again to retry.",
    });

    const task = await pg.query<{ status: string }>(
      "SELECT status FROM goat.tasks WHERE id = 'task_1'",
    );
    expect(task.rows[0]).toEqual({ status: "running" });
  });

  it("reports lease loss when another worker owns the turn", async () => {
    await pg.exec("UPDATE goat.codex_chat_turns SET lease_id = 'lease_2' WHERE id = 'turn_1'");

    await expect(
      forceFailClaimedTurn({
        turn: turnFixture(),
        session: sessionFixture(),
        canonicalAttemptId: "attempt_1",
        taskContext: null,
        message: "This chat run failed unexpectedly.",
      }),
    ).rejects.toBeInstanceOf(CodexChatLeaseLostError);
  });
});
