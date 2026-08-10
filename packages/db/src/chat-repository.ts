import { createHash, randomUUID } from "node:crypto";
import {
  type Actor,
  type ChatAttachmentFormat,
  type ChatRepository,
  type Conversation,
  type ConversationPage,
  CoreError,
  type CreateMessageCommand,
  type CreateMessageResult,
  type Message,
  type MessageAttachment,
  type MessagePage,
  type ResolveApprovalResult,
  type Run,
  type RunAttempt,
  type RunEvent,
  type RunEventPage,
  type RunExecutionRepository,
  type RunStatus,
} from "@opencompany/core";
import { type SQL, sql } from "drizzle-orm";
import type { GoatChatMessageAttachment } from "./goat-schema";

export const RUN_EVENT_NOTIFY_CHANNEL = "goat_run_events_v1";

export type ChatSqlExecute = (query: SQL) => Promise<unknown>;

export type ResolvedChatAttachments = {
  attachments: readonly GoatChatMessageAttachment[];
  attachmentTexts: Readonly<Record<string, string>> | null;
};

export type ChatAttachmentResolver = (input: {
  actor: Actor;
  attachmentIds: readonly string[];
}) => Promise<ResolvedChatAttachments>;

export type CreateChatAttachmentUploadInput = {
  actor: Actor;
  id: string;
  format: ChatAttachmentFormat;
  mediaType: string;
  filename: string;
  sizeBytes: number;
  blobPathname: string;
  blobUrl: string;
  extractedText: string | null;
  expiresAt: Date;
};

export type ChatAttachmentUpload = {
  id: string;
  format: ChatAttachmentFormat;
  mediaType: string;
  filename: string;
  sizeBytes: number;
  expiresAt: Date;
};

export type ChatRepositoryIdFactory = {
  command(): string;
  conversation(): string;
  message(): string;
  runtime(): string;
  run(): string;
  event(): string;
};

const defaultIds: ChatRepositoryIdFactory = {
  command: () => `command_${randomUUID()}`,
  conversation: () => `conversation_${randomUUID()}`,
  message: () => `message_${randomUUID()}`,
  runtime: () => `runtime_${randomUUID()}`,
  run: () => `run_${randomUUID()}`,
  event: () => `event_${randomUUID()}`,
};

export class PostgresChatAttachmentRepository {
  constructor(
    private readonly execute: ChatSqlExecute,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(input: CreateChatAttachmentUploadInput): Promise<ChatAttachmentUpload | null> {
    const createdAt = this.now();
    const [row] = await this.rows<ChatAttachmentUploadRow>(sql`
      INSERT INTO goat.chat_attachment_uploads (
        id, user_workos_id, workspace_id, format, media_type, filename, size_bytes,
        blob_pathname, blob_url, extracted_text, expires_at, created_at
      )
      SELECT
        ${input.id}, ${input.actor.userId}, ${input.actor.workspaceId}, ${input.format},
        ${input.mediaType}, ${input.filename}, ${input.sizeBytes}, ${input.blobPathname},
        ${input.blobUrl}, ${input.extractedText}, ${input.expiresAt}, ${createdAt}
      WHERE EXISTS (
        SELECT 1
        FROM goat.workspace_members AS member
        WHERE member.workspace_id = ${input.actor.workspaceId}
          AND member.user_workos_id = ${input.actor.userId}
      )
      RETURNING
        id, format, media_type AS "mediaType", filename, size_bytes AS "sizeBytes",
        expires_at AS "expiresAt"
    `);
    return row ? mapAttachmentUpload(row) : null;
  }

  async resolve(input: {
    actor: Actor;
    attachmentIds: readonly string[];
  }): Promise<ResolvedChatAttachments> {
    if (input.attachmentIds.length === 0) return { attachments: [], attachmentTexts: null };
    const rows = await this.rows<ResolvedAttachmentRow>(sql`
      SELECT
        upload.id,
        upload.format,
        upload.media_type AS "mediaType",
        upload.filename,
        upload.size_bytes AS "sizeBytes",
        upload.blob_pathname AS "blobPathname",
        upload.blob_url AS "blobUrl",
        upload.extracted_text AS "extractedText"
      FROM goat.chat_attachment_uploads AS upload
      WHERE upload.user_workos_id = ${input.actor.userId}
        AND upload.workspace_id = ${input.actor.workspaceId}
        AND upload.claimed_at IS NULL
        AND upload.expires_at > ${this.now()}
        AND upload.id IN (${sql.join(
          input.attachmentIds.map((id) => sql`${id}`),
          sql`, `,
        )})
        AND EXISTS (
          SELECT 1
          FROM goat.workspace_members AS member
          WHERE member.workspace_id = ${input.actor.workspaceId}
            AND member.user_workos_id = ${input.actor.userId}
        )
    `);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const ordered = input.attachmentIds.map((id) => byId.get(id));
    if (ordered.some((row) => !row)) {
      throw new CoreError("invalid_argument", "An attachment is unavailable or has expired.");
    }
    const resolved = ordered as ResolvedAttachmentRow[];
    const attachmentTexts = Object.fromEntries(
      resolved.flatMap((row) => (row.extractedText ? [[row.id, row.extractedText]] : [])),
    );
    return {
      attachments: resolved.map((row) => ({
        id: row.id,
        kind: row.format,
        mediaType: row.mediaType,
        filename: row.filename,
        sizeBytes: row.sizeBytes,
        blobPathname: row.blobPathname,
        blobUrl: row.blobUrl,
      })),
      attachmentTexts: Object.keys(attachmentTexts).length > 0 ? attachmentTexts : null,
    };
  }

  private async rows<Row>(query: SQL): Promise<Row[]> {
    return rowsFromExecute<Row>(await this.execute(query));
  }
}

export class PostgresChatRepository implements ChatRepository {
  constructor(
    private readonly execute: ChatSqlExecute,
    private readonly options: {
      ids?: ChatRepositoryIdFactory;
      resolveAttachments?: ChatAttachmentResolver;
      now?: () => Date;
    } = {},
  ) {}

