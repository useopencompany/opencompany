import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import {
  type Actor,
  CHAT_READ_PERMISSION,
  CHAT_WRITE_PERMISSION,
  ChatApplicationService,
  CoreError,
} from "@opencompany/core";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ChatRepositoryIdFactory,
  PostgresChatAttachmentRepository,
  PostgresChatRepository,
  PostgresRunExecutionRepository,
} from "./chat-repository";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const migrationPaths = [
  "0198_goat_headless_chat_foundation.sql",
  "0199_goat_chat_attachment_uploads.sql",
].map((filename) => path.join(repositoryRoot, "drizzle", filename));
const dialect = new PgDialect();

describe("Postgres Chat repositories", () => {
  let database: PGlite;
  let repository: PostgresChatRepository;
  let service: ChatApplicationService;
  let execute: (query: SQL) => Promise<unknown>;
  let legacySurvivedMigration: boolean;

  beforeEach(async () => {
    database = new PGlite();
    await database.exec(BASE_SCHEMA);
    await database.exec(`
      INSERT INTO goat.users (workos_user_id) VALUES ('migration_user');
      INSERT INTO goat.workspaces (id) VALUES ('migration_workspace');
      INSERT INTO goat.chat_sessions (id, user_workos_id, model)
        VALUES ('migration_conversation', 'migration_user', 'provider/model');
      INSERT INTO goat.chat_messages (id, session_id, role, content)
        VALUES
          ('migration_message', 'migration_conversation', 'user', 'Preserve me'),
          ('migration_assistant', 'migration_conversation', 'assistant', 'Preserved');
      INSERT INTO goat.codex_chat_sessions (
        id, user_workos_id, chat_session_id, engine, model, workspace_id
      ) VALUES (
        'migration_runtime', 'migration_user', 'migration_conversation',
        'opencompany', 'provider/model', 'migration_workspace'
      );
      INSERT INTO goat.codex_chat_turns (
        id, user_workos_id, codex_chat_session_id, chat_session_id,
        user_message_id, assistant_message_id, prompt
      ) VALUES (
        'migration_run', 'migration_user', 'migration_runtime', 'migration_conversation',
        'migration_message', 'migration_assistant', 'Preserve me'
      );
    `);
    for (const migrationPath of migrationPaths) {
      const migration = await readFile(migrationPath, "utf8");
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) await database.exec(statement);
      }
    }
    const migrated = await database.query<{ id: string; event_sequence: number }>(`
      SELECT id, event_sequence
      FROM goat.codex_chat_turns
      WHERE id = 'migration_run'
    `);
    legacySurvivedMigration =
      migrated.rows[0]?.id === "migration_run" && migrated.rows[0].event_sequence === 0;
    await database.exec(`
      DELETE FROM goat.codex_chat_turns;
      DELETE FROM goat.codex_chat_sessions;
      DELETE FROM goat.chat_messages;
      DELETE FROM goat.chat_sessions;
      DELETE FROM goat.users;
      DELETE FROM goat.workspaces;
    `);
    await database.exec(`
      INSERT INTO goat.users (workos_user_id) VALUES ('user_1'), ('user_2');
      INSERT INTO goat.workspaces (id) VALUES ('workspace_1'), ('workspace_2');
      INSERT INTO goat.workspace_members (id, workspace_id, user_workos_id, role)
      VALUES
        ('member_1', 'workspace_1', 'user_1', 'admin'),
        ('member_2', 'workspace_2', 'user_2', 'admin');
    `);
    execute = async (query) => {
      const compiled = dialect.sqlToQuery(query);
      return database.query(compiled.sql, compiled.params as never[]);
    };
    repository = new PostgresChatRepository(execute, {
      ids: deterministicIds(),
      now: () => new Date("2026-08-10T20:00:00.000Z"),
    });
    service = new ChatApplicationService(repository);
  });

  afterEach(async () => {
    await database.close();
  });

  it("keeps pre-existing durable rows while adding the canonical event cursor", () => {
    expect(legacySurvivedMigration).toBe(true);
  });

  it("atomically creates and idempotently replays the first durable Message and Run", async () => {
    const command = {
      idempotencyKey: "send-1",
      clientConversationId: "conversation_client_1",
      clientMessageId: "message_client_1",
      content: "Hello durable Chat",
      engine: "opencompany" as const,
      model: "provider/model",
    };

    const first = await service.createMessage(actor(), command);
    const replay = await service.createMessage(actor(), command);

    expect(first).toMatchObject({
      conversationId: "conversation_client_1",
      messageId: "message_client_1",
      idempotentReplay: false,
    });
    expect(replay).toEqual({ ...first, idempotentReplay: true });
    expect(
      (
        await database.query<{ count: number }>(`
        SELECT COUNT(*)::int AS count FROM goat.codex_chat_turns
      `)
      ).rows,
    ).toEqual([{ count: 1 }]);
    expect(
      await database.query<{ sequence: number; type: string }>(`
        SELECT sequence, type FROM goat.run_events ORDER BY sequence
      `),
    ).toMatchObject({ rows: [{ sequence: 1, type: "run.queued" }] });

    await expect(
      service.createMessage(actor(), { ...command, content: "A different command" }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("replays an attachment command without resolving the upload again", async () => {
    const uploads = new PostgresChatAttachmentRepository(
      execute,
      () => new Date("2026-08-10T20:00:00.000Z"),
    );
    await expect(
      uploads.create({
        actor: actor(),
        id: "attachment_1",
        format: "pdf",
        mediaType: "application/pdf",
        filename: "launch-plan.pdf",
        sizeBytes: 2048,
        blobPathname: "goat-chat/user_1/launch-plan.pdf",
        blobUrl: "https://blob.invalid/launch-plan.pdf",
        extractedText: "Private extracted launch context",
        expiresAt: new Date("2026-08-11T20:00:00.000Z"),
      }),
    ).resolves.toMatchObject({ id: "attachment_1", format: "pdf" });
    let resolutionCount = 0;
    const attachmentRepository = new PostgresChatRepository(execute, {
      ids: deterministicIds(),
      now: () => new Date("2026-08-10T20:00:00.000Z"),
      resolveAttachments: async (input) => {
        resolutionCount += 1;
        return uploads.resolve(input);
      },
    });
    const attachmentService = new ChatApplicationService(attachmentRepository);
    const command = {
      idempotencyKey: "send-attachment",
      content: "Review this",
      engine: "opencompany" as const,
      model: "provider/model",
      attachmentIds: ["attachment_1"],
    };

    const first = await attachmentService.createMessage(actor(), command);
    await expect(attachmentService.createMessage(actor(), command)).resolves.toEqual({
      ...first,
      idempotentReplay: true,
    });
    expect(resolutionCount).toBe(1);

    const page = await attachmentService.listMessages(actor(), {
      conversationId: first.conversationId,
    });
    expect(page.messages[0]?.attachments).toEqual([
      {
        id: "attachment_1",
        kind: "document",
        mediaType: "application/pdf",
        filename: "launch-plan.pdf",
        sizeBytes: 2048,
      },
    ]);
    expect(JSON.stringify(page)).not.toMatch(/blobPathname|blobUrl/u);
    expect(
      (
        await database.query<{ claimed_message_id: string; claimed_at: Date }>(`
          SELECT claimed_message_id, claimed_at
          FROM goat.chat_attachment_uploads
          WHERE id = 'attachment_1'
        `)
      ).rows,
    ).toMatchObject([{ claimed_message_id: first.messageId, claimed_at: expect.any(Date) }]);

    await expect(
      attachmentService.createMessage(actor(), {
        ...command,
        idempotencyKey: "reuse-attachment",
      }),
    ).rejects.toMatchObject({ code: "invalid_argument" });

    await expect(
      attachmentService.createMessage(actor({ workspaceId: "workspace_2" }), {
        ...command,
        idempotencyKey: "unauthorized-attachment",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(resolutionCount).toBe(2);
  });

  it("pins a legacy owner-only conversation to the actor workspace without changing its model", async () => {
    await database.exec(`
      INSERT INTO goat.chat_sessions (
        id, user_workos_id, title, model, engine, kind, created_at, updated_at
      ) VALUES (
        'legacy_conversation', 'user_1', 'Legacy', 'provider/original', 'opencompany', 'chat',
        '2026-08-10T19:00:00Z', '2026-08-10T19:00:00Z'
      );
      INSERT INTO goat.codex_chat_sessions (
        id, user_workos_id, chat_session_id, engine, model, workspace_id
      ) VALUES (
        'legacy_runtime', 'user_1', 'legacy_conversation', 'opencompany',
        'provider/original', NULL
      );
    `);

    await expect(service.getConversation(actor(), "legacy_conversation")).resolves.toMatchObject({
      id: "legacy_conversation",
    });

    await service.createMessage(actor(), {
      idempotencyKey: "send-legacy",
      conversationId: "legacy_conversation",
      content: "Continue",
      engine: "opencompany",
      model: "provider/requested-but-not-applied",
    });

    expect(
      await database.query<{ workspace_id: string; model: string }>(`
        SELECT workspace_id, model
        FROM goat.codex_chat_sessions
        WHERE chat_session_id = 'legacy_conversation'
      `),
    ).toMatchObject({ rows: [{ workspace_id: "workspace_1", model: "provider/original" }] });
    expect(
      await database.query<{ model: string }>(`
        SELECT model FROM goat.chat_sessions WHERE id = 'legacy_conversation'
      `),
    ).toMatchObject({ rows: [{ model: "provider/original" }] });
  });

  it("enforces actor tenancy on reads and writes", async () => {
    const created = await service.createMessage(actor(), {
      idempotencyKey: "send-private",
      content: "Private",
      engine: "opencompany",
      model: "provider/model",
    });

    await expect(
      service.getRun(actor({ userId: "user_2", workspaceId: "workspace_2" }), created.runId),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      service.createMessage(actor({ userId: "user_2", workspaceId: "workspace_2" }), {
        idempotencyKey: "cross-tenant",
        conversationId: created.conversationId,
        content: "Intrude",
        engine: "opencompany",
        model: "provider/model",
      }),
    ).rejects.toBeInstanceOf(CoreError);
  });

  it("pages authorized Messages without exposing their private storage metadata", async () => {
    const created = await service.createMessage(actor(), {
      idempotencyKey: "send-messages",
      content: "Page these Messages",
      engine: "opencompany",
      model: "provider/model",
    });

    const first = await service.listMessages(actor(), {
      conversationId: created.conversationId,
      limit: 1,
    });
    expect(first.messages).toHaveLength(1);
    expect(first.nextCursor).toEqual(expect.any(String));
    if (!first.nextCursor) throw new Error("Expected a Message page cursor.");

    const second = await service.listMessages(actor(), {
      conversationId: created.conversationId,
      cursor: first.nextCursor,
      limit: 1,
    });
    expect(second.messages).toHaveLength(1);
    expect(second.messages[0]?.id).not.toBe(first.messages[0]?.id);
    expect(second.nextCursor).toBeNull();

    await expect(
      service.listMessages(actor({ userId: "user_2", workspaceId: "workspace_2" }), {
        conversationId: created.conversationId,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("resolves durable approvals once and appends their semantic event", async () => {
    const created = await service.createMessage(actor(), {
      idempotencyKey: "send-approval",
      content: "Use the customer system",
      engine: "opencompany",
      model: "provider/model",
    });
    await database.query(
      `INSERT INTO goat.run_approvals (id, run_id, kind, prompt, options)
       VALUES ('approval_1', $1, 'tool', 'Allow the customer lookup?', '["Approve", "Deny"]')`,
      [created.runId],
    );

    const command = {
      runId: created.runId,
      approvalId: "approval_1",
      resolution: "answered" as const,
      answer: "Use the read-only lookup.",
    };
    await expect(service.resolveApproval(actor(), command)).resolves.toMatchObject({
      idempotentReplay: false,
      resolution: "answered",
    });
    await expect(service.resolveApproval(actor(), command)).resolves.toMatchObject({
      idempotentReplay: true,
    });
    await expect(
      service.resolveApproval(actor(), {
        runId: command.runId,
        approvalId: command.approvalId,
        resolution: "denied",
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      service.resolveApproval(actor(), { ...command, answer: "Use the mutating lookup." }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(
      (
        await database.query<{ status: string; resolution: string }>(`
          SELECT status, resolution FROM goat.run_approvals WHERE id = 'approval_1'
        `)
      ).rows,
    ).toEqual([{ status: "resolved", resolution: "answered" }]);
    expect(
      (
        await database.query<{ sequence: number; type: string }>(
          "SELECT sequence, type FROM goat.run_events WHERE run_id = $1 ORDER BY sequence",
          [created.runId],
        )
      ).rows,
    ).toEqual([
      { sequence: 1, type: "run.queued" },
      { sequence: 2, type: "approval.resolved" },
    ]);
  });

  it("fences Attempts and allocates semantic event cursors monotonically per Run", async () => {
    const created = await service.createMessage(actor(), {
      idempotencyKey: "send-worker",
      content: "Run this",
      engine: "opencompany",
      model: "provider/model",
    });
    await database.query(
      `UPDATE goat.codex_chat_turns
       SET status = 'running', attempts = 1, lease_id = $1, lease_owner = $2
       WHERE id = $3`,
      ["lease_1", "worker_1", created.runId],
    );
    expect(
      (
        await database.query<{ status: string; attempts: number; lease_id: string }>(
          `SELECT status, attempts, lease_id FROM goat.codex_chat_turns WHERE id = $1`,
          [created.runId],
        )
      ).rows,
    ).toEqual([{ status: "running", attempts: 1, lease_id: "lease_1" }]);
    const execution = new PostgresRunExecutionRepository(
      execute,
      () => new Date("2026-08-10T20:01:00.000Z"),
    );

    await expect(
      execution.startAttempt({
        worker: { workerId: "worker_1" },
        runId: created.runId,
        attemptId: "attempt_1",
        leaseId: "lease_1",
      }),
    ).resolves.toMatchObject({ number: 1, status: "running" });
    const events = await execution.appendEvents({
      worker: { workerId: "worker_1" },
      runId: created.runId,
      attemptId: "attempt_1",
      leaseId: "lease_1",
      events: [
        { id: "event_started", type: "run.started", payload: { attemptNumber: 1 } },
        {
          id: "event_content",
          type: "message.content_updated",
          payload: { messageId: "assistant_1", content: "Done", complete: true },
        },
      ],
    });
    expect(events.map((event) => event.sequence)).toEqual([2, 3]);
    await expect(
      execution.appendEvents({
        worker: { workerId: "other_worker" },
        runId: created.runId,
        attemptId: "attempt_1",
        leaseId: "wrong_lease",
        events: [{ id: "event_wrong", type: "run.failed", payload: {} }],
      }),
    ).resolves.toEqual([]);
    await expect(
      execution.finishAttempt({
        worker: { workerId: "worker_1" },
        runId: created.runId,
        attemptId: "attempt_1",
        leaseId: "lease_1",
        status: "completed",
      }),
    ).resolves.toMatchObject({ status: "completed" });

    await expect(service.listRunEvents(actor(), { runId: created.runId })).resolves.toMatchObject({
      nextSequence: 3,
    });
  });

  it("projects queued cancellation to the assistant, runtime, and semantic log", async () => {
    const created = await service.createMessage(actor(), {
      idempotencyKey: "send-cancel",
      content: "Cancel this",
      engine: "opencompany",
      model: "provider/model",
    });

    await expect(service.cancelRun(actor(), created.runId)).resolves.toMatchObject({
      status: "canceled",
      idempotentReplay: false,
    });
    await expect(service.cancelRun(actor(), created.runId)).resolves.toMatchObject({
      status: "canceled",
      idempotentReplay: true,
    });

    const projection = await database.query<{
      run_status: string;
      runtime_status: string;
      active_turn_id: string | null;
      aborted: boolean;
    }>(`
      SELECT
        run.status AS run_status,
        runtime.status AS runtime_status,
        runtime.active_turn_id,
        (message.debug_trace->>'aborted')::boolean AS aborted
      FROM goat.codex_chat_turns AS run
      JOIN goat.codex_chat_sessions AS runtime ON runtime.id = run.codex_chat_session_id
      JOIN goat.chat_messages AS message ON message.id = run.assistant_message_id
      WHERE run.id = '${created.runId}'
    `);
    expect(projection.rows).toEqual([
      {
        run_status: "interrupted",
        runtime_status: "interrupted",
        active_turn_id: null,
        aborted: true,
      },
    ]);
    expect(
      (
        await database.query<{ type: string }>(`
          SELECT type FROM goat.run_events WHERE run_id = '${created.runId}' ORDER BY sequence
        `)
      ).rows,
    ).toEqual([{ type: "run.queued" }, { type: "run.canceled" }]);
  });
});

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    userId: "user_1",
    workspaceId: "workspace_1",
    role: "admin",
    permissions: [CHAT_READ_PERMISSION, CHAT_WRITE_PERMISSION],
    authenticationMethod: "session",
    ...overrides,
  };
}

function deterministicIds(): ChatRepositoryIdFactory {
  let sequence = 0;
  const next = (kind: string) => `${kind}_${++sequence}`;
  return {
    command: () => next("command"),
    conversation: () => next("conversation"),
    message: () => next("message"),
    runtime: () => next("runtime"),
    run: () => next("run"),
    event: () => next("event"),
  };
}

const BASE_SCHEMA = `
  CREATE SCHEMA goat;
  CREATE TABLE goat.users (workos_user_id text PRIMARY KEY);
  CREATE TABLE goat.workspaces (id text PRIMARY KEY);
  CREATE TABLE goat.workspace_members (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    user_workos_id text NOT NULL,
    role text NOT NULL
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
