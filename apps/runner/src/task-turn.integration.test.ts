import { PGlite } from "@electric-sql/pglite";
import type { CodexChatTurn, HarnessSpec, Task } from "@opencompany/db/product-schema";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildTaskFailureCompletion,
  markTaskTurnRunning,
  settleDurableTurn,
  type TaskTurnContext,
} from "./task-turn";

// These tests execute the real task-turn SQL against an in-process Postgres.
// The statements bind parameters inside `jsonb_build_object(...)`, whose variadic
// "any" arguments Postgres cannot type-infer: an uncast parameter there fails at
// parse time with 42P18 ("could not determine data type of parameter $N")
// regardless of the bound values. That exact defect shipped once and locked every
// production task turn into a lease-reclaim loop, so the queries must stay covered
// by a real parser, not a mocked `execute`.

const analyticsMocks = vi.hoisted(() => ({
  captureProductLlmUsageRecorded: vi.fn(async () => undefined),
  captureProductModelSpendRecorded: vi.fn(async () => undefined),
  captureProductServerEvent: vi.fn(async () => undefined),
}));
const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
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

vi.mock("@opencompany/analytics/product/server", () => ({
  captureProductLlmUsageRecorded: analyticsMocks.captureProductLlmUsageRecorded,
  captureProductModelSpendRecorded: analyticsMocks.captureProductModelSpendRecorded,
  captureProductServerEvent: analyticsMocks.captureProductServerEvent,
  productAnalyticsUsageSourceForEngine: () => "owned_platform",
}));

vi.mock("@opencompany/observability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@opencompany/observability")>()),
  createLogger: () => loggerMocks,
}));

const dialect = new PgDialect();

const SCHEMA = `
  CREATE SCHEMA goat;
  CREATE SEQUENCE goat.task_display_id_seq;
  CREATE TABLE goat.chat_sessions (
    id text PRIMARY KEY,
    user_workos_id text NOT NULL,
    title text NOT NULL DEFAULT 'New chat',
    model text NOT NULL,
    engine text NOT NULL DEFAULT 'opencompany',
    kind text NOT NULL DEFAULT 'chat',
    has_unseen boolean NOT NULL DEFAULT false,
    closed_at timestamptz,
    last_seen_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE goat.chat_messages (
    id text PRIMARY KEY,
    session_id text NOT NULL,
    role text NOT NULL,
    content text NOT NULL DEFAULT '',
    task_id text,
    debug_trace jsonb,
    attachments jsonb,
    attachment_texts jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE goat.tasks (
    id text PRIMARY KEY,
    display_id text NOT NULL DEFAULT ('TASK-' || nextval('goat.task_display_id_seq')::text),
    name text NOT NULL DEFAULT 'Untitled task',
    user_workos_id text NOT NULL,
    workspace_id text,
    prompt text NOT NULL,
    source text NOT NULL DEFAULT 'manual',
    model text NOT NULL,
    session_id text,
    schedule_id text,
    scheduled_for timestamptz,
    status text NOT NULL DEFAULT 'queued',
    stage text NOT NULL DEFAULT 'queued',
    result text,
    error text,
    workflow_id text,
    workflow_brain_ref text,
    reported_outcome text,
    outcome_comment text,
    harness_spec jsonb NOT NULL DEFAULT '{}'::jsonb,
    debug_trace jsonb NOT NULL DEFAULT '{}'::jsonb,
    codex_engine_session_id text,
    sandbox_id text,
    attempts integer NOT NULL DEFAULT 0,
    next_run_at timestamptz NOT NULL DEFAULT now(),
    lease_id text,
    lease_owner text,
    lease_expires_at timestamptz,
    archived_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE goat.codex_chat_sessions (
    id text PRIMARY KEY,
    user_workos_id text NOT NULL,
    chat_session_id text NOT NULL,
    engine text NOT NULL DEFAULT 'codex',
    model text NOT NULL,
    workspace_id text,
    host_tool_contract_version text,
    sandbox_id text,
    codex_thread_id text,
    active_turn_id text,
    status text NOT NULL DEFAULT 'queued',
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE goat.codex_chat_turns (
    id text PRIMARY KEY,
    user_workos_id text NOT NULL,
    codex_chat_session_id text NOT NULL,
    chat_session_id text NOT NULL,
    user_message_id text NOT NULL,
    assistant_message_id text NOT NULL,
    codex_turn_id text,
    status text NOT NULL DEFAULT 'queued',
    prompt text NOT NULL,
    settings jsonb NOT NULL DEFAULT '{}',
    error text,
    interrupt_requested_at timestamptz,
    attempts integer NOT NULL DEFAULT 0,
    recovery_attempts integer NOT NULL DEFAULT 0,
    engine_recovery_required boolean NOT NULL DEFAULT false,
    engine_turn_baseline_ids jsonb,
    event_sequence integer NOT NULL DEFAULT 0,
    lease_id text,
    lease_owner text,
    lease_expires_at timestamptz,
    run_after timestamptz,
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE goat.run_attempts (
    id text PRIMARY KEY,
    run_id text NOT NULL,
    number integer NOT NULL,
    status text NOT NULL,
    worker_id text NOT NULL,
    deploy_version text,
    lease_id text,
    started_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    error_code text,
    error_message text,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE goat.run_events (
    id text PRIMARY KEY,
    run_id text NOT NULL,
    attempt_id text,
    sequence integer NOT NULL,
    schema_version integer NOT NULL,
    type text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE goat.task_activities (
    id text PRIMARY KEY,
    task_id text NOT NULL,
    author text NOT NULL,
    author_workos_id text,
    kind text NOT NULL,
    body text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  );
`;