  async listConversations(input: {
    actor: Actor;
    cursor?: string;
    limit: number;
  }): Promise<ConversationPage> {
    const cursor = decodeConversationCursor(input.cursor);
    const rows = await this.rows<ConversationRow>(sql`
      SELECT
        chat.id,
        chat.title,
        chat.engine,
        chat.model,
        chat.created_at AS "createdAt",
        chat.updated_at AS "updatedAt"
      FROM goat.chat_sessions AS chat
      LEFT JOIN goat.codex_chat_sessions AS runtime ON runtime.chat_session_id = chat.id
      WHERE chat.user_workos_id = ${input.actor.userId}
        AND chat.kind = 'chat'
        AND chat.closed_at IS NULL
        AND (
          runtime.id IS NULL
          OR runtime.workspace_id IS NULL
          OR runtime.workspace_id = ${input.actor.workspaceId}
        )
        AND EXISTS (
          SELECT 1 FROM goat.workspace_members AS member
          WHERE member.workspace_id = ${input.actor.workspaceId}
            AND member.user_workos_id = ${input.actor.userId}
        )
        AND (
          ${cursor?.updatedAt ?? null}::timestamptz IS NULL
          OR (chat.updated_at, chat.id) < (
            ${cursor?.updatedAt ?? null}::timestamptz,
            ${cursor?.id ?? null}::text
          )
        )
      ORDER BY chat.updated_at DESC, chat.id DESC
      LIMIT ${input.limit + 1}
    `);
    const page = rows.slice(0, input.limit).map(mapConversation);
    const last = page.at(-1);
    return {
      conversations: page,
      nextCursor:
        rows.length > input.limit && last
          ? encodeConversationCursor(last.updatedAt, last.id)
          : null,
    };
  }

  async getConversation(input: {
    actor: Actor;
    conversationId: string;
  }): Promise<Conversation | null> {
    const [conversation] = await this.rows<ConversationRow>(sql`
      SELECT
        chat.id,
        chat.title,
        chat.engine,
        chat.model,
        chat.created_at AS "createdAt",
        chat.updated_at AS "updatedAt"
      FROM goat.chat_sessions AS chat
      LEFT JOIN goat.codex_chat_sessions AS runtime ON runtime.chat_session_id = chat.id
      WHERE chat.id = ${input.conversationId}
        AND chat.user_workos_id = ${input.actor.userId}
        AND chat.kind = 'chat'
        AND chat.closed_at IS NULL
        AND (
          runtime.id IS NULL
          OR runtime.workspace_id IS NULL
          OR runtime.workspace_id = ${input.actor.workspaceId}
        )
        AND EXISTS (
          SELECT 1 FROM goat.workspace_members AS member
          WHERE member.workspace_id = ${input.actor.workspaceId}
            AND member.user_workos_id = ${input.actor.userId}
        )
      LIMIT 1
    `);
    return conversation ? mapConversation(conversation) : null;
  }

  async listMessages(input: {
    actor: Actor;
    conversationId: string;
    cursor?: string;
    limit: number;
  }): Promise<MessagePage | null> {
    const cursor = decodeMessageCursor(input.cursor);
    const rows = await this.rows<MessagePageRow>(sql`
      WITH authorized AS MATERIALIZED (
        SELECT chat.id
        FROM goat.chat_sessions AS chat
        LEFT JOIN goat.codex_chat_sessions AS runtime ON runtime.chat_session_id = chat.id
        WHERE chat.id = ${input.conversationId}
          AND chat.user_workos_id = ${input.actor.userId}
          AND chat.kind = 'chat'
          AND chat.closed_at IS NULL
          AND (
            runtime.id IS NULL
            OR runtime.workspace_id IS NULL
            OR runtime.workspace_id = ${input.actor.workspaceId}
          )
          AND EXISTS (
            SELECT 1 FROM goat.workspace_members AS member
            WHERE member.workspace_id = ${input.actor.workspaceId}
              AND member.user_workos_id = ${input.actor.userId}
          )
      )
      SELECT
        authorized.id AS "authorizedConversationId",
        message.id,
        message.session_id AS "conversationId",
        message.role,
        message.content,
        message.attachments,
        message.created_at AS "createdAt",
        message.updated_at AS "updatedAt"
      FROM authorized
      LEFT JOIN LATERAL (
        SELECT message.*
        FROM goat.chat_messages AS message
        WHERE message.session_id = authorized.id
          AND (
            ${cursor?.createdAt ?? null}::timestamptz IS NULL
            OR (message.created_at, message.id) > (
              ${cursor?.createdAt ?? null}::timestamptz,
              ${cursor?.id ?? null}::text
            )
          )
        ORDER BY message.created_at ASC, message.id ASC
        LIMIT ${input.limit + 1}
      ) AS message ON true
      ORDER BY message.created_at ASC, message.id ASC
    `);
    if (rows.length === 0) return null;
    const page = rows
      .filter((row): row is MessagePageRow & MessageRow => row.id !== null)
      .slice(0, input.limit)
      .map(mapMessage);
    const last = page.at(-1);
    return {
      messages: page,
      nextCursor:
        rows.filter((row) => row.id !== null).length > input.limit && last
          ? encodeMessageCursor(last.createdAt, last.id)
          : null,
    };
  }

