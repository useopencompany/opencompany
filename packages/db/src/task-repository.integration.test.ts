import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import {
  type Actor,
  TASK_READ_PERMISSION,
  TASK_WRITE_PERMISSION,
  TaskApplicationService,
} from "@opencompany/core";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PostgresChatAttachmentRepository } from "./chat-repository";
import { PostgresTaskRepository, type TaskRepositoryIdFactory } from "./task-repository";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const migrationPaths = [
  "0198_goat_headless_chat_foundation.sql",
  "0199_goat_chat_attachment_uploads.sql",
  "0200_goat_chat_run_pausing.sql",
  "0201_goat_chat_read_models_v1.sql",
  "0202_goat_headless_task_foundation.sql",
].map((filename) => path.join(repositoryRoot, "drizzle", filename));
const dialect = new PgDialect();

describe("Postgres Task repository", () => {
  let database: PGlite;
  let execute: (query: SQL) => Promise<unknown>;
  let service: TaskApplicationService;
  let migrationEvidence: {
    legacyTaskExists: boolean;
    legacyTaskProjected: boolean;
    canonicalTaskProjected: boolean;
    canonicalMessageProjected: boolean;
  };

  beforeEach(async () => {
    database = new PGlite();
    await database.exec(BASE_SCHEMA);
    await database.exec(`
      INSERT INTO goat.users (workos_user_id, task_spawning_enabled)
      VALUES ('migration_user', true);
      INSERT INTO goat.workspaces (id) VALUES ('migration_workspace');
      INSERT INTO goat.chat_sessions (id, user_workos_id, title, model, engine, kind)
      VALUES (
        'migration_task_conversation', 'migration_user', 'Existing Task',
        'moonshotai/kimi-k3', 'opencompany', 'task'
      );
      INSERT INTO goat.tasks (
        id, name, user_workos_id, workspace_id, prompt, model, session_id, status, stage
      ) VALUES
        (
          'migration_legacy_task', 'Legacy Task', 'migration_user', 'migration_workspace',
          'Keep legacy history', 'moonshotai/kimi-k3', NULL, 'succeeded', 'completed'
        ),
        (
          'migration_canonical_task', 'Existing canonical Task', 'migration_user',
          'migration_workspace', 'Keep canonical history', 'moonshotai/kimi-k3',
          'migration_task_conversation', 'succeeded', 'completed'
        );
      INSERT INTO goat.chat_messages (id, session_id, role, content)
      VALUES
        ('migration_task_message', 'migration_task_conversation', 'user', 'Keep this message'),
        ('migration_task_assistant', 'migration_task_conversation', 'assistant', 'Kept');
      INSERT INTO goat.codex_chat_sessions (
        id, user_workos_id, chat_session_id, engine, model, workspace_id
      ) VALUES (
        'migration_task_runtime', 'migration_user', 'migration_task_conversation',
        'opencompany', 'moonshotai/kimi-k3', 'migration_workspace'
      );
    `);
    for (const migrationPath of migrationPaths) {
      const migration = await readFile(migrationPath, "utf8");
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) await database.exec(statement);
      }
    }
    const migrationRows = await database.query<{
      legacy_exists: boolean;
      legacy_projected: boolean;
      canonical_projected: boolean;
      message_projected: boolean;
    }>(`
      SELECT
        EXISTS (
          SELECT 1 FROM goat.tasks WHERE id = 'migration_legacy_task' AND source = 'manual'
        ) AS legacy_exists,
        EXISTS (
          SELECT 1 FROM goat.task_read_model_v1 WHERE id = 'migration_legacy_task'
        ) AS legacy_projected,
        EXISTS (
          SELECT 1 FROM goat.task_read_model_v1
          WHERE id = 'migration_canonical_task'
            AND conversation_id = 'migration_task_conversation'
        ) AS canonical_projected,
        EXISTS (
          SELECT 1 FROM goat.message_read_model_v1
          WHERE id = 'migration_task_message'
            AND workspace_id = 'migration_workspace'
        ) AS message_projected
    `);
    const migrationRow = migrationRows.rows[0];
    migrationEvidence = {
      legacyTaskExists: migrationRow?.legacy_exists ?? false,
      legacyTaskProjected: migrationRow?.legacy_projected ?? true,
      canonicalTaskProjected: migrationRow?.canonical_projected ?? false,
      canonicalMessageProjected: migrationRow?.message_projected ?? false,
    };

    await database.exec(`
      DELETE FROM goat.task_command_idempotency;
      DELETE FROM goat.run_events;
      DELETE FROM goat.run_approvals;
      DELETE FROM goat.run_attempts;
      DELETE FROM goat.codex_chat_turns;
      DELETE FROM goat.codex_chat_sessions;
      DELETE FROM goat.chat_messages;
      DELETE FROM goat.tasks;
      DELETE FROM goat.chat_sessions;
      DELETE FROM goat.brains;
      DELETE FROM goat.workspace_members;
      DELETE FROM goat.users;
      DELETE FROM goat.workspaces;
    `);
    await database.exec(`
      INSERT INTO goat.users (workos_user_id, task_spawning_enabled)
      VALUES ('user_1', true), ('user_2', false), ('user_3', true);
      INSERT INTO goat.workspaces (id) VALUES ('workspace_1'), ('workspace_2');
      INSERT INTO goat.workspace_members (id, workspace_id, user_workos_id, role)
      VALUES
        ('member_1', 'workspace_1', 'user_1', 'admin'),
        ('member_2', 'workspace_2', 'user_2', 'admin'),
        ('member_3', 'workspace_1', 'user_3', 'member');
      INSERT INTO goat.brains (id, workspace_id, slug)
      VALUES
        ('brain_1', 'workspace_1', 'general'),
        ('brain_2', 'workspace_2', 'general');
    `);
    execute = async (query: SQL) => {
      const compiled = dialect.sqlToQuery(query);
      return database.query(compiled.sql, compiled.params as never[]);
    };
    service = new TaskApplicationService(
      new PostgresTaskRepository(execute, {
        ids: deterministicTaskIds(),
        now: () => new Date("2026-08-11T10:00:00.000Z"),
        resolveHarness: async ({ command }) => ({
          schemaVersion: "goat.harness.v1",
          engine: command.engine,
          model: command.model,
          systemPrompt: "",
          initialUserMessage: command.goal,
          tools: ["web_search"],
          skills: [],
          maxModelSteps: 16,
          resultMode: "assistant_final",
        }),
      }),
    );
  });

  afterEach(async () => {
    await database.close();
  });

  it("preserves legacy history and projects only Tasks with one canonical Conversation", () => {
    expect(migrationEvidence).toEqual({
      legacyTaskExists: true,
      legacyTaskProjected: false,
      canonicalTaskProjected: true,
      canonicalMessageProjected: true,
    });
  });

  it("atomically creates and idempotently replays one Task, Conversation, Message, and Run", async () => {
    const command = {
      idempotencyKey: "task-create-1",
      name: "Prepare the launch",
      goal: "Prepare a launch readiness brief",
      engine: "opencompany" as const,
      model: "moonshotai/kimi-k3",
      source: "manual" as const,
    };

    const first = await service.createTask(actor(), command);
    const replay = await service.createTask(actor(), command);

    expect(first).toMatchObject({
      task: {
        id: "task_2",
        name: command.name,
        goal: command.goal,
        conversationId: "conversation_3",
        status: "queued",
        source: "manual",
      },
      messageId: "message_4",
      assistantMessageId: "message_5",
      runId: "run_7",
      idempotentReplay: false,
    });
    expect(replay).toEqual({ ...first, idempotentReplay: true });

    expect(
      (
        await database.query<{
          tasks: number;
          conversations: number;
          messages: number;
          runs: number;
        }>(`
          SELECT
            (SELECT COUNT(*)::int FROM goat.tasks) AS tasks,
            (SELECT COUNT(*)::int FROM goat.chat_sessions WHERE kind = 'task') AS conversations,
            (SELECT COUNT(*)::int FROM goat.chat_messages) AS messages,
            (SELECT COUNT(*)::int FROM goat.codex_chat_turns) AS runs
        `)
      ).rows,
    ).toEqual([{ tasks: 1, conversations: 1, messages: 2, runs: 1 }]);
    expect(
      (
        await database.query<{ type: string; sequence: number }>(`
          SELECT type, sequence FROM goat.run_events ORDER BY sequence
        `)
      ).rows,
    ).toEqual([{ type: "run.queued", sequence: 1 }]);
    expect(
      (
        await database.query<{ harness_spec: { tools: string[] } }>(`
          SELECT harness_spec FROM goat.tasks
        `)
      ).rows,
    ).toEqual([{ harness_spec: expect.objectContaining({ tools: ["web_search"] }) }]);
    expect(
      (
        await database.query<{
          task_workspace: string;
          message_count: number;
          run_workspace: string;
        }>(`
          SELECT
            task.workspace_id AS task_workspace,
            (
              SELECT COUNT(*)::int
              FROM goat.message_read_model_v1 AS message
              WHERE message.conversation_id = task.conversation_id
                AND message.workspace_id = 'workspace_1'
            ) AS message_count,
            run.workspace_id AS run_workspace
          FROM goat.task_read_model_v1 AS task
          JOIN goat.run_read_model_v1 AS run ON run.conversation_id = task.conversation_id
        `)
      ).rows,
    ).toEqual([{ task_workspace: "workspace_1", message_count: 2, run_workspace: "workspace_1" }]);

    await expect(
      service.createTask(actor(), { ...command, goal: "A conflicting goal" }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("enforces feature policy and actor/workspace isolation without partial writes", async () => {
    const command = {
      idempotencyKey: "task-disabled",
      goal: "This must not be created",
      engine: "opencompany" as const,
      model: "moonshotai/kimi-k3",
      source: "manual" as const,
    };
    await expect(
      service.createTask(actor({ userId: "user_2", workspaceId: "workspace_2" }), command),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(
      (await database.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM goat.tasks"))
        .rows,
    ).toEqual([{ count: 0 }]);

    const created = await service.createTask(actor(), {
      ...command,
      idempotencyKey: "task-shared",
    });
    await expect(
      service.getTask(actor({ userId: "user_3" }), created.task.id),
    ).resolves.toMatchObject({ id: created.task.id });
    await expect(
      service.getTask(actor({ userId: "user_1", workspaceId: "workspace_2" }), created.task.id),
    ).rejects.toMatchObject({ code: "not_found" });
    await database.exec(`DELETE FROM goat.workspace_members WHERE id = 'member_3'`);
    await expect(
      service.getTask(actor({ userId: "user_3" }), created.task.id),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("uses a stable cursor and accepts either opaque or display Task identity", async () => {
    const first = await service.createTask(actor(), {
      idempotencyKey: "task-page-1",
      goal: "First task",
      engine: "opencompany",
      model: "moonshotai/kimi-k3",
      source: "manual",
    });
    const second = await service.createTask(actor(), {
      idempotencyKey: "task-page-2",
      goal: "Second task",
      engine: "opencompany",
      model: "moonshotai/kimi-k3",
      source: "manual",
    });

    const firstPage = await service.listTasks(actor(), { limit: 1 });
    if (!firstPage.nextCursor) throw new Error("Expected another Task page.");
    const secondPage = await service.listTasks(actor(), {
      cursor: firstPage.nextCursor,
      limit: 1,
    });
    expect(new Set([...firstPage.tasks, ...secondPage.tasks].map((task) => task.id))).toEqual(
      new Set([first.task.id, second.task.id]),
    );
    await expect(
      service.getTask(actor(), second.task.displayId.toLowerCase()),
    ).resolves.toMatchObject({ id: second.task.id });
  });

  it("claims an attachment once and replays without resolving it again", async () => {
    const uploads = new PostgresChatAttachmentRepository(
      execute,
      () => new Date("2026-08-11T10:00:00.000Z"),
    );
    await expect(
      uploads.create({
        actor: actor(),
        id: "attachment_1",
        format: "pdf",
        mediaType: "application/pdf",
        filename: "launch.pdf",
        sizeBytes: 2048,
        blobPathname: "private/user_1/launch.pdf",
        blobUrl: "https://blob.invalid/launch.pdf",
        extractedText: "Private launch context",
        expiresAt: new Date("2026-08-12T10:00:00.000Z"),
      }),
    ).resolves.toMatchObject({ id: "attachment_1" });
    let resolutions = 0;
    const attachmentService = new TaskApplicationService(
      new PostgresTaskRepository(execute, {
        ids: deterministicTaskIds(),
        now: () => new Date("2026-08-11T10:00:00.000Z"),
        resolveAttachments: async (input) => {
          resolutions += 1;
          return uploads.resolve(input);
        },
      }),
    );
    const command = {
      idempotencyKey: "task-attachment",
      goal: "Review the launch plan",
      engine: "opencompany" as const,
      model: "moonshotai/kimi-k3",
      source: "manual" as const,
      attachmentIds: ["attachment_1"],
    };

    const first = await attachmentService.createTask(actor(), command);
    await expect(attachmentService.createTask(actor(), command)).resolves.toEqual({
      ...first,
      idempotentReplay: true,
    });
    expect(resolutions).toBe(1);
    expect(
      (
        await database.query<{ claimed_message_id: string; claimed_at: Date }>(`
          SELECT claimed_message_id, claimed_at
          FROM goat.chat_attachment_uploads
          WHERE id = 'attachment_1'
        `)
      ).rows,
    ).toEqual([
      {
        claimed_message_id: first.messageId,
        claimed_at: new Date("2026-08-11T10:00:00.000Z"),
      },
    ]);
  });

  it("archives only terminal Tasks and reflects the lifecycle in the read model", async () => {
    const created = await service.createTask(actor(), {
      idempotencyKey: "task-archive",
      goal: "Finish before archive",
      engine: "opencompany",
      model: "moonshotai/kimi-k3",
      source: "manual",
    });
    await expect(
      service.updateTask(actor(), created.task.id, { archived: true }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    await database.query(
      `UPDATE goat.tasks SET status = 'succeeded', stage = 'completed' WHERE id = $1`,
      [created.task.id],
    );
    await expect(
      service.updateTask(actor(), created.task.id, { archived: true }),
    ).resolves.toMatchObject({
      task: { id: created.task.id, status: "archived" },
    });
    expect(
      (
        await database.query<{ status: string }>(
          "SELECT status FROM goat.task_read_model_v1 WHERE id = $1",
          [created.task.id],
        )
      ).rows,
    ).toEqual([{ status: "archived" }]);
  });
});

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    userId: "user_1",
    workspaceId: "workspace_1",
    role: "admin",
    permissions: [TASK_READ_PERMISSION, TASK_WRITE_PERMISSION],
    authenticationMethod: "session",
    ...overrides,
  };
}

function deterministicTaskIds(): TaskRepositoryIdFactory {
  let sequence = 0;
  const next = (kind: string) => `${kind}_${++sequence}`;
  return {
    command: () => next("command"),
    task: () => next("task"),
    conversation: () => next("conversation"),
    message: () => next("message"),
    runtime: () => next("runtime"),
    run: () => next("run"),
    event: () => next("event"),
  };
}

const BASE_SCHEMA = `
  CREATE SCHEMA goat;
  CREATE SEQUENCE goat.task_display_id_seq;
  CREATE TABLE goat.users (
    workos_user_id text PRIMARY KEY,
    task_spawning_enabled boolean NOT NULL DEFAULT false
  );
  CREATE TABLE goat.workspaces (id text PRIMARY KEY);
  CREATE TABLE goat.workspace_members (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    user_workos_id text NOT NULL,
    role text NOT NULL
  );
  CREATE TABLE goat.brains (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    slug text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE goat.chat_sessions (
    id text PRIMARY KEY,
    user_workos_id text NOT NULL REFERENCES goat.users(workos_user_id),
    title text NOT NULL DEFAULT 'New chat',
    model text NOT NULL,
    engine text NOT NULL DEFAULT 'opencompany',
    kind text NOT NULL DEFAULT 'chat',
    closed_at timestamptz,
    pinned_at timestamptz,
    last_seen_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE goat.tasks (
    id text PRIMARY KEY,
    display_id text NOT NULL DEFAULT ('TASK-' || nextval('goat.task_display_id_seq')::text),
    name text NOT NULL DEFAULT 'Untitled task',
    user_workos_id text NOT NULL REFERENCES goat.users(workos_user_id),
    workspace_id text REFERENCES goat.workspaces(id),
    prompt text NOT NULL,
    model text NOT NULL,
    session_id text REFERENCES goat.chat_sessions(id),
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
  CREATE UNIQUE INDEX goat_tasks_session_idx ON goat.tasks(session_id) WHERE session_id IS NOT NULL;
  CREATE TABLE goat.chat_messages (
    id text PRIMARY KEY,
    session_id text NOT NULL REFERENCES goat.chat_sessions(id),
    role text NOT NULL,
    content text NOT NULL DEFAULT '',
    task_id text,
    debug_trace jsonb,
    attachments jsonb,
    attachment_texts jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE goat.codex_chat_sessions (
    id text PRIMARY KEY,
    user_workos_id text NOT NULL,
    chat_session_id text NOT NULL UNIQUE REFERENCES goat.chat_sessions(id),
    engine text NOT NULL DEFAULT 'codex',
    model text NOT NULL,
    brain_ref text,
    workspace_id text,
    host_tool_contract_version text,
    sandbox_id text,
    codex_thread_id text,
    active_turn_id text,
    status text NOT NULL DEFAULT 'queued',
    error text,
    sandbox_timeout_armed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE goat.codex_chat_turns (
    id text PRIMARY KEY,
    user_workos_id text NOT NULL,
    codex_chat_session_id text NOT NULL REFERENCES goat.codex_chat_sessions(id),
    chat_session_id text NOT NULL REFERENCES goat.chat_sessions(id),
    user_message_id text NOT NULL REFERENCES goat.chat_messages(id),
    assistant_message_id text NOT NULL UNIQUE REFERENCES goat.chat_messages(id),
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
    lease_id text,
    lease_owner text,
    lease_expires_at timestamptz,
    run_after timestamptz,
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE goat.codex_chat_interactions (
    id text PRIMARY KEY,
    user_workos_id text NOT NULL,
    codex_chat_session_id text NOT NULL,
    codex_chat_turn_id text NOT NULL,
    lease_id text NOT NULL,
    request_id text NOT NULL,
    item_id text,
    method text NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    request jsonb NOT NULL,
    response jsonb,
    resolved_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
`;