const NOW = new Date("2026-09-03T12:00:00.000Z");

function harnessSpec(): HarnessSpec {
  return {
    schemaVersion: "goat.harness.v1",
    engine: "opencompany",
    model: "moonshotai/kimi-k2.6",
    systemPrompt: "Do the task.",
    initialUserMessage: "Do the task.",
    tools: [],
    skills: [],
    maxModelSteps: 8,
    resultMode: "assistant_final",
  };
}

function taskFixture(spec: HarnessSpec, overrides?: Partial<Task>): Task {
  return {
    id: "task_1",
    displayId: "TASK-1",
    name: "Ship the change",
    userWorkosId: "user_1",
    workspaceId: null,
    prompt: "Ship the requested change.",
    source: "manual",
    model: spec.model,
    sessionId: "chat_task_1",
    scheduleId: null,
    scheduledFor: null,
    status: "running",
    stage: "running",
    result: null,
    error: null,
    workflowId: null,
    workflowBrainRef: null,
    reportedOutcome: null,
    outcomeComment: null,
    harnessSpec: spec,
    debugTrace: {},
    codexEngineSessionId: null,
    sandboxId: null,
    attempts: 1,
    nextRunAt: NOW,
    leaseId: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as Task;
}

function turnFixture(overrides?: Partial<CodexChatTurn>): CodexChatTurn {
  return {
    id: "turn_1",
    userWorkosId: "user_1",
    codexChatSessionId: "runtime_1",
    chatSessionId: "chat_task_1",
    userMessageId: "user_message_1",
    assistantMessageId: "assistant_message_1",
    codexTurnId: null,
    status: "running",
    prompt: "Ship the requested change.",
    settings: {},
    error: null,
    interruptRequestedAt: null,
    attempts: 1,
    recoveryAttempts: 0,
    engineRecoveryRequired: false,
    engineTurnBaselineIds: null,
    eventSequence: 0,
    leaseId: "lease_1",
    leaseOwner: "runner_1",
    leaseExpiresAt: new Date(NOW.getTime() + 90_000),
    runAfter: null,
    completedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as CodexChatTurn;
}

describe("task-turn SQL against real Postgres", () => {
  let pg: PGlite;

  beforeEach(async () => {
    vi.clearAllMocks();
    pg = await PGlite.create();
    await pg.exec(SCHEMA);
    dbHolder.execute = async (query: SQL) => {
      const compiled = dialect.sqlToQuery(query);
      return pg.query(compiled.sql, compiled.params as never[]);
    };
  });

  afterEach(async () => {
    dbHolder.execute = undefined;
    await pg.close();
  });

  async function seed(input: { taskStatus: string; taskStage: string; taskAttempts: number }) {
    await pg.exec(`
      INSERT INTO goat.chat_sessions (id, user_workos_id, title, model, engine, kind)
      VALUES ('chat_task_1', 'user_1', 'Ship the change', 'moonshotai/kimi-k2.6', 'opencompany', 'task');
      INSERT INTO goat.chat_messages (id, session_id, role, content)
      VALUES
        ('user_message_1', 'chat_task_1', 'user', 'Ship the requested change.'),
        ('assistant_message_1', 'chat_task_1', 'assistant', '');
      INSERT INTO goat.codex_chat_sessions (id, user_workos_id, chat_session_id, engine, model, active_turn_id, status)
      VALUES ('runtime_1', 'user_1', 'chat_task_1', 'opencompany', 'moonshotai/kimi-k2.6', 'turn_1', 'running');
      INSERT INTO goat.codex_chat_turns (
        id, user_workos_id, codex_chat_session_id, chat_session_id, user_message_id,
        assistant_message_id, status, prompt, attempts, lease_id, lease_owner, lease_expires_at
      )
      VALUES (
        'turn_1', 'user_1', 'runtime_1', 'chat_task_1', 'user_message_1',
        'assistant_message_1', 'running', 'Ship the requested change.', 1, 'lease_1', 'runner_1', now() + interval '90 seconds'
      );
    `);
    await pg.query(
      `
        INSERT INTO goat.tasks (
          id, display_id, name, user_workos_id, prompt, model, session_id, status, stage, attempts, harness_spec
        )
        VALUES ('task_1', 'TASK-1', 'Ship the change', 'user_1', 'Ship the requested change.',
                'moonshotai/kimi-k2.6', 'chat_task_1', $1, $2, $3, $4::jsonb)
      `,
      [input.taskStatus, input.taskStage, input.taskAttempts, JSON.stringify(harnessSpec())],
    );
  }

  it("marks a queued task running and records the run_started activity", async () => {
    await seed({ taskStatus: "queued", taskStage: "queued", taskAttempts: 0 });
    const spec = harnessSpec();
    const context: TaskTurnContext = {
      task: taskFixture(spec, { status: "queued", stage: "queued", attempts: 0 }),
      harnessSpec: spec,
    };

    await expect(markTaskTurnRunning({ context, turn: turnFixture() })).resolves.toBeUndefined();

    const task = await pg.query<{ status: string; stage: string; attempts: number }>(
      "SELECT status, stage, attempts FROM goat.tasks WHERE id = 'task_1'",
    );
    expect(task.rows[0]).toEqual({ status: "running", stage: "running", attempts: 1 });
    const activity = await pg.query<{ kind: string; run_id: string | null }>(
      "SELECT kind, metadata->>'runId' AS run_id FROM goat.task_activities WHERE task_id = 'task_1'",
    );
    expect(activity.rows).toEqual([{ kind: "run_started", run_id: "turn_1" }]);
  });

  it("settles a failed turn and writes the orchestrator comment activity", async () => {
    await seed({ taskStatus: "running", taskStage: "running", taskAttempts: 2 });
    const spec = harnessSpec();
    const context: TaskTurnContext = {
      task: taskFixture(spec, { attempts: 2 }),
      harnessSpec: spec,
    };

    await expect(
      settleDurableTurn({
        target: {
          userWorkosId: "user_1",
          workspaceId: null,
          codexChatSessionId: "runtime_1",
          chatSessionId: "chat_task_1",
          turnId: "turn_1",
          leaseId: "lease_1",
          leaseOwner: "runner_1",
        },
        turnStatus: "failed",
        sessionStatus: "failed",
        error: "The run failed unexpectedly.",
        completedAt: NOW,
        taskCompletion: buildTaskFailureCompletion({
          context,
          error: "The run failed unexpectedly.",
          decision: { disposition: "fail", comment: "Could not finish the change." },
        }),
      }),
    ).resolves.toBeUndefined();

    const turn = await pg.query<{ status: string; error: string | null }>(
      "SELECT status, error FROM goat.codex_chat_turns WHERE id = 'turn_1'",
    );
    expect(turn.rows[0]).toEqual({ status: "failed", error: "The run failed unexpectedly." });
    const task = await pg.query<{
      status: string;
      error: string | null;
      outcome_comment: string | null;
    }>("SELECT status, error, outcome_comment FROM goat.tasks WHERE id = 'task_1'");
    expect(task.rows[0]).toEqual({
      status: "failed",
      error: "The run failed unexpectedly.",
      outcome_comment: "Could not finish the change.",
    });
    const activities = await pg.query<{ kind: string; author: string; run_id: string | null }>(
      `SELECT kind, author, metadata->>'runId' AS run_id
       FROM goat.task_activities WHERE task_id = 'task_1' ORDER BY created_at ASC`,
    );
    expect(activities.rows).toEqual([
      { kind: "run_finished", author: "system", run_id: "turn_1" },
      { kind: "comment", author: "orchestrator", run_id: "turn_1" },
    ]);
  });

  it("queues a retry turn with the retry activity when the orchestrator asks for one", async () => {
    await seed({ taskStatus: "running", taskStage: "running", taskAttempts: 1 });
    const spec = harnessSpec();
    const context: TaskTurnContext = {
      task: taskFixture(spec, { attempts: 1 }),
      harnessSpec: spec,
    };

    await expect(
      settleDurableTurn({
        target: {
          userWorkosId: "user_1",
          workspaceId: null,
          codexChatSessionId: "runtime_1",
          chatSessionId: "chat_task_1",
          turnId: "turn_1",
          leaseId: "lease_1",
          leaseOwner: "runner_1",
        },
        turnStatus: "failed",
        sessionStatus: "failed",
        error: "The sandbox died mid-run.",
        completedAt: NOW,
        taskCompletion: buildTaskFailureCompletion({
          context,
          error: "The sandbox died mid-run.",
          decision: { disposition: "retry", comment: "Retrying after the sandbox loss." },
        }),
      }),
    ).resolves.toBeUndefined();

    const task = await pg.query<{ status: string; stage: string; attempts: number }>(
      "SELECT status, stage, attempts FROM goat.tasks WHERE id = 'task_1'",
    );
    expect(task.rows[0]).toEqual({ status: "running", stage: "queued", attempts: 2 });
    const queued = await pg.query<{ status: string }>(
      `SELECT status FROM goat.codex_chat_turns
       WHERE id <> 'turn_1' AND chat_session_id = 'chat_task_1'`,
    );
    expect(queued.rows).toEqual([{ status: "queued" }]);
    const retry = await pg.query<{ run_id: string | null; next_run_id: string | null }>(
      `SELECT metadata->>'runId' AS run_id, metadata->>'nextRunId' AS next_run_id
       FROM goat.task_activities WHERE task_id = 'task_1' AND kind = 'retry'`,
    );
    expect(retry.rows).toHaveLength(1);
    expect(retry.rows[0]?.run_id).toBe("turn_1");
    expect(retry.rows[0]?.next_run_id).toBeTruthy();
  });
});