  async createMessageAndRun(input: {
    actor: Actor;
    command: CreateMessageCommand;
  }): Promise<CreateMessageResult> {
    const requestHash = hashCommand(input.command);
    const [preflight] = await this.rows<CommandPreflightRow>(sql`
      WITH membership AS MATERIALIZED (
        SELECT EXISTS (
          SELECT 1 FROM goat.workspace_members AS member
          WHERE member.workspace_id = ${input.actor.workspaceId}
            AND member.user_workos_id = ${input.actor.userId}
        ) AS authorized
      )
      SELECT
        membership.authorized,
        reservation.command_id AS "commandId",
        reservation.request_hash AS "requestHash",
        reservation.conversation_id AS "conversationId",
        reservation.message_id AS "messageId",
        reservation.run_id AS "runId",
        reservation.transaction_id AS "transactionId",
        true AS replayed,
        (
          EXISTS (
            SELECT 1
            FROM goat.codex_chat_turns AS run
            JOIN goat.chat_messages AS user_message
              ON user_message.id = reservation.message_id
            JOIN goat.chat_messages AS assistant_message
              ON assistant_message.id = reservation.assistant_message_id
            WHERE run.id = reservation.run_id
              AND run.chat_session_id = reservation.conversation_id
              AND run.user_message_id = user_message.id
              AND run.assistant_message_id = assistant_message.id
          )
        ) AS materialized
      FROM membership
      LEFT JOIN LATERAL (
        SELECT *
        FROM goat.chat_command_idempotency
        WHERE user_workos_id = ${input.actor.userId}
          AND workspace_id = ${input.actor.workspaceId}
          AND idempotency_key = ${input.command.idempotencyKey}
          AND membership.authorized
        LIMIT 1
      ) AS reservation ON true
    `);
    if (!preflight?.authorized) {
      throw new CoreError("not_found", "Conversation or workspace membership not found.");
    }
    if (preflight.commandId) {
      return createMessageResultFromPreflight(preflight, requestHash);
    }

    const ids = this.options.ids ?? defaultIds;
    const commandId = ids.command();
    const conversationId =
      input.command.conversationId ?? input.command.clientConversationId ?? ids.conversation();
    const messageId = input.command.clientMessageId ?? ids.message();
    const assistantMessageId = ids.message();
    const runtimeId = ids.runtime();
    const runId = ids.run();
    const eventId = ids.event();
    const now = this.options.now?.() ?? new Date();
    const attachmentIds = input.command.attachmentIds ?? [];
    const resolvedAttachments = await this.resolveAttachments(input.actor, attachmentIds);
    const attachmentsJson = JSON.stringify(resolvedAttachments.attachments);
    const attachmentTextsJson = JSON.stringify(resolvedAttachments.attachmentTexts);
    const title = conversationTitle(
      input.command.content,
      resolvedAttachments.attachments[0]?.filename,
    );
    const attachmentIdList = attachmentIds.length
      ? sql.join(
          attachmentIds.map((id) => sql`${id}`),
          sql`, `,
        )
      : sql`NULL`;

    const [reservation] = await this.rows<CreateResultRow>(sql`
      WITH membership AS MATERIALIZED (
        SELECT 1
        FROM goat.workspace_members
        WHERE workspace_id = ${input.actor.workspaceId}
          AND user_workos_id = ${input.actor.userId}
      ),
      authorized_existing AS MATERIALIZED (
        SELECT chat.id, chat.model
        FROM goat.chat_sessions AS chat
        LEFT JOIN goat.codex_chat_sessions AS runtime ON runtime.chat_session_id = chat.id
        WHERE chat.id = ${input.command.conversationId ?? null}
          AND chat.user_workos_id = ${input.actor.userId}
          AND chat.kind = 'chat'
          AND chat.engine = ${input.command.engine}
          AND chat.closed_at IS NULL
          AND (
            runtime.id IS NULL
            OR (
              runtime.user_workos_id = ${input.actor.userId}
              AND runtime.engine = ${input.command.engine}
              AND (runtime.workspace_id IS NULL OR runtime.workspace_id = ${input.actor.workspaceId})
            )
          )
          AND EXISTS (SELECT 1 FROM membership)
      ),
      eligible_attachments AS MATERIALIZED (
        SELECT upload.id
        FROM goat.chat_attachment_uploads AS upload
        WHERE upload.user_workos_id = ${input.actor.userId}
          AND upload.workspace_id = ${input.actor.workspaceId}
          AND upload.claimed_at IS NULL
          AND upload.expires_at > ${now}
          AND upload.id IN (${attachmentIdList})
          AND EXISTS (SELECT 1 FROM membership)
        FOR UPDATE
      ),
      reservation AS MATERIALIZED (
        INSERT INTO goat.chat_command_idempotency (
          command_id, user_workos_id, workspace_id, idempotency_key, request_hash,
          conversation_id, message_id, assistant_message_id, runtime_id, run_id,
          created_at, touched_at
        )
        SELECT
          ${commandId}, ${input.actor.userId}, ${input.actor.workspaceId},
          ${input.command.idempotencyKey}, ${requestHash}, ${conversationId}, ${messageId},
          ${assistantMessageId}, ${runtimeId}, ${runId}, ${now}, ${now}
        WHERE EXISTS (SELECT 1 FROM membership)
          AND (SELECT COUNT(*) FROM eligible_attachments) = ${attachmentIds.length}
          AND (
            ${input.command.conversationId ?? null}::text IS NULL
            OR EXISTS (SELECT 1 FROM authorized_existing)
            OR EXISTS (
              SELECT 1
              FROM goat.chat_command_idempotency AS prior
              WHERE prior.user_workos_id = ${input.actor.userId}
                AND prior.workspace_id = ${input.actor.workspaceId}
                AND prior.idempotency_key = ${input.command.idempotencyKey}
            )
          )
        ON CONFLICT (user_workos_id, workspace_id, idempotency_key)
        DO UPDATE SET touched_at = EXCLUDED.touched_at
        RETURNING *
      ),
      winner AS MATERIALIZED (
        SELECT * FROM reservation WHERE command_id = ${commandId}
      ),
      created_chat AS (
        INSERT INTO goat.chat_sessions (
          id, user_workos_id, title, model, engine, kind, last_seen_at, created_at, updated_at
        )
        SELECT
          reservation.conversation_id, ${input.actor.userId}, ${title},
          ${input.command.model}, ${input.command.engine}, 'chat', ${now}, ${now}, ${now}
        FROM winner AS reservation
        WHERE ${input.command.conversationId ?? null}::text IS NULL
        RETURNING id, model
      ),
      target_chat AS MATERIALIZED (
        SELECT id, model FROM created_chat
        UNION ALL
        SELECT id, model FROM authorized_existing WHERE EXISTS (SELECT 1 FROM winner)
      ),
      upserted_runtime AS MATERIALIZED (
        INSERT INTO goat.codex_chat_sessions (
          id, user_workos_id, chat_session_id, engine, model, workspace_id,
          active_turn_id, status, created_at, updated_at
        )
        SELECT
          ${runtimeId}, ${input.actor.userId}, target_chat.id, ${input.command.engine},
          target_chat.model, ${input.actor.workspaceId}, ${runId}, 'queued', ${now}, ${now}
        FROM target_chat
        ON CONFLICT (chat_session_id) DO UPDATE
        SET workspace_id = COALESCE(goat.codex_chat_sessions.workspace_id, EXCLUDED.workspace_id),
            status = CASE
              WHEN goat.codex_chat_sessions.status IN ('queued', 'starting', 'running')
                THEN goat.codex_chat_sessions.status
              ELSE 'queued'
            END,
            active_turn_id = CASE
              WHEN goat.codex_chat_sessions.status IN ('queued', 'starting', 'running')
                THEN goat.codex_chat_sessions.active_turn_id
              ELSE EXCLUDED.active_turn_id
            END,
            error = NULL,
            updated_at = EXCLUDED.updated_at
        WHERE goat.codex_chat_sessions.user_workos_id = EXCLUDED.user_workos_id
          AND goat.codex_chat_sessions.engine = EXCLUDED.engine
          AND (
            goat.codex_chat_sessions.workspace_id IS NULL
            OR goat.codex_chat_sessions.workspace_id = EXCLUDED.workspace_id
          )
        RETURNING id, chat_session_id, status, active_turn_id
      ),
      claimed_attachments AS MATERIALIZED (
        UPDATE goat.chat_attachment_uploads AS upload
        SET claimed_message_id = winner.message_id,
            claimed_at = ${now}
        FROM winner
        WHERE upload.id IN (SELECT id FROM eligible_attachments)
          AND upload.claimed_at IS NULL
        RETURNING upload.id
      ),
      inserted_user_message AS (
        INSERT INTO goat.chat_messages (
          id, session_id, role, content, attachments, attachment_texts, created_at, updated_at
        )
        SELECT
          reservation.message_id, target_chat.id, 'user', ${input.command.content},
          ${attachmentsJson}::jsonb, ${attachmentTextsJson}::jsonb, ${now}, ${now}
        FROM winner AS reservation
        JOIN target_chat ON true
        JOIN upserted_runtime ON upserted_runtime.chat_session_id = target_chat.id
        WHERE (SELECT COUNT(*) FROM claimed_attachments) = ${attachmentIds.length}
        RETURNING id
      ),
      inserted_assistant_message AS (
        INSERT INTO goat.chat_messages (
          id, session_id, role, content, debug_trace, created_at, updated_at
        )
        SELECT
          reservation.assistant_message_id, target_chat.id, 'assistant', '',
          '{"schemaVersion":"opencompany.chat.debug.v1","steps":[]}'::jsonb,
          ${now}, ${now}
        FROM winner AS reservation
        JOIN target_chat ON true
        JOIN upserted_runtime ON upserted_runtime.chat_session_id = target_chat.id
        RETURNING id
      ),
      inserted_run AS MATERIALIZED (
        INSERT INTO goat.codex_chat_turns (
          id, user_workos_id, codex_chat_session_id, chat_session_id,
          user_message_id, assistant_message_id, status, prompt, settings, event_sequence,
          created_at, updated_at
        )
        SELECT
          reservation.run_id, ${input.actor.userId}, upserted_runtime.id, target_chat.id,
          reservation.message_id, reservation.assistant_message_id, 'queued',
          ${input.command.content}, '{}'::jsonb, 1, ${now}, ${now}
        FROM winner AS reservation
        JOIN target_chat ON true
        JOIN upserted_runtime ON upserted_runtime.chat_session_id = target_chat.id
        JOIN inserted_user_message ON inserted_user_message.id = reservation.message_id
        JOIN inserted_assistant_message ON inserted_assistant_message.id = reservation.assistant_message_id
        RETURNING id
      ),
      inserted_event AS (
        INSERT INTO goat.run_events (
          id, run_id, sequence, schema_version, type, payload, created_at
        )
        SELECT
          ${eventId}, inserted_run.id, 1, 1, 'run.queued',
          jsonb_build_object(
            'conversationId', reservation.conversation_id,
            'triggerMessageId', reservation.message_id
          ),
          ${now}
        FROM inserted_run
        JOIN winner AS reservation ON reservation.run_id = inserted_run.id
        RETURNING id, run_id, sequence
      ),
      notified AS MATERIALIZED (
        SELECT pg_notify(
          ${RUN_EVENT_NOTIFY_CHANNEL},
          jsonb_build_object('runId', run_id, 'sequence', sequence)::text
        )
        FROM inserted_event
      ),
      updated_chat AS (
        UPDATE goat.chat_sessions AS chat
        SET updated_at = ${now}, last_seen_at = ${now}
        FROM target_chat, inserted_run
        WHERE chat.id = target_chat.id
        RETURNING chat.id
      )
      SELECT
        reservation.command_id AS "commandId",
        reservation.request_hash AS "requestHash",
        reservation.conversation_id AS "conversationId",
        reservation.message_id AS "messageId",
        reservation.run_id AS "runId",
        reservation.transaction_id AS "transactionId",
        reservation.command_id <> ${commandId} AS replayed,
        (
          reservation.command_id <> ${commandId}
          OR EXISTS (SELECT 1 FROM inserted_run)
        ) AS materialized,
        (SELECT count(*) FROM notified) AS "notifyCount"
      FROM reservation
    `);

    if (!reservation) {
      if (attachmentIds.length > 0) {
        throw new CoreError("invalid_argument", "An attachment is unavailable or has expired.");
      }
      throw new CoreError("not_found", "Conversation or workspace membership not found.");
    }
    return createMessageResult(reservation, requestHash);
  }

