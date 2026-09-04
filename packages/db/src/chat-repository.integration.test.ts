import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { CHAT_HOST_TOOL_CONTRACT_VERSION } from "@opencompany/agent-runtime";
import {
  type Actor,
  CHAT_READ_PERMISSION,
  CHAT_WRITE_PERMISSION,
  ChatApplicationService,
  CoreError,
} from "@opencompany/core";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ChatRepositoryIdFactory,
  PostgresChatAttachmentRepository,
  PostgresChatRepository,
  PostgresRunExecutionRepository,
} from "./chat-repository";
import { loadChatSessionPluginRuntime } from "./plugin-runtime-repository";
import { listChatSkillBundleActivations, readChatSkillBundleFile } from "./skill-bundle-repository";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const migrationPaths = [
  "0198_goat_headless_chat_foundation.sql",
  "0199_goat_chat_attachment_uploads.sql",
  "0200_goat_chat_run_pausing.sql",
  "0201_goat_chat_read_models_v1.sql",
  "0214_goat_chat_attachment_texts_invariant.sql",
  "0215_goat_chat_sidebar_state.sql",
  "0216_goat_conversation_runtime_summary.sql",
  "0219_goat_run_attempt_deploy_version.sql",
  "0223_goat_task_projection_preservation.sql",
  "0226_goat_immutable_skill_bundles.sql",
  "0227_goat_chat_skill_bundle_snapshots.sql",
  "0228_goat_plugins.sql",
  "0229_goat_chat_skill_bundle_names.sql",
  "0235_goat_chat_message_shape_epochs.sql",
  "0236_goat_chat_message_presentation_summaries.sql",
  "0245_goat_task_activities.sql",
  "0247_preserve_assistant_message_boundaries.sql",
  "0248_goat_chat_attachment_upload_idempotency.sql",
].map((filename) => path.join(repositoryRoot, "drizzle", filename));
const dialect = new PgDialect();