  async getRun(input: { actor: Actor; runId: string }): Promise<Run | null> {
    const [row] = await this.rows<RunRow>(authorizedRunQuery(input.actor, input.runId));
    return row ? mapRun(row) : null;
  }

  async listRunEvents(input: {
    actor: Actor;
    runId: string;
    afterSequence: number;
    limit: number;
  }): Promise<RunEventPage | null> {
    const rows = await this.rows<RunEventRow>(sql`
      SELECT
        event.id,
        event.run_id AS "runId",
        event.attempt_id AS "attemptId",
        event.sequence,
        event.type,
        event.payload,
        event.created_at AS "createdAt"
      FROM goat.codex_chat_turns AS run
      JOIN goat.codex_chat_sessions AS runtime ON runtime.id = run.codex_chat_session_id
      JOIN goat.chat_sessions AS chat ON chat.id = run.chat_session_id
      LEFT JOIN goat.run_events AS event
        ON event.run_id = run.id
       AND event.sequence > ${input.afterSequence}
      WHERE run.id = ${input.runId}
        AND run.user_workos_id = ${input.actor.userId}
        AND chat.kind = 'chat'
        AND chat.closed_at IS NULL
        AND runtime.workspace_id = ${input.actor.workspaceId}
        AND EXISTS (
          SELECT 1 FROM goat.workspace_members AS member
          WHERE member.workspace_id = ${input.actor.workspaceId}
            AND member.user_workos_id = ${input.actor.userId}
        )
      ORDER BY event.sequence ASC
      LIMIT ${input.limit}
    `);
    if (rows.length === 0) {
      return (await this.getRun({ actor: input.actor, runId: input.runId }))
        ? { events: [], nextSequence: input.afterSequence }
        : null;
    }
    const events = rows.filter((row) => row.id !== null).map(mapRunEvent);
    return {
      events,
      nextSequence: events.at(-1)?.sequence ?? input.afterSequence,
    };
  }

  async cancelRun(input: { actor: Actor; runId: string }) {
    const now = this.options.now?.() ?? new Date();
    const eventId = (this.options.ids ?? defaultIds).event();
    const [row] = await this.rows<{ status: LegacyRunStatus; replayed: boolean }>(sql`
      WITH authorized AS MATERIALIZED (
        SELECT run.id
        FROM goat.codex_chat_turns AS run
        JOIN goat.codex_chat_sessions AS runtime ON runtime.id = run.codex_chat_session_id
        JOIN goat.chat_sessions AS chat ON chat.id = run.chat_session_id
        WHERE run.id = ${input.runId}
          AND run.user_workos_id = ${input.actor.userId}
          AND runtime.workspace_id = ${input.actor.workspaceId}
          AND chat.kind = 'chat'
          AND EXISTS (
            SELECT 1 FROM goat.workspace_members AS member
            WHERE member.workspace_id = ${input.actor.workspaceId}
              AND member.user_workos_id = ${input.actor.userId}
          )
      ),
      changed AS (
        UPDATE goat.codex_chat_turns AS run
        SET status = CASE WHEN run.status = 'queued' THEN 'interrupted' ELSE run.status END,
            interrupt_requested_at = CASE
              WHEN run.status = 'running' THEN ${now}
              ELSE run.interrupt_requested_at
            END,
            completed_at = CASE WHEN run.status = 'queued' THEN ${now} ELSE run.completed_at END,
            event_sequence = run.event_sequence + 1,
            updated_at = ${now}
        WHERE run.id IN (SELECT id FROM authorized)
          AND (
            run.status = 'queued'
            OR (run.status = 'running' AND run.interrupt_requested_at IS NULL)
          )
        RETURNING run.id, run.status, run.event_sequence
      ),
      inserted_event AS (
        INSERT INTO goat.run_events (
          id, run_id, sequence, schema_version, type, payload, created_at
        )
        SELECT
          ${eventId}, changed.id, changed.event_sequence, 1,
          CASE
            WHEN changed.status = 'interrupted' THEN 'run.canceled'
            ELSE 'run.cancel_requested'
          END,
          jsonb_build_object('by', 'user'),
          ${now}
        FROM changed
        RETURNING id, run_id, sequence
      ),
      aborted_message AS (
        UPDATE goat.chat_messages AS message
        SET debug_trace = COALESCE(
              message.debug_trace,
              '{"schemaVersion":"opencompany.chat.debug.v1","steps":[]}'::jsonb
            ) || jsonb_build_object('aborted', true),
            updated_at = ${now}
        FROM changed, goat.codex_chat_turns AS run
        WHERE changed.status = 'interrupted'
          AND run.id = changed.id
          AND message.id = run.assistant_message_id
          AND message.role = 'assistant'
        RETURNING message.id
      ),
      settled_runtime AS (
        UPDATE goat.codex_chat_sessions AS runtime
        SET status = 'interrupted',
            active_turn_id = NULL,
            updated_at = ${now}
        FROM goat.codex_chat_turns AS canceled
        WHERE canceled.id IN (SELECT id FROM changed WHERE status = 'interrupted')
          AND runtime.id = canceled.codex_chat_session_id
          AND NOT EXISTS (
            SELECT 1
            FROM goat.codex_chat_turns AS pending
            WHERE pending.codex_chat_session_id = runtime.id
              AND pending.status IN ('queued', 'running')
              AND pending.id NOT IN (SELECT id FROM changed WHERE status = 'interrupted')
          )
        RETURNING runtime.id
      ),
      notified AS MATERIALIZED (
        SELECT pg_notify(
          ${RUN_EVENT_NOTIFY_CHANNEL},
          jsonb_build_object('runId', run_id, 'sequence', sequence)::text
        )
        FROM inserted_event
      )
      SELECT
        COALESCE((SELECT changed.status FROM changed), run.status) AS status,
        NOT EXISTS (SELECT 1 FROM changed) AS replayed,
        (SELECT count(*) FROM notified) AS "notifyCount"
      FROM goat.codex_chat_turns AS run
      JOIN authorized ON authorized.id = run.id
    `);
    return row
      ? { runId: input.runId, status: mapRunStatus(row.status), idempotentReplay: row.replayed }
      : null;
  }