describe("Postgres Chat repositories", () => {
  let database: PGlite;
  let repository: PostgresChatRepository;
  let service: ChatApplicationService;
  let execute: (query: SQL) => Promise<unknown>;
  let legacySurvivedMigration: boolean;
  let legacyRuntimeSurvivedMigration: boolean;
  let legacyAttachmentSurvivedMigration: boolean;

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
      if (migrationPath.endsWith("0248_goat_chat_attachment_upload_idempotency.sql")) {
        await database.exec(`
          INSERT INTO goat.chat_attachment_uploads (
            id, user_workos_id, workspace_id, format, media_type, filename, size_bytes,
            blob_pathname, blob_url, expires_at
          ) VALUES (
            'migration_attachment', 'migration_user', 'migration_workspace', 'text',
            'text/plain', 'preserve.txt', 8, 'migration/preserve',
            'https://blob.invalid/preserve', now() + interval '1 day'
          )
        `);
      }
      const migration = await readFile(migrationPath, "utf8");
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) await database.exec(statement);
      }
    }
    const migrated = await database.query<{ id: string; event_sequence: number }>(`
      SELECT id, event_sequence FROM goat.codex_chat_turns WHERE id = 'migration_run'
    `);
    const migratedProjection = await database.query<{ id: string; content: string }>(`
      SELECT id, content FROM goat.message_read_model_v1 WHERE id = 'migration_message'
    `);
    const migratedConversationProjection = await database.query<{
      runtime_status: string | null;
      active_run_id: string | null;
      runtime_has_error: boolean | null;
    }>(`
      SELECT runtime_status, active_run_id, runtime_has_error
      FROM goat.conversation_read_model_v1
      WHERE id = 'migration_conversation'
    `);
    legacySurvivedMigration =
      migrated.rows[0]?.id === "migration_run" &&
      migrated.rows[0].event_sequence === 0 &&
      migratedProjection.rows[0]?.content === "Preserve me";
    legacyRuntimeSurvivedMigration =
      migratedConversationProjection.rows[0]?.runtime_status === "queued" &&
      migratedConversationProjection.rows[0]?.active_run_id === null &&
      migratedConversationProjection.rows[0]?.runtime_has_error === false;
    legacyAttachmentSurvivedMigration =
      (
        await database.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM goat.chat_attachment_uploads WHERE id = 'migration_attachment'",
        )
      ).rows[0]?.count === 1;
    await database.exec(`
      DELETE FROM goat.codex_chat_turns;
      DELETE FROM goat.codex_chat_sessions;
      DELETE FROM goat.chat_messages;
      DELETE FROM goat.chat_sessions;
      DELETE FROM goat.users;
      DELETE FROM goat.workspaces;
    `);
    await database.exec(`
      INSERT INTO goat.users (workos_user_id) VALUES ('user_1'), ('user_2'), ('user_3');
      INSERT INTO goat.workspaces (id) VALUES ('workspace_1'), ('workspace_2');
      INSERT INTO goat.workspace_members (id, workspace_id, user_workos_id, role)
      VALUES
        ('member_1', 'workspace_1', 'user_1', 'admin'),
        ('member_2', 'workspace_2', 'user_2', 'admin'),
        ('member_3', 'workspace_1', 'user_3', 'member');
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
    expect(legacyRuntimeSurvivedMigration).toBe(true);
    expect(legacyAttachmentSurvivedMigration).toBe(true);
  });

  it("scopes attachment upload keys to actor and workspace and completes atomically", async () => {
    await database.exec(`
      INSERT INTO goat.workspace_members (id, workspace_id, user_workos_id, role)
      VALUES ('member_4', 'workspace_2', 'user_1', 'admin')
    `);
    const uploads = new PostgresChatAttachmentRepository(
      execute,
      () => new Date("2026-08-10T20:00:00.000Z"),
    );
    const expiresAt = new Date("2026-08-11T20:00:00.000Z");
    const requestHash = "a".repeat(64);
    const first = await uploads.reserve({
      actor: actor(),
      commandId: "attachment_command_1",
      idempotencyKey: "same-key",
      requestHash,
      attachmentId: "attachment_keyed_1",
      blobPathname: "goat-chat-v1/user_1/attachment_keyed_1/content",
      expiresAt,
    });
    const otherWorkspace = await uploads.reserve({
      actor: actor({ workspaceId: "workspace_2" }),
      commandId: "attachment_command_2",
      idempotencyKey: "same-key",
      requestHash,
      attachmentId: "attachment_keyed_2",
      blobPathname: "goat-chat-v1/user_1/attachment_keyed_2/content",
      expiresAt,
    });
    expect(first?.commandId).toBe("attachment_command_1");
    expect(otherWorkspace?.commandId).toBe("attachment_command_2");

    await expect(
      uploads.complete({
        commandId: "attachment_command_1",
        format: "text",
        mediaType: "text/plain",
        filename: "notes.txt",
        sizeBytes: 5,
        blobUrl: "https://blob.invalid/keyed-1",
        extractedText: "notes",
      }),
    ).resolves.toMatchObject({ id: "attachment_keyed_1", created: true });
    expect(
      (
        await database.query<{ completed_at: Date; upload_count: number }>(`
          SELECT command.completed_at,
                 count(upload.id)::int AS upload_count
          FROM goat.chat_attachment_upload_commands AS command
          LEFT JOIN goat.chat_attachment_uploads AS upload ON upload.id = command.attachment_id
          WHERE command.command_id = 'attachment_command_1'
          GROUP BY command.completed_at
        `)
      ).rows,
    ).toMatchObject([{ completed_at: expect.any(Date), upload_count: 1 }]);

    await database.exec(`
      DELETE FROM goat.chat_attachment_uploads WHERE id = 'attachment_keyed_1';
      UPDATE goat.chat_attachment_upload_commands
      SET cleaned_at = '2026-08-12T00:00:00Z'
      WHERE command_id = 'attachment_command_1';
    `);
    await expect(
      uploads.reserve({
        actor: actor(),
        commandId: "replacement_command",
        idempotencyKey: "same-key",
        requestHash,
        attachmentId: "replacement_attachment",
        blobPathname: "goat-chat-v1/user_1/replacement_attachment/content",
        expiresAt: new Date("2026-08-13T20:00:00.000Z"),
      }),
    ).resolves.toMatchObject({
      commandId: "attachment_command_1",
      attachmentId: "attachment_keyed_1",
      cleanedAt: expect.any(Date),
      expiresAt,
    });
  });

  it("terminalizes a keyed upload command when its attachment is claimed", async () => {
    const timestamp = new Date("2026-08-10T20:00:00.000Z");
    const uploads = new PostgresChatAttachmentRepository(execute, () => timestamp);
    const reservation = await uploads.reserve({
      actor: actor(),
      commandId: "attachment_command_claimed",
      idempotencyKey: "claimed-upload-key",
      requestHash: "b".repeat(64),
      attachmentId: "attachment_claimed",
      blobPathname: "goat-chat-v1/user_1/attachment_claimed/content",
      expiresAt: new Date("2026-08-11T20:00:00.000Z"),
    });
    expect(reservation).not.toBeNull();
    await expect(
      uploads.complete({
        commandId: "attachment_command_claimed",
        format: "text",
        mediaType: "text/plain",
        filename: "claimed.txt",
        sizeBytes: 7,
        blobUrl: "https://blob.invalid/claimed",
        extractedText: "claimed",
      }),
    ).resolves.toMatchObject({ id: "attachment_claimed", created: true });
    const messages = new ChatApplicationService(
      new PostgresChatRepository(execute, {
        ids: deterministicIds(),
        now: () => timestamp,
        resolveAttachments: (input) => uploads.resolve(input),
      }),
    );

    const created = await messages.createMessage(actor(), {
      idempotencyKey: "claim-keyed-attachment",
      content: "Use the keyed upload",
      engine: "opencompany",
      model: "provider/model",
      attachmentIds: ["attachment_claimed"],
    });

    await expect(
      database.query<{
        claimed_message_id: string;
        upload_claimed_at: Date;
        command_claimed_at: Date;
        cleaned_at: Date;
      }>(`
        SELECT
          upload.claimed_message_id,
          upload.claimed_at AS upload_claimed_at,
          command.claimed_at AS command_claimed_at,
          command.cleaned_at
        FROM goat.chat_attachment_uploads AS upload
        JOIN goat.chat_attachment_upload_commands AS command
          ON command.attachment_id = upload.id
        WHERE upload.id = 'attachment_claimed'
      `),
    ).resolves.toMatchObject({
      rows: [
        {
          claimed_message_id: created.messageId,
          upload_claimed_at: timestamp,
          command_claimed_at: timestamp,
          cleaned_at: timestamp,
        },
      ],
    });
  });

  it("accounts projected Message bytes and rotates the shape epoch only after a Run settles", async () => {
    const created = await service.createMessage(actor(), {
      idempotencyKey: "message-shape-epoch",
      content: "Grow the durable transcript.",
      engine: "opencompany",
      model: "provider/model",
    });
    await database.query(
      `UPDATE goat.codex_chat_turns
       SET status = 'running', updated_at = '2026-08-10T20:01:00Z'
       WHERE id = $1`,
      [created.runId],
    );
    await database.query(
      `UPDATE goat.conversation_read_model_v1
       SET message_shape_bytes_since_epoch = 16 * 1024 * 1024 - 1
       WHERE id = $1`,
      [created.conversationId],
    );
    await database.query(
      `UPDATE goat.chat_messages
       SET content = $2, updated_at = '2026-08-10T20:02:00Z'
       WHERE id = $1`,
      [created.assistantMessageId, "x".repeat(1_024)],
    );

    await expect(
      database.query<{ message_shape_epoch: number; message_shape_bytes_since_epoch: number }>(
        `SELECT message_shape_epoch, message_shape_bytes_since_epoch
         FROM goat.conversation_read_model_v1
         WHERE id = $1`,
        [created.conversationId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          message_shape_epoch: 0,
          message_shape_bytes_since_epoch: expect.any(Number),
        },
      ],
    });

    await database.query(
      `UPDATE goat.codex_chat_turns
       SET status = 'completed', completed_at = '2026-08-10T20:03:00Z',
           updated_at = '2026-08-10T20:03:00Z'
       WHERE id = $1`,
      [created.runId],
    );
    expect(
      (
        await database.query<{
          message_shape_epoch: number;
          message_shape_bytes_since_epoch: number;
        }>(
          `SELECT message_shape_epoch, message_shape_bytes_since_epoch
           FROM goat.conversation_read_model_v1
           WHERE id = $1`,
          [created.conversationId],
        )
      ).rows,
    ).toEqual([{ message_shape_epoch: 1, message_shape_bytes_since_epoch: 0 }]);
  });

  it("projects bounded presentation summaries while retaining full lazy-load detail", async () => {
    const created = await service.createMessage(actor(), {
      idempotencyKey: "presentation-summary",
      content: "Measure the historical trace.",
      engine: "codex",
      model: "provider/model",
    });
    const longReasoning = "reasoning ".repeat(800);
    const longToolOutput = "provider detail ".repeat(400);
    const toolParts = Array.from({ length: 200 }, (_, index) => ({
      type: "dynamic-tool",
      toolName: "history_search",
      toolCallId: `tool_${index + 1}`,
      state: "output-available",
      input: { query: `launch-${index + 1}` },
      output: { detail: longToolOutput },
    }));
    await database.query(
      `UPDATE goat.chat_messages
       SET content = 'Trace complete', debug_trace = $2::jsonb,
           updated_at = '2026-08-10T20:02:00Z'
       WHERE id = $1`,
      [
        created.assistantMessageId,
        JSON.stringify({
          schemaVersion: "goat.codex_chat.debug.v1",
          model: "provider/model",
          uiMessageParts: [
            { type: "reasoning", text: longReasoning, state: "done" },
            ...toolParts,
            { type: "text", text: "Trace complete", itemId: "assistant_final" },
          ],
        }),
      ],
    );

    const projection = await database.query<{
      presentation: { uiMessageParts: Array<Record<string, unknown>> };
      presentation_summary: { uiMessageParts: Array<Record<string, unknown>> };
      presentation_bytes: number;
      summary_bytes: number;
    }>(
      `SELECT presentation, presentation_summary,
              octet_length(presentation::text)::int AS presentation_bytes,
              octet_length(presentation_summary::text)::int AS summary_bytes
       FROM goat.message_read_model_v1
       WHERE id = $1`,
      [created.assistantMessageId],
    );
    const row = projection.rows[0]!;
    const summaryReasoning = row.presentation_summary.uiMessageParts[0]!;
    const summaryTool = row.presentation_summary.uiMessageParts[1]!;
    const fullTool = row.presentation.uiMessageParts[1]!;

    expect(String(summaryReasoning.text)).toHaveLength(160);
    expect(String(summaryReasoning.text)).toMatch(/\.\.\.$/u);
    expect(summaryReasoning.presentationSummary).toBe(true);
    expect(row.presentation_summary.uiMessageParts.at(-1)).toMatchObject({
      type: "text",
      text: "Trace complete",
      itemId: "assistant_final",
    });
    expect(summaryTool).toMatchObject({
      type: "dynamic-tool",
      toolName: "history_search",
      toolCallId: "tool_1",
      state: "output-available",
      presentationSummary: true,
      input: { query: "launch-1" },
    });
    expect(String((summaryTool.output as { detail: string }).detail)).toHaveLength(160);
    expect(String((fullTool.output as { detail: string }).detail).length).toBeGreaterThan(5_000);
    expect(
      row.presentation_summary.uiMessageParts.filter((part) => part.type === "dynamic-tool"),
    ).toHaveLength(200);
    expect(row.summary_bytes * 10).toBeLessThan(row.presentation_bytes);
  });

  it.each(["opencompany", "codex", "claude_code"] as const)(
    "returns and atomically refreshes the %s runtime summary without exposing raw errors",
    async (engine) => {
      const created = await service.createMessage(actor(), {
        idempotencyKey: `runtime-${engine}`,
        content: `Exercise the ${engine} runtime.`,
        engine,
        model: "provider/model",
      });

      const initial = await service.getConversation(actor(), created.conversationId);
      expect(initial.runtime).toMatchObject({
        status: "queued",
        activeRunId: created.runId,
        hasError: false,
      });
      await expect(service.listConversations(actor())).resolves.toMatchObject({
        conversations: [{ runtime: initial.runtime }],
      });

      await database.query(
        `UPDATE goat.codex_chat_sessions
         SET status = 'running', active_turn_id = $2, updated_at = $3
         WHERE chat_session_id = $1`,
        [created.conversationId, created.runId, "2026-08-10T20:01:00.000Z"],
      );
      await expect(service.getConversation(actor(), created.conversationId)).resolves.toMatchObject(
        {
          activityState: "working",
          runtime: {
            status: "running",
            activeRunId: created.runId,
            hasError: false,
            updatedAt: new Date("2026-08-10T20:01:00.000Z"),
          },
        },
      );

      const rawError = "provider-private failure detail";
      await database.query(
        `UPDATE goat.codex_chat_sessions
         SET status = 'failed', active_turn_id = NULL, error = $2, updated_at = $3
         WHERE chat_session_id = $1`,
        [created.conversationId, rawError, "2026-08-10T20:02:00.000Z"],
      );
      const failed = await service.getConversation(actor(), created.conversationId);
      expect(failed).toMatchObject({
        activityState: "idle",
        runtime: {
          status: "failed",
          activeRunId: null,
          hasError: true,
          updatedAt: new Date("2026-08-10T20:02:00.000Z"),
        },
      });
      expect(JSON.stringify(failed)).not.toContain(rawError);
    },
  );

  it("normalizes JSON null attachment text and rejects non-object JSON at the database boundary", async () => {
    const created = await service.createMessage(actor(), {
      idempotencyKey: "attachment-text-invariant",
      content: "Check the invariant",
      engine: "opencompany",
      model: "provider/model",
    });

    await database.query(
      `UPDATE goat.chat_messages SET attachment_texts = 'null'::jsonb WHERE id = $1`,
      [created.messageId],
    );
    await expect(
      database.query<{ is_sql_null: boolean }>(
        `SELECT attachment_texts IS NULL AS is_sql_null FROM goat.chat_messages WHERE id = $1`,
        [created.messageId],
      ),
    ).resolves.toMatchObject({ rows: [{ is_sql_null: true }] });
    await expect(
      database.query(`UPDATE goat.chat_messages SET attachment_texts = '[]'::jsonb WHERE id = $1`, [
        created.messageId,
      ]),
    ).rejects.toThrow(/chat_messages_attachment_texts_object_check/u);
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
      assistantMessageId: expect.any(String),
      idempotentReplay: false,
    });
    expect(replay).toEqual({ ...first, idempotentReplay: true });
    await expect(service.getConversation(actor(), first.conversationId)).resolves.toMatchObject({
      activityState: "working",
      hasUnseen: false,
    });
    expect(
      (
        await database.query<{ count: number }>(`
        SELECT COUNT(*)::int AS count FROM goat.codex_chat_turns
      `)
      ).rows,
    ).toEqual([{ count: 1 }]);
    expect(
      await database.query<{ host_tool_contract_version: string }>(`
        SELECT host_tool_contract_version FROM goat.codex_chat_sessions
      `),
    ).toMatchObject({
      rows: [{ host_tool_contract_version: CHAT_HOST_TOOL_CONTRACT_VERSION }],
    });
    expect(
      await database.query<{ attachment_texts_is_sql_null: boolean }>(
        `SELECT attachment_texts IS NULL AS attachment_texts_is_sql_null
         FROM goat.chat_messages
         WHERE id = $1`,
        [first.messageId],
      ),
    ).toMatchObject({ rows: [{ attachment_texts_is_sql_null: true }] });
    expect(
      (
        await database.query<{
          sequence: number;
          type: string;
          payload: Record<string, unknown>;
        }>(`
        SELECT sequence, type, payload FROM goat.run_events ORDER BY sequence
      `)
      ).rows,
    ).toEqual([
      {
        sequence: 1,
        type: "run.queued",
        payload: {
          conversationId: first.conversationId,
          triggerMessageId: first.messageId,
        },
      },
    ]);
    await database.query(
      `UPDATE goat.run_events
       SET payload = payload || '{"taskId": null}'::jsonb
       WHERE run_id = $1 AND type = 'run.queued'`,
      [first.runId],
    );
    const historicalEvents = await service.listRunEvents(actor(), { runId: first.runId });
    expect(historicalEvents.events).toHaveLength(1);
    expect(historicalEvents.events[0]?.payload).toEqual({
      conversationId: first.conversationId,
      triggerMessageId: first.messageId,
    });
    expect(
      await database.query<{ status: string; conversation_id: string }>(`
        SELECT status, conversation_id FROM goat.run_read_model_v1
      `),
    ).toMatchObject({
      rows: [{ status: "queued", conversation_id: first.conversationId }],
    });
    expect(
      await database.query<{ conversation_id: string; presentation: unknown }>(
        `
        SELECT conversation_id, presentation
        FROM goat.message_read_model_v1
        WHERE id = $1
      `,
        [first.assistantMessageId],
      ),
    ).toMatchObject({
      rows: [
        {
          conversation_id: first.conversationId,
          presentation: { schemaVersion: "opencompany.chat.debug.v1" },
        },
      ],
    });

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
    expect(
      (
        await database.query<{ count: number }>(`
          SELECT COUNT(*)::int AS count
          FROM goat.chat_command_idempotency
          WHERE idempotency_key = 'reuse-attachment'
        `)
      ).rows,
    ).toEqual([{ count: 0 }]);
    expect(
      (
        await database.query<{ count: number }>(`
          SELECT COUNT(*)::int AS count FROM goat.chat_sessions
        `)
      ).rows,
    ).toEqual([{ count: 1 }]);

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

  it("updates canonical Conversation state and safely archives an active queued Run", async () => {
    const created = await service.createMessage(actor(), {
      idempotencyKey: "send-before-conversation-update",
      content: "Keep this durable",
      engine: "opencompany",
      model: "provider/model",
    });
    await database.query(
      `INSERT INTO goat.run_approvals (id, run_id, tool_call_id, kind, prompt, options)
       VALUES (
         'approval_before_archive', $1, 'tool_call_before_archive',
         'use_action', 'Approve?', '["approved","denied"]'
       )`,
      [created.runId],
    );
    await database.query(
      `INSERT INTO goat.capability_runs (
         id, workspace_id, user_workos_id, chat_session_id, tool_call_id, status,
         approval_expires_at
       ) VALUES (
         'capability_before_archive', 'workspace_1', 'user_1', $1,
         'tool_call_before_archive', 'awaiting_approval', '2026-08-10T20:15:00Z'
       )`,
      [created.conversationId],
    );
    await database.query("UPDATE goat.chat_sessions SET has_unseen = true WHERE id = $1", [
      created.conversationId,
    ]);

    const presented = await service.updateConversation(actor(), created.conversationId, {
      pinned: true,
      markSeen: true,
    });
    expect(presented).toEqual({
      conversationId: created.conversationId,
      transactionId: expect.stringMatching(/^[0-9]+$/u),
    });
    expect(
      (
        await database.query<{
          pinned_at: Date | null;
          last_seen_at: Date | null;
          has_unseen: boolean;
          archived_at: Date | null;
        }>(
          `SELECT pinned_at, last_seen_at, has_unseen, archived_at
           FROM goat.conversation_read_model_v1
           WHERE id = $1`,
          [created.conversationId],
        )
      ).rows,
    ).toEqual([
      {
        pinned_at: new Date("2026-08-10T20:00:00.000Z"),
        last_seen_at: new Date("2026-08-10T20:00:00.000Z"),
        has_unseen: false,
        archived_at: null,
      },
    ]);

    await expect(
      service.updateConversation(
        actor({ userId: "user_2", workspaceId: "workspace_2" }),
        created.conversationId,
        { archived: true },
      ),
    ).rejects.toMatchObject({ code: "not_found" });

    await expect(
      service.updateConversation(actor(), created.conversationId, { archived: true }),
    ).resolves.toMatchObject({ conversationId: created.conversationId });
    await expect(service.getConversation(actor(), created.conversationId)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      service.getConversation(actor(), created.conversationId, { includeArchived: true }),
    ).resolves.toMatchObject({ id: created.conversationId });
    await expect(
      service.getConversation(
        actor({ userId: "user_2", workspaceId: "workspace_2" }),
        created.conversationId,
        { includeArchived: true },
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      service.updateConversation(actor(), created.conversationId, { markSeen: true }),
    ).resolves.toMatchObject({ conversationId: created.conversationId });
    expect(
      (
        await database.query<{
          archived_at: Date | null;
          run_status: string;
          runtime_status: string;
          active_turn_id: string | null;
          approval_status: string;
          approval_resolution: string | null;
        }>(
          `SELECT
             projection.archived_at,
             run.status AS run_status,
             runtime.status AS runtime_status,
             runtime.active_turn_id,
             approval.status AS approval_status,
             approval.resolution AS approval_resolution
           FROM goat.conversation_read_model_v1 AS projection
           JOIN goat.codex_chat_turns AS run ON run.chat_session_id = projection.id
           JOIN goat.codex_chat_sessions AS runtime ON runtime.id = run.codex_chat_session_id
           JOIN goat.run_approvals AS approval ON approval.run_id = run.id
           WHERE projection.id = $1`,
          [created.conversationId],
        )
      ).rows,
    ).toEqual([
      {
        archived_at: new Date("2026-08-10T20:00:00.000Z"),
        run_status: "interrupted",
        runtime_status: "closed",
        active_turn_id: null,
        approval_status: "canceled",
        approval_resolution: "canceled",
      },
    ]);
    expect(
      (
        await database.query<{ type: string }>(
          "SELECT type FROM goat.run_events WHERE run_id = $1 ORDER BY sequence",
          [created.runId],
        )
      ).rows,
    ).toEqual([{ type: "run.queued" }, { type: "run.canceled" }]);
    expect(
      (
        await database.query<{ status: string }>(
          "SELECT status FROM goat.capability_runs WHERE id = 'capability_before_archive'",
        )
      ).rows,
    ).toEqual([{ status: "canceled" }]);

    await expect(
      service.updateConversation(actor(), created.conversationId, { archived: false }),
    ).resolves.toMatchObject({ conversationId: created.conversationId });
    expect(
      (
        await database.query<{ archived_at: Date | null }>(
          "SELECT archived_at FROM goat.conversation_read_model_v1 WHERE id = $1",
          [created.conversationId],
        )
      ).rows,
    ).toEqual([{ archived_at: null }]);
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
      `UPDATE goat.codex_chat_turns
       SET status = 'running', attempts = 1, lease_id = 'lease_approval',
           lease_owner = 'worker_approval'
       WHERE id = $1`,
      [created.runId],
    );
    await database.query(
      `UPDATE goat.chat_messages AS message
       SET debug_trace = jsonb_build_object(
         'schemaVersion', 'opencompany.chat.debug.v1',
         'uiMessageParts', jsonb_build_array(jsonb_build_object(
           'type', 'tool-use_action',
           'toolCallId', 'tool_call_1',
           'state', 'approval-requested',
           'input', jsonb_build_object('action', 'crm.lookup'),
           'approval', jsonb_build_object('id', 'approval_1')
         ))
       )
       FROM goat.codex_chat_turns AS run
       WHERE run.id = $1 AND message.id = run.assistant_message_id`,
      [created.runId],
    );
    const execution = new PostgresRunExecutionRepository(
      execute,
      () => new Date("2026-08-10T20:01:00.000Z"),
    );
    await execution.startAttempt({
      worker: { workerId: "worker_approval" },
      runId: created.runId,
      attemptId: "attempt_approval",
      leaseId: "lease_approval",
    });
    await expect(
      execution.pauseForApprovals({
        worker: { workerId: "worker_approval" },
        runId: created.runId,
        attemptId: "attempt_approval",
        leaseId: "lease_approval",
        approvals: [
          {
            id: "approval_1",
            toolCallId: "tool_call_1",
            kind: "use_action",
            prompt: "Approve crm.lookup?",
            options: ["approved", "denied"],
          },
        ],
      }),
    ).resolves.toMatchObject([{ id: "approval_1", status: "pending" }]);
    await expect(service.getConversation(actor(), created.conversationId)).resolves.toMatchObject({
      activityState: "idle",
      hasUnseen: true,
    });
    await database.query(
      `INSERT INTO goat.capability_runs (
         id, workspace_id, user_workos_id, chat_session_id, tool_call_id, status,
         approval_expires_at
       ) VALUES (
         'capability_1', 'workspace_1', 'user_1', $1, 'tool_call_1',
         'awaiting_approval', '2026-08-10T20:15:00Z'
       )`,
      [created.conversationId],
    );

    const command = {
      runId: created.runId,
      approvalId: "approval_1",
      resolution: "approved" as const,
    };
    await expect(service.resolveApproval(actor(), command)).resolves.toMatchObject({
      idempotentReplay: false,
      resolution: "approved",
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
    expect(
      (
        await database.query<{ status: string; resolution: string }>(`
          SELECT status, resolution FROM goat.run_approvals WHERE id = 'approval_1'
        `)
      ).rows,
    ).toEqual([{ status: "resolved", resolution: "approved" }]);
    expect(
      (
        await database.query<{ status: string; approved_at: Date | null }>(
          "SELECT status, approved_at FROM goat.capability_runs WHERE id = 'capability_1'",
        )
      ).rows,
    ).toEqual([
      {
        status: "approved",
        approved_at: new Date("2026-08-10T20:00:00.000Z"),
      },
    ]);
    expect(
      (
        await database.query<{ status: string; settings: Record<string, unknown> }>(
          "SELECT status, settings FROM goat.codex_chat_turns WHERE id = $1",
          [created.runId],
        )
      ).rows,
    ).toEqual([{ status: "queued", settings: { approvalContinuation: true } }]);
    const assistant = await database.query<{ debug_trace: { uiMessageParts: unknown[] } }>(
      `SELECT message.debug_trace
       FROM goat.chat_messages AS message
       JOIN goat.codex_chat_turns AS run ON run.assistant_message_id = message.id
       WHERE run.id = $1`,
      [created.runId],
    );
    expect(assistant.rows[0]?.debug_trace.uiMessageParts).toEqual([
      expect.objectContaining({
        state: "approval-responded",
        approval: { id: "approval_1", approved: true },
      }),
    ]);
    expect(
      (
        await database.query<{ sequence: number; type: string }>(
          "SELECT sequence, type FROM goat.run_events WHERE run_id = $1 ORDER BY sequence",
          [created.runId],
        )
      ).rows,
    ).toEqual([
      { sequence: 1, type: "run.queued" },
      { sequence: 2, type: "approval.requested" },
      { sequence: 3, type: "run.paused" },
      { sequence: 4, type: "approval.resolved" },
    ]);
  });

  it("resolves a gateway approval without pausing its running engine turn", async () => {
    const created = await service.createMessage(actor(), {
      idempotencyKey: "live-gateway-approval",
      content: "Send the customer update",
      engine: "codex",
      model: "provider/model",
    });
    await database.query(`UPDATE goat.codex_chat_turns SET status = 'running' WHERE id = $1`, [
      created.runId,
    ]);
    await database.query(
      `INSERT INTO goat.run_approvals (id, run_id, tool_call_id, kind, prompt, options)
       VALUES (
         'gateway_approval_1', $1, 'gateway_tool_call_1', 'use_action',
         'Approve gmail.send?', '["approved","denied"]'
       )`,
      [created.runId],
    );
    await database.query(
      `INSERT INTO goat.action_turns (
         id, session_id, turn_id, user_workos_id, workspace_id, policy,
         approval_records, expires_at
       ) VALUES (
         'action_turn_1', $1, $2, 'user_1', 'workspace_1', 'foregroundInteractive',
         jsonb_build_object(
           'gateway_tool_call_1',
           jsonb_build_object(
             'actionId', 'gmail.send',
             'sourceId', 'gmail',
             'capabilityId', 'write',
             'inputHash', repeat('a', 64),
             'status', 'pending',
             'requestedAt', '2026-08-10T19:59:00.000Z'
           )
         ),
         '2026-08-11T02:00:00Z'
       )`,
      [created.conversationId, created.runId],
    );

    const command = {
      runId: created.runId,
      approvalId: "gateway_approval_1",
      resolution: "approved" as const,
    };
    await expect(service.resolveApproval(actor(), command)).resolves.toMatchObject({
      resolution: "approved",
      idempotentReplay: false,
    });
    await expect(service.resolveApproval(actor(), command)).resolves.toMatchObject({
      idempotentReplay: true,
    });

    expect(
      await database.query<{
        status: string;
        approval_status: string;
        resolved_at: string;
      }>(
        `SELECT run.status,
                action.approval_records -> 'gateway_tool_call_1' ->> 'status' AS approval_status,
                action.approval_records -> 'gateway_tool_call_1' ->> 'resolvedAt' AS resolved_at
         FROM goat.codex_chat_turns AS run
         JOIN goat.action_turns AS action ON action.turn_id = run.id
         WHERE run.id = $1`,
        [created.runId],
      ),
    ).toMatchObject({
      rows: [
        {
          status: "running",
          approval_status: "approved",
          resolved_at: "2026-08-10T20:00:00.000Z",
        },
      ],
    });
    expect(
      await database.query<{ type: string; payload: Record<string, unknown> }>(
        `SELECT type, payload
         FROM goat.run_events
         WHERE run_id = $1 AND type = 'approval.resolved'`,
        [created.runId],
      ),
    ).toMatchObject({
      rows: [
        {
          type: "approval.resolved",
          payload: {
            approvalId: "gateway_approval_1",
            toolCallId: "gateway_tool_call_1",
            resolution: "approved",
          },
        },
      ],
    });
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
          payload: {
            messageId: "assistant_1",
            content: "Done\ud800\0",
            complete: true,
          },
        },
      ],
    });
    expect(events.map((event) => event.sequence)).toEqual([2, 3]);
    expect(events[1]?.payload).toMatchObject({ content: "Done��" });
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

  it("keeps first-turn Plugin snapshots fixed unless an explicit Skill activation extends them", async () => {
    await database.exec(`
      INSERT INTO goat.plugins (
        id, workspace_id, name, status, manifest, source_type, source_url, source_path,
        source_ref, resolved_commit, integrity, install_report
      ) VALUES
        (
          'plugin_first', 'workspace_1', 'first-plugin', 'enabled',
          '{"name":"first-plugin"}'::jsonb, 'github', 'https://github.com/example/plugins',
          'first-plugin', 'main', '${"a".repeat(40)}', 'sha256:${"b".repeat(64)}',
          '{"ignoredManifestFields":[],"skills":[],"mcp":{"status":"absent"},"collisions":[]}'::jsonb
        ),
        (
          'plugin_disabled', 'workspace_1', 'disabled-plugin', 'disabled',
          '{"name":"disabled-plugin"}'::jsonb, 'github', 'https://github.com/example/plugins',
          'disabled-plugin', 'main', '${"a".repeat(40)}', 'sha256:${"c".repeat(64)}',
          '{"ignoredManifestFields":[],"skills":[],"mcp":{"status":"absent"},"collisions":[]}'::jsonb
        );
      INSERT INTO goat.plugin_files (plugin_id, path, content, executable, size_bytes)
      VALUES ('plugin_first', 'plugin.json', convert_to('{}', 'UTF8'), false, 2);
    `);
    const first = await service.createMessage(actor(), {
      idempotencyKey: "plugin-snapshot-first",
      content: "Start coding.",
      engine: "codex",
      model: "provider/model",
    });

    await expect(
      database.query<{ plugin_id: string }>(
        "SELECT plugin_id FROM goat.chat_session_plugins WHERE chat_session_id = $1",
        [first.conversationId],
      ),
    ).resolves.toMatchObject({ rows: [{ plugin_id: "plugin_first" }] });

    await database.exec(`
      INSERT INTO goat.plugins (
        id, workspace_id, name, status, manifest, source_type, source_url, source_path,
        source_ref, resolved_commit, integrity, install_report
      ) VALUES (
        'plugin_late', 'workspace_1', 'late-plugin', 'enabled',
        '{"name":"late-plugin"}'::jsonb, 'github', 'https://github.com/example/plugins',
        'late-plugin', 'main', '${"a".repeat(40)}', 'sha256:${"d".repeat(64)}',
        '{"ignoredManifestFields":[],"skills":[],"mcp":{"status":"absent"},"collisions":[]}'::jsonb
      );
      INSERT INTO goat.skill_bundles (
        id, workspace_id, integrity, name, description, body,
        source_type, source_url, source_path, source_ref, resolved_commit
      ) VALUES (
        'skill_bundle_plugin_late', 'workspace_1',
        'sha256:${"1".repeat(64)}', 'late-review', 'Late Plugin Skill.', 'Use late review.',
        'github', 'https://github.com/example/plugins', 'late-plugin/skills/late-review',
        'main', '${"a".repeat(40)}'
      );
      INSERT INTO goat.skill_bundle_files (bundle_id, path, content, executable, size_bytes)
      VALUES ('skill_bundle_plugin_late', 'SKILL.md', ''::bytea, false, 0);
      INSERT INTO goat.plugin_skills (
        workspace_id, plugin_id, skill_name, skill_path, skill_bundle_id
      ) VALUES (
        'workspace_1', 'plugin_late', 'late-review',
        'skills/late-review', 'skill_bundle_plugin_late'
      );
      INSERT INTO goat.plugin_files (plugin_id, path, content, executable, size_bytes)
      VALUES ('plugin_late', 'plugin.json', convert_to('{}', 'UTF8'), false, 2);
      UPDATE goat.codex_chat_turns
      SET status = 'completed', completed_at = now()
      WHERE id = '${first.runId}';
      UPDATE goat.codex_chat_sessions
      SET status = 'idle', active_turn_id = NULL
      WHERE chat_session_id = '${first.conversationId}';
    `);
    const second = await service.createMessage(actor(), {
      idempotencyKey: "plugin-snapshot-second",
      conversationId: first.conversationId,
      content: "Continue coding.",
      engine: "codex",
      model: "provider/model",
    });

    await expect(
      database.query<{ plugin_id: string }>(
        "SELECT plugin_id FROM goat.chat_session_plugins WHERE chat_session_id = $1 ORDER BY plugin_id",
        [first.conversationId],
      ),
    ).resolves.toMatchObject({ rows: [{ plugin_id: "plugin_first" }] });

    await database.exec(`
      UPDATE goat.codex_chat_turns
      SET status = 'completed', completed_at = now()
      WHERE id = '${second.runId}';
      UPDATE goat.codex_chat_sessions
      SET status = 'idle', active_turn_id = NULL
      WHERE chat_session_id = '${first.conversationId}';
    `);
    await service.createMessage(actor(), {
      idempotencyKey: "plugin-snapshot-explicit-late-skill",
      conversationId: first.conversationId,
      content: "Use the late review skill.",
      engine: "codex",
      model: "provider/model",
      mentions: [{ kind: "skill", id: "late-review" }],
    });

    await expect(
      database.query<{ plugin_id: string }>(
        "SELECT plugin_id FROM goat.chat_session_plugins WHERE chat_session_id = $1 ORDER BY plugin_id",
        [first.conversationId],
      ),
    ).resolves.toMatchObject({
      rows: [{ plugin_id: "plugin_first" }, { plugin_id: "plugin_late" }],
    });
    await expect(
      loadChatSessionPluginRuntime(drizzle(database), {
        workspaceId: "workspace_1",
        chatSessionId: first.conversationId,
      }),
    ).resolves.toMatchObject({
      plugins: [{ id: "plugin_first" }, { id: "plugin_late" }],
      skills: [{ id: "skill_bundle_plugin_late", name: "late-review" }],
    });
  });

  it("activates a winning Plugin Skill with its immutable source kind", async () => {
    await database.exec(`
      INSERT INTO goat.plugins (
        id, workspace_id, name, status, manifest, source_type, source_url, source_path,
        source_ref, resolved_commit, integrity, install_report
      ) VALUES (
        'plugin_review', 'workspace_1', 'review-tools', 'enabled',
        '{"name":"review-tools"}'::jsonb, 'github', 'https://github.com/example/plugins',
        'review-tools', 'main', '${"a".repeat(40)}', 'sha256:${"e".repeat(64)}',
        '{"ignoredManifestFields":[],"skills":[],"mcp":{"status":"absent"},"collisions":[]}'::jsonb
      );
      INSERT INTO goat.skill_bundles (
        id, workspace_id, integrity, name, description, body,
        source_type, source_url, source_path, source_ref, resolved_commit
      ) VALUES (
        'skill_bundle_plugin_review', 'workspace_1',
        'sha256:${"f".repeat(64)}', 'review', 'Review from Plugin.', 'Use review.',
        'github', 'https://github.com/example/plugins', 'review-tools/skills/review',
        'main', '${"a".repeat(40)}'
      );
      INSERT INTO goat.skill_bundle_files (bundle_id, path, content, executable, size_bytes)
      VALUES ('skill_bundle_plugin_review', 'SKILL.md', ''::bytea, false, 0);
      INSERT INTO goat.plugin_skills (
        workspace_id, plugin_id, skill_name, skill_path, skill_bundle_id
      ) VALUES (
        'workspace_1', 'plugin_review', 'review', 'skills/review', 'skill_bundle_plugin_review'
      );
    `);

    const created = await service.createMessage(actor(), {
      idempotencyKey: "plugin-skill-activation",
      content: "Review this.",
      engine: "codex",
      model: "provider/model",
      mentions: [{ kind: "skill", id: "review" }],
    });

    await expect(
      database.query<{ bundle_id: string; name: string; source_kind: string }>(
        `SELECT bundle_id, name, source_kind
         FROM goat.chat_session_skill_bundles
         WHERE chat_session_id = $1`,
        [created.conversationId],
      ),
    ).resolves.toMatchObject({
      rows: [{ bundle_id: "skill_bundle_plugin_review", name: "review", source_kind: "plugin" }],
    });

    const db = drizzle(database);
    await expect(
      listChatSkillBundleActivations(db, {
        workspaceId: "workspace_1",
        chatSessionId: created.conversationId,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ bundleId: "skill_bundle_plugin_review", sourceKind: "plugin" }),
    ]);
    await database.exec(`
      INSERT INTO goat.skill_bundles (
        id, workspace_id, integrity, name, description, body,
        source_type, source_url, source_path, source_ref, resolved_commit
      ) VALUES (
        'skill_bundle_standalone_review', 'workspace_1',
        'sha256:${"2".repeat(64)}', 'review', 'Standalone Review.', 'Use standalone review.',
        'github', 'https://github.com/example/skills', 'review',
        'main', '${"a".repeat(40)}'
      );
      INSERT INTO goat.skill_bundle_files (bundle_id, path, content, executable, size_bytes)
      VALUES ('skill_bundle_standalone_review', 'SKILL.md', ''::bytea, false, 0);
      INSERT INTO goat.skill_installations (id, workspace_id, name, bundle_id)
      VALUES (
        'skill_installation_standalone_review', 'workspace_1',
        'review', 'skill_bundle_standalone_review'
      );
    `);
    await expect(
      listChatSkillBundleActivations(db, {
        workspaceId: "workspace_1",
        chatSessionId: created.conversationId,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ bundleId: "skill_bundle_plugin_review", sourceKind: "plugin" }),
    ]);
    await expect(
      readChatSkillBundleFile(db, {
        workspaceId: "workspace_1",
        chatSessionId: created.conversationId,
        skillName: "review",
        path: "SKILL.md",
      }),
    ).resolves.toMatchObject({ path: "SKILL.md" });
    await database.exec("UPDATE goat.plugins SET status = 'disabled' WHERE id = 'plugin_review'");
    await expect(
      listChatSkillBundleActivations(db, {
        workspaceId: "workspace_1",
        chatSessionId: created.conversationId,
      }),
    ).resolves.toEqual([]);
    await expect(
      readChatSkillBundleFile(db, {
        workspaceId: "workspace_1",
        chatSessionId: created.conversationId,
        skillName: "review",
        path: "SKILL.md",
      }),
    ).resolves.toBeNull();
  });

  it("cancels a paused approval Run when the user sends a new Message", async () => {
    const paused = await service.createMessage(actor(), {
      idempotencyKey: "send-paused-before-new-message",
      content: "Change the customer record",
      engine: "opencompany",
      model: "provider/model",
    });
    await database.query("UPDATE goat.codex_chat_turns SET status = 'paused' WHERE id = $1", [
      paused.runId,
    ]);
    await database.query(
      `INSERT INTO goat.run_approvals (id, run_id, tool_call_id, kind, prompt, options)
       VALUES (
         'approval_talked_past', $1, 'tool_call_talked_past',
         'use_action', 'Approve crm.update?', '["approved","denied"]'
       )`,
      [paused.runId],
    );
    await database.query(
      `INSERT INTO goat.capability_runs (
         id, workspace_id, user_workos_id, chat_session_id, tool_call_id, status,
         approval_expires_at
       ) VALUES (
         'capability_talked_past', 'workspace_1', 'user_1', $1,
         'tool_call_talked_past', 'awaiting_approval', '2026-08-10T20:15:00Z'
       )`,
      [paused.conversationId],
    );
    await database.query(
      `UPDATE goat.chat_messages AS message
       SET debug_trace = jsonb_build_object(
         'schemaVersion', 'opencompany.chat.debug.v1',
         'uiMessageParts', jsonb_build_array(jsonb_build_object(
           'type', 'tool-use_action',
           'toolCallId', 'tool_call_talked_past',
           'state', 'approval-requested',
           'approval', jsonb_build_object('id', 'approval_talked_past')
         ))
       )
       FROM goat.codex_chat_turns AS run
       WHERE run.id = $1 AND message.id = run.assistant_message_id`,
      [paused.runId],
    );

    await expect(
      service.createMessage(actor(), {
        idempotencyKey: "send-after-paused-approval",
        conversationId: paused.conversationId,
        content: "Skip that and summarize the account instead",
        engine: "opencompany",
        model: "provider/model",
      }),
    ).resolves.toMatchObject({ conversationId: paused.conversationId });

    expect(
      (
        await database.query<{ status: string }>(
          "SELECT status FROM goat.codex_chat_turns WHERE id = $1",
          [paused.runId],
        )
      ).rows,
    ).toEqual([{ status: "interrupted" }]);
    expect(
      (
        await database.query<{ status: string; resolution: string }>(
          "SELECT status, resolution FROM goat.run_approvals WHERE id = 'approval_talked_past'",
        )
      ).rows,
    ).toEqual([{ status: "canceled", resolution: "canceled" }]);
    expect(
      (
        await database.query<{ status: string }>(
          "SELECT status FROM goat.capability_runs WHERE id = 'capability_talked_past'",
        )
      ).rows,
    ).toEqual([{ status: "canceled" }]);
    const oldAssistant = await database.query<{ debug_trace: { uiMessageParts: unknown[] } }>(
      `SELECT message.debug_trace
       FROM goat.chat_messages AS message
       JOIN goat.codex_chat_turns AS run ON run.assistant_message_id = message.id
       WHERE run.id = $1`,
      [paused.runId],
    );
    expect(oldAssistant.rows[0]?.debug_trace.uiMessageParts).toEqual([
      expect.objectContaining({ state: "output-denied" }),
    ]);
    expect(
      (
        await database.query<{ type: string }>(
          "SELECT type FROM goat.run_events WHERE run_id = $1 ORDER BY sequence DESC LIMIT 1",
          [paused.runId],
        )
      ).rows,
    ).toEqual([{ type: "run.canceled" }]);
  });

  it("abandons the prior Attempt when an expired Run lease is reclaimed", async () => {
    const created = await service.createMessage(actor(), {
      idempotencyKey: "send-recovered-worker",
      content: "Recover this",
      engine: "opencompany",
      model: "provider/model",
    });
    await database.query(
      `UPDATE goat.codex_chat_turns
       SET status = 'running', attempts = 1, lease_id = 'lease_old', lease_owner = 'worker_old'
       WHERE id = $1`,
      [created.runId],
    );
    const execution = new PostgresRunExecutionRepository(
      execute,
      () => new Date("2026-08-10T20:02:00.000Z"),
    );
    await execution.startAttempt({
      worker: { workerId: "worker_old", deployVersion: "deploy_old" },
      runId: created.runId,
      attemptId: "attempt_old",
      leaseId: "lease_old",
    });
    await database.query(
      `UPDATE goat.codex_chat_turns
       SET attempts = 2, lease_id = 'lease_new', lease_owner = 'worker_new'
       WHERE id = $1`,
      [created.runId],
    );

    await expect(
      execution.startAttempt({
        worker: { workerId: "worker_new", deployVersion: "deploy_new" },
        runId: created.runId,
        attemptId: "attempt_new",
        leaseId: "lease_new",
      }),
    ).resolves.toMatchObject({
      id: "attempt_new",
      number: 2,
      status: "running",
      deployVersion: "deploy_new",
      previousDeployVersion: "deploy_old",
    });
    await expect(
      execution.startAttempt({
        worker: { workerId: "worker_new", deployVersion: "deploy_new" },
        runId: created.runId,
        attemptId: "attempt_new",
        leaseId: "lease_new",
      }),
    ).resolves.toMatchObject({ previousDeployVersion: "deploy_old" });
    expect(
      (
        await database.query<{
          id: string;
          status: string;
          error_code: string | null;
          deploy_version: string | null;
        }>(
          `SELECT id, status, error_code, deploy_version
           FROM goat.run_attempts
           WHERE run_id = $1
           ORDER BY number`,
          [created.runId],
        )
      ).rows,
    ).toEqual([
      {
        id: "attempt_old",
        status: "abandoned",
        error_code: "lease_reclaimed",
        deploy_version: "deploy_old",
      },
      {
        id: "attempt_new",
        status: "running",
        error_code: null,
        deploy_version: "deploy_new",
      },
    ]);
  });

  it("projects queued cancellation to the assistant, runtime, and semantic log", async () => {
    const created = await service.createMessage(actor(), {
      idempotencyKey: "send-cancel",
      content: "Cancel this",
      engine: "opencompany",
      model: "provider/model",
    });
    await database.query(
      `INSERT INTO goat.run_approvals (id, run_id, tool_call_id, kind, prompt, options)
       VALUES (
         'approval_before_cancel', $1, 'tool_call_before_cancel',
         'use_action', 'Approve?', '["approved","denied"]'
       )`,
      [created.runId],
    );
    await database.query(
      `INSERT INTO goat.capability_runs (
         id, workspace_id, user_workos_id, chat_session_id, tool_call_id, status,
         approval_expires_at
       ) VALUES (
         'capability_before_cancel', 'workspace_1', 'user_1', $1,
         'tool_call_before_cancel', 'awaiting_approval', '2026-08-10T20:15:00Z'
       )`,
      [created.conversationId],
    );

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
    expect(
      (
        await database.query<{ approval_status: string; capability_status: string }>(`
          SELECT approval.status AS approval_status, capability.status AS capability_status
          FROM goat.run_approvals AS approval
          JOIN goat.capability_runs AS capability
            ON capability.tool_call_id = approval.tool_call_id
          WHERE approval.id = 'approval_before_cancel'
        `)
      ).rows,
    ).toEqual([{ approval_status: "canceled", capability_status: "canceled" }]);
  });

  it("continues and cancels a Task through canonical Messages, Runs, and Events", async () => {
    await seedTerminalTask(database);
    const sharedActor = actor({ userId: "user_3" });
    const command = {
      idempotencyKey: "task-follow-up-1",
      conversationId: "task_conversation_1",
      clientMessageId: "task_message_follow_up_1",
      content: "Continue from the review findings.",
      engine: "opencompany" as const,
      model: "provider/model",
      mentions: [{ kind: "skill" as const, id: "review" }],
    };

    const created = await service.createMessage(sharedActor, command);
    await expect(service.createMessage(sharedActor, command)).resolves.toEqual({
      ...created,
      idempotentReplay: true,
    });
    await expect(service.getRun(sharedActor, created.runId)).resolves.toMatchObject({
      conversationId: "task_conversation_1",
      status: "queued",
    });
    await expect(
      service.getRun(actor({ userId: "user_2", workspaceId: "workspace_2" }), created.runId),
    ).rejects.toMatchObject({ code: "not_found" });

    expect(
      await database.query<{
        status: string;
        session_id: string;
        host_tool_contract_version: string;
        run_owner: string;
        run_settings: Record<string, unknown>;
      }>(`
        SELECT
          task.status, task.session_id, runtime.host_tool_contract_version,
          run.user_workos_id AS run_owner, run.settings AS run_settings
        FROM goat.tasks AS task
        JOIN goat.codex_chat_sessions AS runtime ON runtime.chat_session_id = task.session_id
        JOIN goat.codex_chat_turns AS run ON run.id = '${created.runId}'
        WHERE task.id = 'task_1'
      `),
    ).toMatchObject({
      rows: [
        {
          status: "running",
          session_id: "task_conversation_1",
          host_tool_contract_version: CHAT_HOST_TOOL_CONTRACT_VERSION,
          run_owner: "user_1",
          run_settings: { taskResultMode: "assistant_final" },
        },
      ],
    });
    expect(
      await database.query<{
        author: string;
        author_workos_id: string;
        kind: string;
        body: string;
        metadata: Record<string, unknown>;
      }>(`
        SELECT author, author_workos_id, kind, body, metadata
        FROM goat.task_activities
        WHERE task_id = 'task_1'
      `),
    ).toMatchObject({
      rows: [
        {
          author: "user",
          author_workos_id: "user_3",
          kind: "status_changed",
          body: "Resumed by user.",
          metadata: {
            fromStatus: "succeeded",
            toStatus: "running",
            runId: created.runId,
          },
        },
      ],
    });
    expect(
      await database.query<{ task_id: string | null }>(
        `SELECT task_id FROM goat.chat_messages WHERE id IN ($1, $2) ORDER BY role DESC`,
        [created.messageId, created.assistantMessageId],
      ),
    ).toMatchObject({ rows: [{ task_id: "task_1" }, { task_id: "task_1" }] });
    expect(
      (
        await database.query<{ type: string; payload: Record<string, unknown> }>(
          `SELECT type, payload
         FROM goat.run_events WHERE run_id = $1 ORDER BY sequence`,
          [created.runId],
        )
      ).rows,
    ).toEqual([
      {
        type: "run.queued",
        payload: {
          conversationId: "task_conversation_1",
          triggerMessageId: created.messageId,
        },
      },
    ]);
    expect(
      await database.query<{ bundle_id: string; activated_message_id: string }>(`
        SELECT bundle_id, activated_message_id
        FROM goat.chat_session_skill_bundles
        WHERE chat_session_id = 'task_conversation_1'
      `),
    ).toMatchObject({
      rows: [{ bundle_id: "skill_bundle_review", activated_message_id: created.messageId }],
    });

    await database.query("UPDATE goat.codex_chat_turns SET status = 'paused' WHERE id = $1", [
      created.runId,
    ]);
    await database.query(
      `UPDATE goat.chat_messages
       SET debug_trace = jsonb_build_object(
         'schemaVersion', 'opencompany.chat.debug.v1',
         'uiMessageParts', jsonb_build_array(jsonb_build_object(
           'type', 'tool-use_action',
           'toolCallId', 'task_tool_call_approval',
           'state', 'approval-requested',
           'approval', jsonb_build_object('id', 'task_approval')
         ))
       )
       WHERE id = $1`,
      [created.assistantMessageId],
    );
    await database.query(
      `INSERT INTO goat.run_approvals (id, run_id, tool_call_id, kind, prompt, options)
       VALUES (
         'task_approval', $1, 'task_tool_call_approval',
         'use_action', 'Approve?', '["approved","denied"]'
       )`,
      [created.runId],
    );
    await database.query(
      `INSERT INTO goat.capability_runs (
         id, workspace_id, user_workos_id, chat_session_id, tool_call_id, status,
         approval_expires_at
       ) VALUES (
         'task_capability', 'workspace_1', 'user_1', 'task_conversation_1',
         'task_tool_call_approval', 'awaiting_approval', '2026-08-10T20:15:00Z'
       )`,
    );
    await expect(
      service.resolveApproval(sharedActor, {
        runId: created.runId,
        approvalId: "task_approval",
        resolution: "approved",
      }),
    ).resolves.toMatchObject({ resolution: "approved", idempotentReplay: false });
    expect(
      await database.query<{ status: string; approved_at: Date | null }>(
        "SELECT status, approved_at FROM goat.capability_runs WHERE id = 'task_capability'",
      ),
    ).toMatchObject({ rows: [{ status: "approved", approved_at: expect.any(Date) }] });

    await expect(service.cancelRun(sharedActor, created.runId)).resolves.toMatchObject({
      status: "canceled",
      idempotentReplay: false,
    });
    expect(
      await database.query<{ status: string; error: string }>(`
        SELECT status, error FROM goat.tasks WHERE id = 'task_1'
      `),
    ).toMatchObject({ rows: [{ status: "canceled", error: "Stopped by user." }] });
    expect(
      await database.query<{
        author: string;
        author_workos_id: string;
        kind: string;
        body: string;
        metadata: Record<string, unknown>;
      }>(`
        SELECT author, author_workos_id, kind, body, metadata
        FROM goat.task_activities
        WHERE task_id = 'task_1'
      `),
    ).toMatchObject({
      rows: [
        {
          author: "user",
          author_workos_id: "user_3",
          kind: "status_changed",
          body: "Resumed by user.",
          metadata: {
            fromStatus: "succeeded",
            toStatus: "running",
            runId: created.runId,
          },
        },
        {
          author: "user",
          author_workos_id: "user_3",
          kind: "status_changed",
          body: "Stopped by user.",
          metadata: {
            fromStatus: "running",
            toStatus: "canceled",
            runId: created.runId,
          },
        },
      ],
    });
  });

  it("reopens a waiting Task when the user sends a follow-up", async () => {
    await seedTerminalTask(database);
    await database.query(
      "UPDATE goat.tasks SET status = 'waiting', outcome_comment = 'Approve the plan.' WHERE id = 'task_1'",
    );

    const created = await service.createMessage(actor({ userId: "user_3" }), {
      idempotencyKey: "waiting-task-follow-up",
      conversationId: "task_conversation_1",
      content: "Approved. Continue with the implementation.",
      engine: "opencompany",
      model: "provider/model",
    });

    expect(
      await database.query<{ status: string; attempts: number; outcome_comment: string | null }>(`
        SELECT status, attempts, outcome_comment FROM goat.tasks WHERE id = 'task_1'
      `),
    ).toMatchObject({ rows: [{ status: "running", attempts: 2, outcome_comment: null }] });
    expect(
      await database.query<{ kind: string; metadata: Record<string, unknown> }>(`
        SELECT kind, metadata FROM goat.task_activities WHERE task_id = 'task_1'
      `),
    ).toMatchObject({
      rows: [
        {
          kind: "status_changed",
          metadata: { fromStatus: "waiting", toStatus: "running", runId: created.runId },
        },
      ],
    });
  });

  it("keeps archived Task conversations read-only", async () => {
    await seedTerminalTask(database);
    await database.query("UPDATE goat.tasks SET archived_at = now() WHERE id = 'task_1'");

    await expect(
      service.createMessage(actor({ userId: "user_3" }), {
        idempotencyKey: "archived-task-follow-up",
        conversationId: "task_conversation_1",
        content: "Continue this archived task.",
        engine: "opencompany",
        model: "provider/model",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(
      await database.query<{ status: string; activity_count: number }>(`
        SELECT task.status, count(activity.id)::integer AS activity_count
        FROM goat.tasks AS task
        LEFT JOIN goat.task_activities AS activity ON activity.task_id = task.id
        WHERE task.id = 'task_1'
        GROUP BY task.id
      `),
    ).toMatchObject({ rows: [{ status: "succeeded", activity_count: 0 }] });
  });

  it("keeps the first Chat bundle fixed after its installation is replaced and archived", async () => {
    await seedStandaloneReviewSkill(database);
    const first = await service.createMessage(actor(), {
      idempotencyKey: "skill-snapshot-v1",
      content: "Review this.",
      engine: "codex",
      model: "provider/model",
      mentions: [{ kind: "skill", id: "review" }],
    });
    await database.query(
      `UPDATE goat.codex_chat_turns
       SET status = 'completed', completed_at = now()
       WHERE id = $1`,
      [first.runId],
    );
    await database.query(
      `UPDATE goat.codex_chat_sessions
       SET status = 'idle', active_turn_id = NULL
       WHERE chat_session_id = $1`,
      [first.conversationId],
    );
    await database.exec(`
      INSERT INTO goat.skill_bundles (
        id, workspace_id, integrity, name, description, body,
        source_type, source_url, source_path, source_ref, resolved_commit
      ) VALUES (
        'skill_bundle_review_v2', 'workspace_1',
        'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        'review', 'Review carefully.', 'Replacement body.', 'github',
        'https://github.com/example/review', 'review', 'main',
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      );
      INSERT INTO goat.skill_bundle_files (bundle_id, path, content, executable, size_bytes)
      VALUES ('skill_bundle_review_v2', 'SKILL.md', ''::bytea, false, 0);
      UPDATE goat.skill_installations
      SET bundle_id = 'skill_bundle_review_v2'
      WHERE id = 'skill_review';
    `);

    await service.createMessage(actor(), {
      idempotencyKey: "skill-snapshot-v2",
      conversationId: first.conversationId,
      content: "Review this again.",
      engine: "codex",
      model: "provider/model",
      mentions: [{ kind: "skill", id: "review" }],
    });
    await database.exec(`
      UPDATE goat.skill_installations
      SET enabled = false, archived_at = now()
      WHERE id = 'skill_review';
    `);

    await expect(
      database.query<{
        bundle_id: string;
        name: string;
        activated_message_id: string;
        source_kind: string;
      }>(
        `SELECT bundle_id, name, activated_message_id, source_kind
         FROM goat.chat_session_skill_bundles
         WHERE chat_session_id = $1`,
        [first.conversationId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          bundle_id: "skill_bundle_review",
          name: "review",
          activated_message_id: first.messageId,
          source_kind: "standalone",
        },
      ],
    });
  });

  it("does not let a malformed Task link broaden access to a normal Chat Run", async () => {
    const created = await service.createMessage(actor(), {
      idempotencyKey: "private-chat-run",
      content: "Keep this Chat private to its owner.",
      engine: "opencompany",
      model: "provider/model",
    });
    await database.query(
      `INSERT INTO goat.tasks (id, user_workos_id, workspace_id, session_id)
       VALUES ('malformed_task_link', 'user_1', 'workspace_1', $1)`,
      [created.conversationId],
    );
    const workspaceMember = actor({ userId: "user_3" });

    await expect(service.getRun(workspaceMember, created.runId)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(service.cancelRun(workspaceMember, created.runId)).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

async function seedTerminalTask(database: PGlite) {
  await database.exec(`
    INSERT INTO goat.chat_sessions (
      id, user_workos_id, title, model, engine, kind
    ) VALUES (
      'task_conversation_1', 'user_1', 'Review task', 'provider/model', 'opencompany', 'task'
    );
    INSERT INTO goat.tasks (
      id, user_workos_id, workspace_id, session_id, status, stage, result, attempts
    ) VALUES (
      'task_1', 'user_1', 'workspace_1', 'task_conversation_1',
      'succeeded', 'completed', 'Initial review complete.', 1
    );
    INSERT INTO goat.chat_messages (id, session_id, role, content, task_id)
    VALUES
      ('task_message_1', 'task_conversation_1', 'user', 'Review the repository.', 'task_1'),
      ('task_assistant_1', 'task_conversation_1', 'assistant', 'Review complete.', 'task_1');
    INSERT INTO goat.codex_chat_sessions (
      id, user_workos_id, chat_session_id, engine, model, workspace_id,
      host_tool_contract_version, status
    ) VALUES (
      'task_runtime_1', 'user_1', 'task_conversation_1', 'opencompany', 'provider/model',
      'workspace_1', NULL, 'idle'
    );
    INSERT INTO goat.codex_chat_turns (
      id, user_workos_id, codex_chat_session_id, chat_session_id,
      user_message_id, assistant_message_id, status, prompt, completed_at
    ) VALUES (
      'task_run_1', 'user_1', 'task_runtime_1', 'task_conversation_1',
      'task_message_1', 'task_assistant_1', 'completed', 'Review the repository.', now()
    );
  `);
  await seedStandaloneReviewSkill(database);
}

async function seedStandaloneReviewSkill(database: PGlite) {
  await database.exec(`
    INSERT INTO goat.skill_bundles (
      id, workspace_id, integrity, name, description, body,
      source_type, source_url, source_path, source_ref, resolved_commit
    ) VALUES (
      'skill_bundle_review', 'workspace_1',
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'review', 'Review carefully.', 'Be thorough.', 'github',
      'https://github.com/example/review', 'review', 'main',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    );
    INSERT INTO goat.skill_bundle_files (bundle_id, path, content, executable, size_bytes)
    VALUES ('skill_bundle_review', 'SKILL.md', ''::bytea, false, 0);
    INSERT INTO goat.skill_installations (id, workspace_id, name, bundle_id)
    VALUES ('skill_review', 'workspace_1', 'review', 'skill_bundle_review');
  `);
}

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
  CREATE TABLE goat.capability_runs (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    user_workos_id text NOT NULL,
    chat_session_id text NOT NULL REFERENCES goat.chat_sessions(id),
    tool_call_id text,
    status text NOT NULL,
    approval_expires_at timestamptz,
    approved_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE goat.action_turns (
    id text PRIMARY KEY,
    session_id text NOT NULL,
    turn_id text NOT NULL,
    user_workos_id text NOT NULL,
    workspace_id text NOT NULL,
    policy text NOT NULL,
    approval_records jsonb NOT NULL DEFAULT '{}',
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE goat.tasks (
    id text PRIMARY KEY,
    user_workos_id text NOT NULL REFERENCES goat.users(workos_user_id),
    workspace_id text,
    session_id text UNIQUE REFERENCES goat.chat_sessions(id),
    source text NOT NULL DEFAULT 'manual',
    status text NOT NULL DEFAULT 'queued',
    stage text NOT NULL DEFAULT 'queued',
    result text,
    error text,
    reported_outcome text,
    outcome_comment text,
    attempts integer NOT NULL DEFAULT 0,
    next_run_at timestamptz NOT NULL DEFAULT now(),
    lease_id text,
    lease_owner text,
    lease_expires_at timestamptz,
    archived_at timestamptz,
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