  async resolveApproval(input: {
    actor: Actor;
    command: {
      runId: string;
      approvalId: string;
      resolution: "approved" | "denied" | "answered" | "canceled";
      answer?: string;
    };
  }): Promise<ResolveApprovalResult | null> {
    const now = this.options.now?.() ?? new Date();
    const eventId = (this.options.ids ?? defaultIds).event();
    const response = { resolution: input.command.resolution, answer: input.command.answer };
    const [row] = await this.rows<{
      runId: string;
      response: Record<string, unknown> | null;
      replayed: boolean;
    }>(sql`
      WITH authorized AS MATERIALIZED (
        SELECT approval.id
        FROM goat.run_approvals AS approval
        JOIN goat.codex_chat_turns AS run ON run.id = approval.run_id
        JOIN goat.codex_chat_sessions AS runtime ON runtime.id = run.codex_chat_session_id
        JOIN goat.chat_sessions AS chat ON chat.id = run.chat_session_id
        WHERE approval.id = ${input.command.approvalId}
          AND run.id = ${input.command.runId}
          AND run.user_workos_id = ${input.actor.userId}
          AND runtime.workspace_id = ${input.actor.workspaceId}
          AND chat.kind = 'chat'
          AND chat.closed_at IS NULL
          AND EXISTS (
            SELECT 1 FROM goat.workspace_members AS member
            WHERE member.workspace_id = ${input.actor.workspaceId}
              AND member.user_workos_id = ${input.actor.userId}
          )
      ),
      changed AS (
        UPDATE goat.run_approvals AS approval
        SET status = ${input.command.resolution === "canceled" ? "canceled" : "resolved"},
            resolution = ${input.command.resolution},
            response = ${JSON.stringify(response)}::jsonb,
            resolved_at = ${now},
            updated_at = ${now}
        WHERE approval.id IN (SELECT id FROM authorized)
          AND approval.status = 'pending'
        RETURNING approval.id
      ),
      advanced_run AS MATERIALIZED (
        UPDATE goat.codex_chat_turns AS run
        SET event_sequence = run.event_sequence + 1,
            updated_at = ${now}
        WHERE run.id = ${input.command.runId}
          AND EXISTS (SELECT 1 FROM changed)
        RETURNING run.id, run.event_sequence
      ),
      inserted_event AS (
        INSERT INTO goat.run_events (
          id, run_id, sequence, schema_version, type, payload, created_at
        )
        SELECT
          ${eventId}, advanced_run.id, advanced_run.event_sequence, 1, 'approval.resolved',
          ${JSON.stringify({
            approvalId: input.command.approvalId,
            resolution: input.command.resolution,
          })}::jsonb,
          ${now}
        FROM advanced_run
        RETURNING id, run_id, sequence
      ),
      notified AS MATERIALIZED (
        SELECT pg_notify(
          ${RUN_EVENT_NOTIFY_CHANNEL},
          jsonb_build_object('runId', run_id, 'sequence', sequence)::text
        )
        FROM inserted_event
      )
      SELECT
        approval.run_id AS "runId",
        approval.response,
        NOT EXISTS (SELECT 1 FROM changed) AS replayed,
        (SELECT count(*) FROM notified) AS "notifyCount"
      FROM goat.run_approvals AS approval
      JOIN authorized ON authorized.id = approval.id
    `);
    if (!row) return null;
    const storedResolution = row.response?.resolution;
    const storedAnswer = row.response?.answer;
    if (
      row.replayed &&
      (storedResolution !== input.command.resolution ||
        (input.command.resolution === "answered" && storedAnswer !== input.command.answer))
    ) {
      throw new CoreError("idempotency_conflict", "The approval was already resolved differently.");
    }
    return {
      approvalId: input.command.approvalId,
      runId: row.runId,
      resolution: input.command.resolution,
      idempotentReplay: row.replayed,
    };
  }

  private async resolveAttachments(
    actor: Actor,
    attachmentIds: readonly string[],
  ): Promise<ResolvedChatAttachments> {
    if (attachmentIds.length === 0) return { attachments: [], attachmentTexts: null };
    if (!this.options.resolveAttachments) {
      throw new CoreError("invalid_argument", "Attachment references are not available.");
    }
    return this.options.resolveAttachments({ actor, attachmentIds });
  }

  private async rows<Row>(query: SQL): Promise<Row[]> {
    return rowsFromExecute<Row>(await this.execute(query));
  }
}

export class PostgresRunExecutionRepository implements RunExecutionRepository {
  constructor(
    private readonly execute: ChatSqlExecute,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async startAttempt(input: Parameters<RunExecutionRepository["startAttempt"]>[0]) {
    const startedAt = this.now();
    const [row] = await this.rows<RunAttemptRow>(sql`
      WITH fenced_run AS MATERIALIZED (
        SELECT id, attempts
        FROM goat.codex_chat_turns
        WHERE id = ${input.runId}
          AND status = 'running'
          AND lease_id = ${input.leaseId}
          AND lease_owner = ${input.worker.workerId}
      ),
      inserted AS (
        INSERT INTO goat.run_attempts (
          id, run_id, number, status, worker_id, lease_id, started_at, created_at
        )
        SELECT
          ${input.attemptId}, fenced_run.id, fenced_run.attempts, 'running',
          ${input.worker.workerId}, ${input.leaseId}, ${startedAt}, ${startedAt}
        FROM fenced_run
        ON CONFLICT DO NOTHING
        RETURNING *
      )
      SELECT * FROM inserted
      UNION ALL
      SELECT attempt.*
      FROM goat.run_attempts AS attempt
      JOIN fenced_run ON fenced_run.id = attempt.run_id
      WHERE attempt.lease_id = ${input.leaseId}
        AND NOT EXISTS (SELECT 1 FROM inserted)
      LIMIT 1
    `);
    return row ? mapRunAttempt(row) : null;
  }

  async appendEvents(input: Parameters<RunExecutionRepository["appendEvents"]>[0]) {
    if (input.events.length === 0) return [];
    const createdAt = this.now();
    const eventJson = JSON.stringify(input.events);
    const rows = await this.rows<RunEventRow>(sql`
      WITH input_events AS MATERIALIZED (
        SELECT
          item.value ->> 'id' AS id,
          item.value ->> 'type' AS type,
          item.value -> 'payload' AS payload,
          item.ordinality
        FROM jsonb_array_elements(${eventJson}::jsonb)
          WITH ORDINALITY AS item(value, ordinality)
      ),
      advanced_run AS MATERIALIZED (
        UPDATE goat.codex_chat_turns
        SET event_sequence = event_sequence + (SELECT COUNT(*) FROM input_events)
        WHERE id = ${input.runId}
          AND status = 'running'
          AND lease_id = ${input.leaseId}
          AND lease_owner = ${input.worker.workerId}
          AND EXISTS (
            SELECT 1 FROM goat.run_attempts AS attempt
            WHERE attempt.id = ${input.attemptId}
              AND attempt.run_id = goat.codex_chat_turns.id
              AND attempt.lease_id = ${input.leaseId}
              AND attempt.status = 'running'
          )
        RETURNING id, event_sequence - (SELECT COUNT(*) FROM input_events) AS base_sequence
      ),
      inserted AS (
        INSERT INTO goat.run_events (
          id, run_id, attempt_id, sequence, schema_version, type, payload, created_at
        )
        SELECT
          input_events.id,
          advanced_run.id,
          ${input.attemptId},
          advanced_run.base_sequence + input_events.ordinality,
          1,
          input_events.type,
          input_events.payload,
          ${createdAt}
        FROM input_events
        CROSS JOIN advanced_run
        WHERE EXISTS (
          SELECT 1 FROM goat.run_attempts AS attempt
          WHERE attempt.id = ${input.attemptId}
            AND attempt.run_id = advanced_run.id
            AND attempt.lease_id = ${input.leaseId}
            AND attempt.status = 'running'
        )
        RETURNING *
      ),
      notified AS MATERIALIZED (
        SELECT pg_notify(
          ${RUN_EVENT_NOTIFY_CHANNEL},
          jsonb_build_object('runId', run_id, 'sequence', max(sequence))::text
        )
        FROM inserted
        GROUP BY run_id
      )
      SELECT inserted.*, (SELECT COUNT(*) FROM notified) AS notified
      FROM inserted
      ORDER BY inserted.sequence ASC
    `);
    return rows.map(mapRunEvent);
  }

  async finishAttempt(input: Parameters<RunExecutionRepository["finishAttempt"]>[0]) {
    const completedAt = this.now();
    const [row] = await this.rows<RunAttemptRow>(sql`
      UPDATE goat.run_attempts AS attempt
      SET status = ${input.status},
          error_code = ${input.errorCode ?? null},
          error_message = ${input.errorMessage ?? null},
          completed_at = ${completedAt}
      FROM goat.codex_chat_turns AS run
      WHERE attempt.id = ${input.attemptId}
        AND attempt.run_id = ${input.runId}
        AND attempt.status = 'running'
        AND attempt.lease_id = ${input.leaseId}
        AND run.id = attempt.run_id
        AND run.lease_id = ${input.leaseId}
        AND run.lease_owner = ${input.worker.workerId}
      RETURNING attempt.*
    `);
    return row ? mapRunAttempt(row) : null;
  }

  private async rows<Row>(query: SQL): Promise<Row[]> {
    return rowsFromExecute<Row>(await this.execute(query));
  }
}

type ConversationRow = {
  id: string;
  title: string;
  engine: Conversation["engine"];
  model: string;
  createdAt: Date | string;
  updatedAt: Date | string;
};

type MessageRow = {
  id: string;
  conversationId: string;
  role: Message["role"];
  content: string;
  attachments: GoatChatMessageAttachment[] | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

type MessagePageRow = {
  authorizedConversationId: string;
  id: string | null;
  conversationId: string | null;
  role: Message["role"] | null;
  content: string | null;
  attachments: GoatChatMessageAttachment[] | null;
  createdAt: Date | string | null;
  updatedAt: Date | string | null;
};

type LegacyRunStatus = "queued" | "running" | "completed" | "failed" | "interrupted";
type RunRow = {
  id: string;
  conversationId: string;
  triggerMessageId: string;
  status: LegacyRunStatus;
  engine: Run["engine"];
  model: string;
  attemptCount: number;
  createdAt: Date | string;
  updatedAt: Date | string;
};

type RunEventRow = {
  id: string | null;
  runId: string;
  attemptId: string | null;
  sequence: number;
  type: RunEvent["type"];
  payload: Record<string, unknown>;
  createdAt: Date | string;
};

type RunAttemptRow = {
  id: string;
  run_id?: string;
  runId?: string;
  number: number;
  status: RunAttempt["status"];
  worker_id?: string;
  workerId?: string;
  started_at?: Date | string;
  startedAt?: Date | string;
  completed_at?: Date | string | null;
  completedAt?: Date | string | null;
  error_code?: string | null;
  errorCode?: string | null;
  error_message?: string | null;
  errorMessage?: string | null;
};

type ChatAttachmentUploadRow = {
  id: string;
  format: ChatAttachmentFormat;
  mediaType: string;
  filename: string;
  sizeBytes: number;
  expiresAt: Date | string;
};

type ResolvedAttachmentRow = {
  id: string;
  format: GoatChatMessageAttachment["kind"];
  mediaType: string;
  filename: string;
  sizeBytes: number;
  blobPathname: string;
  blobUrl: string;
  extractedText: string | null;
};

type CreateResultRow = {
  commandId: string;
  requestHash: string;
  conversationId: string;
  messageId: string;
  runId: string;
  transactionId: number | string;
  replayed: boolean;
  materialized: boolean;
};

type CommandPreflightRow = {
  authorized: boolean;
  commandId: string | null;
  requestHash: string | null;
  conversationId: string | null;
  messageId: string | null;
  runId: string | null;
  transactionId: number | string | null;
  replayed: boolean;
  materialized: boolean;
};

function createMessageResultFromPreflight(
  row: CommandPreflightRow,
  requestHash: string,
): CreateMessageResult {
  if (
    !row.commandId ||
    !row.requestHash ||
    !row.conversationId ||
    !row.messageId ||
    !row.runId ||
    row.transactionId === null
  ) {
    throw new Error("The idempotent command reservation is incomplete.");
  }
  return createMessageResult(
    {
      commandId: row.commandId,
      requestHash: row.requestHash,
      conversationId: row.conversationId,
      messageId: row.messageId,
      runId: row.runId,
      transactionId: row.transactionId,
      replayed: row.replayed,
      materialized: row.materialized,
    },
    requestHash,
  );
}

function createMessageResult(row: CreateResultRow, requestHash: string): CreateMessageResult {
  if (row.requestHash !== requestHash) {
    throw new CoreError(
      "idempotency_conflict",
      "The Idempotency-Key was already used for another command.",
    );
  }
  if (!row.materialized) {
    throw new Error("The durable Message and Run were not materialized.");
  }
  const transactionId = String(row.transactionId);
  if (!/^[0-9]+$/u.test(transactionId)) {
    throw new Error("Postgres returned an invalid transaction identifier.");
  }
  return {
    conversationId: row.conversationId,
    messageId: row.messageId,
    runId: row.runId,
    transactionId,
    idempotentReplay: row.replayed,
  };
}

function authorizedRunQuery(actor: Actor, runId: string) {
  return sql`
    SELECT
      run.id,
      run.chat_session_id AS "conversationId",
      run.user_message_id AS "triggerMessageId",
      run.status,
      runtime.engine,
      chat.model,
      run.attempts AS "attemptCount",
      run.created_at AS "createdAt",
      run.updated_at AS "updatedAt"
    FROM goat.codex_chat_turns AS run
    JOIN goat.codex_chat_sessions AS runtime ON runtime.id = run.codex_chat_session_id
    JOIN goat.chat_sessions AS chat ON chat.id = run.chat_session_id
    WHERE run.id = ${runId}
      AND run.user_workos_id = ${actor.userId}
      AND runtime.workspace_id = ${actor.workspaceId}
      AND chat.kind = 'chat'
      AND chat.closed_at IS NULL
      AND EXISTS (
        SELECT 1 FROM goat.workspace_members AS member
        WHERE member.workspace_id = ${actor.workspaceId}
          AND member.user_workos_id = ${actor.userId}
      )
    LIMIT 1
  `;
}

function mapConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    title: row.title,
    engine: row.engine,
    model: row.model,
    createdAt: asDate(row.createdAt),
    updatedAt: asDate(row.updatedAt),
  };
}

function mapMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role,
    content: row.content,
    attachments: (row.attachments ?? []).map(toPublicAttachment),
    createdAt: asDate(row.createdAt),
    updatedAt: asDate(row.updatedAt),
  };
}

function mapRun(row: RunRow): Run {
  return {
    id: row.id,
    conversationId: row.conversationId,
    triggerMessageId: row.triggerMessageId,
    status: mapRunStatus(row.status),
    engine: row.engine,
    model: row.model,
    attemptCount: row.attemptCount,
    createdAt: asDate(row.createdAt),
    updatedAt: asDate(row.updatedAt),
  };
}

function mapRunStatus(status: LegacyRunStatus): RunStatus {
  return status === "interrupted" ? "canceled" : status;
}

function mapRunEvent(row: RunEventRow): RunEvent {
  if (!row.id) throw new Error("Cannot map an empty event row.");
  return {
    id: row.id,
    runId: row.runId ?? (row as unknown as { run_id: string }).run_id,
    attemptId:
      row.attemptId ?? (row as unknown as { attempt_id?: string | null }).attempt_id ?? null,
    sequence: Number(row.sequence),
    type: row.type,
    payload: row.payload,
    createdAt: asDate(row.createdAt ?? (row as unknown as { created_at: string }).created_at),
  };
}

function mapRunAttempt(row: RunAttemptRow): RunAttempt {
  return {
    id: row.id,
    runId: row.runId ?? row.run_id ?? "",
    number: row.number,
    status: row.status,
    workerId: row.workerId ?? row.worker_id ?? "",
    startedAt: asDate(row.startedAt ?? row.started_at ?? new Date(0)),
    completedAt:
      (row.completedAt ?? row.completed_at)
        ? asDate(row.completedAt ?? row.completed_at ?? new Date(0))
        : null,
    errorCode: row.errorCode ?? row.error_code ?? null,
    errorMessage: row.errorMessage ?? row.error_message ?? null,
  };
}

function mapAttachmentUpload(row: ChatAttachmentUploadRow): ChatAttachmentUpload {
  return {
    id: row.id,
    format: row.format,
    mediaType: row.mediaType,
    filename: row.filename,
    sizeBytes: row.sizeBytes,
    expiresAt: asDate(row.expiresAt),
  };
}

function toPublicAttachment(attachment: GoatChatMessageAttachment): MessageAttachment {
  return {
    id: attachment.id,
    filename: attachment.filename,
    mediaType: attachment.mediaType,
    sizeBytes: attachment.sizeBytes,
    kind: attachment.kind === "image" ? "image" : "document",
  };
}

function hashCommand(command: CreateMessageCommand) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        conversationId: command.conversationId ?? null,
        clientConversationId: command.clientConversationId ?? null,
        clientMessageId: command.clientMessageId ?? null,
        content: command.content,
        engine: command.engine,
        model: command.model,
        attachmentIds: command.attachmentIds ?? [],
      }),
    )
    .digest("hex");
}

function conversationTitle(content: string, filename?: string) {
  const candidate = content.trim() || filename?.trim() || "New conversation";
  return candidate.replace(/\s+/gu, " ").slice(0, 80);
}

function encodeConversationCursor(updatedAt: Date, id: string) {
  return Buffer.from(JSON.stringify({ updatedAt: updatedAt.toISOString(), id }), "utf8").toString(
    "base64url",
  );
}

function encodeMessageCursor(createdAt: Date, id: string) {
  return Buffer.from(JSON.stringify({ createdAt: createdAt.toISOString(), id }), "utf8").toString(
    "base64url",
  );
}

function decodeConversationCursor(cursor?: string): { updatedAt: string; id: string } | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (!value || typeof value !== "object") throw new Error("invalid");
    const { updatedAt, id } = value as Record<string, unknown>;
    if (
      typeof updatedAt !== "string" ||
      Number.isNaN(Date.parse(updatedAt)) ||
      typeof id !== "string" ||
      !id
    ) {
      throw new Error("invalid");
    }
    return { updatedAt, id };
  } catch {
    throw new CoreError("invalid_argument", "The conversation cursor is invalid.");
  }
}

function decodeMessageCursor(cursor?: string): { createdAt: string; id: string } | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (!value || typeof value !== "object") throw new Error("invalid");
    const { createdAt, id } = value as Record<string, unknown>;
    if (
      typeof createdAt !== "string" ||
      Number.isNaN(Date.parse(createdAt)) ||
      typeof id !== "string" ||
      !id
    ) {
      throw new Error("invalid");
    }
    return { createdAt, id };
  } catch {
    throw new CoreError("invalid_argument", "The Message cursor is invalid.");
  }
}

function asDate(value: Date | string) {
  return value instanceof Date ? value : new Date(value);
}

function rowsFromExecute<Row>(result: unknown): Row[] {
  if (Array.isArray(result)) return result as Row[];
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as Row[];
  }
  return [];
}
