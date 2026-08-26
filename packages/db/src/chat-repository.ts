import { createHash, randomUUID } from "node:crypto";
import {
  ACTION_HOST_TOOL_CONTRACT_VERSION,
  CHAT_HOST_TOOL_CONTRACT_VERSION,
} from "@opencompany/agent-runtime";
import {
  type Actor,
  type ChatAttachmentFormat,
  type ChatRepository,
  type Conversation,
  type ConversationPage,
  CoreError,
  type CreateMessageCommand,
  type CreateMessageResult,
  type EngineQuestionAnswer,
  type Message,
  type MessageAttachment,
  type MessagePage,
  type ResolveApprovalResult,
  type Run,
  type RunApproval,
  type RunAttempt,
  type RunEvent,
  type RunEventPage,
  type RunExecutionRepository,
  type RunStatus,
} from "@opencompany/core";
import { type SQL, sql } from "drizzle-orm";
import type { ChatMessageAttachment } from "./product-schema";
import { type ResolvedWorkspaceSkill, resolveSkillCandidates } from "./skill-catalog";

export const RUN_EVENT_NOTIFY_CHANNEL = "goat_run_events_v1";

export type ChatSqlExecute = (query: SQL) => Promise<unknown>;

export type ResolvedChatAttachments = {
  attachments: readonly ChatMessageAttachment[];
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
        conversation.id,
        conversation.title,
        conversation.engine,
        conversation.model,
        conversation.runtime_status AS "runtimeStatus",
        conversation.active_run_id AS "activeRunId",
        conversation.runtime_has_error AS "runtimeHasError",
        conversation.runtime_updated_at AS "runtimeUpdatedAt",
        conversation.activity_state AS "activityState",
        conversation.has_unseen AS "hasUnseen",
        conversation.pinned_at AS "pinnedAt",
        conversation.created_at AS "createdAt",
        conversation.updated_at AS "updatedAt"
      FROM goat.conversation_read_model_v1 AS conversation
      WHERE conversation.actor_id = ${input.actor.userId}
        AND conversation.archived_at IS NULL
        AND (conversation.workspace_id IS NULL OR conversation.workspace_id = ${input.actor.workspaceId})
        AND EXISTS (
          SELECT 1 FROM goat.workspace_members AS member
          WHERE member.workspace_id = ${input.actor.workspaceId}
            AND member.user_workos_id = ${input.actor.userId}
        )
        AND (
          ${cursor?.updatedAt ?? null}::timestamptz IS NULL
          OR (conversation.updated_at, conversation.id) < (
            ${cursor?.updatedAt ?? null}::timestamptz,
            ${cursor?.id ?? null}::text
          )
        )
      ORDER BY conversation.updated_at DESC, conversation.id DESC
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
    includeArchived?: boolean;
  }): Promise<Conversation | null> {
    const [conversation] = await this.rows<ConversationRow>(sql`
      SELECT
        conversation.id,
        conversation.title,
        conversation.engine,
        conversation.model,
        conversation.runtime_status AS "runtimeStatus",
        conversation.active_run_id AS "activeRunId",
        conversation.runtime_has_error AS "runtimeHasError",
        conversation.runtime_updated_at AS "runtimeUpdatedAt",
        conversation.activity_state AS "activityState",
        conversation.has_unseen AS "hasUnseen",
        conversation.pinned_at AS "pinnedAt",
        conversation.created_at AS "createdAt",
        conversation.updated_at AS "updatedAt"
      FROM goat.conversation_read_model_v1 AS conversation
      WHERE conversation.id = ${input.conversationId}
        AND conversation.actor_id = ${input.actor.userId}
        AND (${input.includeArchived ?? false}::boolean OR conversation.archived_at IS NULL)
        AND (conversation.workspace_id IS NULL OR conversation.workspace_id = ${input.actor.workspaceId})
        AND EXISTS (
          SELECT 1 FROM goat.workspace_members AS member
          WHERE member.workspace_id = ${input.actor.workspaceId}
            AND member.user_workos_id = ${input.actor.userId}
        )
      LIMIT 1
    `);
    return conversation ? mapConversation(conversation) : null;
  }

  async updateConversation(input: {
    actor: Actor;
    conversationId: string;
    command: { archived?: boolean; pinned?: boolean; markSeen?: true };
  }) {
    const now = this.options.now?.() ?? new Date();
    const archived = input.command.archived ?? null;
    const pinned = input.command.pinned ?? null;
    const markSeen = input.command.markSeen ?? null;
    const [row] = await this.rows<{ conversationId: string; transactionId: string }>(sql`
      WITH locked_owner AS MATERIALIZED (
        SELECT owner.workos_user_id
        FROM goat.users AS owner
        WHERE owner.workos_user_id = ${input.actor.userId}
        FOR UPDATE
      ),
      authorized AS MATERIALIZED (
        SELECT chat.id
        FROM goat.chat_sessions AS chat
        JOIN locked_owner ON locked_owner.workos_user_id = chat.user_workos_id
        WHERE chat.id = ${input.conversationId}
          AND chat.kind = 'chat'
          AND EXISTS (
            SELECT 1 FROM goat.workspace_members AS member
            WHERE member.workspace_id = ${input.actor.workspaceId}
              AND member.user_workos_id = ${input.actor.userId}
          )
          AND (
            NOT EXISTS (
              SELECT 1 FROM goat.codex_chat_sessions AS candidate
              WHERE candidate.chat_session_id = chat.id
            )
            OR EXISTS (
              SELECT 1 FROM goat.codex_chat_sessions AS candidate
              WHERE candidate.chat_session_id = chat.id
                AND candidate.user_workos_id = ${input.actor.userId}
                AND (
                  candidate.workspace_id IS NULL
                  OR candidate.workspace_id = ${input.actor.workspaceId}
                )
            )
          )
          AND (${pinned}::boolean IS NULL OR chat.closed_at IS NULL)
      ),
      updated_chat AS MATERIALIZED (
        UPDATE goat.chat_sessions AS chat
        SET closed_at = CASE
              WHEN ${archived}::boolean IS NULL THEN chat.closed_at
              WHEN ${archived}::boolean THEN COALESCE(chat.closed_at, ${now})
              ELSE NULL
            END,
            pinned_at = CASE
              WHEN ${pinned}::boolean IS NULL THEN chat.pinned_at
              WHEN ${pinned}::boolean THEN COALESCE(chat.pinned_at, ${now})
              ELSE NULL
            END,
            last_seen_at = CASE
              WHEN ${markSeen}::boolean IS TRUE
              THEN GREATEST(COALESCE(chat.last_seen_at, '-infinity'::timestamptz), ${now})
              ELSE chat.last_seen_at
            END,
            has_unseen = CASE
              WHEN ${markSeen}::boolean IS TRUE THEN false
              ELSE chat.has_unseen
            END,
            updated_at = CASE
              WHEN ${archived}::boolean IS NOT NULL
                AND (${archived}::boolean <> (chat.closed_at IS NOT NULL))
              THEN ${now}
              ELSE chat.updated_at
            END
        WHERE chat.id IN (SELECT id FROM authorized)
          AND (
            ${pinned}::boolean IS DISTINCT FROM TRUE
            OR chat.pinned_at IS NOT NULL
            OR (
              SELECT count(*)
              FROM goat.chat_sessions AS existing_pin
              WHERE existing_pin.user_workos_id = ${input.actor.userId}
                AND existing_pin.kind = 'chat'
                AND existing_pin.closed_at IS NULL
                AND existing_pin.pinned_at IS NOT NULL
                AND existing_pin.id <> chat.id
            ) < 20
          )
        RETURNING chat.id
      ),
      changed_turns AS MATERIALIZED (
        UPDATE goat.codex_chat_turns AS run
        SET status = CASE
              WHEN run.status IN ('queued', 'paused') THEN 'interrupted'
              ELSE run.status
            END,
            interrupt_requested_at = CASE
              WHEN run.status = 'running' THEN COALESCE(run.interrupt_requested_at, ${now})
              ELSE run.interrupt_requested_at
            END,
            completed_at = CASE
              WHEN run.status IN ('queued', 'paused') THEN ${now}
              ELSE run.completed_at
            END,
            event_sequence = run.event_sequence + 1,
            updated_at = ${now}
        WHERE ${archived}::boolean IS TRUE
          AND run.chat_session_id IN (SELECT id FROM updated_chat)
          AND run.user_workos_id = ${input.actor.userId}
          AND (
            run.status IN ('queued', 'paused')
            OR (run.status = 'running' AND run.interrupt_requested_at IS NULL)
          )
        RETURNING run.id, run.assistant_message_id, run.status, run.event_sequence
      ),
      canceled_approvals AS MATERIALIZED (
        UPDATE goat.run_approvals AS approval
        SET status = 'canceled',
            resolution = 'canceled',
            response = jsonb_build_object('resolution', 'canceled'),
            resolved_at = ${now},
            updated_at = ${now}
        WHERE approval.run_id IN (SELECT id FROM changed_turns)
          AND approval.status = 'pending'
        RETURNING approval.id, approval.run_id, approval.tool_call_id
      ),
      canceled_capabilities AS MATERIALIZED (
        UPDATE goat.capability_runs AS capability
        SET status = 'canceled',
            updated_at = ${now}
        FROM canceled_approvals AS approval
        JOIN goat.codex_chat_turns AS run ON run.id = approval.run_id
        WHERE capability.tool_call_id = approval.tool_call_id
          AND capability.chat_session_id = run.chat_session_id
          AND capability.user_workos_id = run.user_workos_id
          AND capability.workspace_id = ${input.actor.workspaceId}
          AND capability.status IN ('awaiting_approval', 'approved')
        RETURNING capability.id
      ),
      inserted_events AS (
        INSERT INTO goat.run_events (
          id, run_id, sequence, schema_version, type, payload, created_at
        )
        SELECT
          'run_event_' || gen_random_uuid()::text,
          changed.id,
          changed.event_sequence,
          1,
          CASE
            WHEN changed.status = 'interrupted' THEN 'run.canceled'
            ELSE 'run.cancel_requested'
          END,
          jsonb_build_object('by', 'user'),
          ${now}
        FROM changed_turns AS changed
        RETURNING run_id, sequence
      ),
      aborted_messages AS (
        UPDATE goat.chat_messages AS message
        SET debug_trace = COALESCE(
              message.debug_trace,
              '{"schemaVersion":"opencompany.chat.debug.v1","steps":[]}'::jsonb
            ) || jsonb_build_object('aborted', true),
            updated_at = ${now}
        FROM changed_turns AS changed
        WHERE changed.status = 'interrupted'
          AND message.id = changed.assistant_message_id
          AND message.role = 'assistant'
        RETURNING message.id
      ),
      closed_runtime AS (
        UPDATE goat.codex_chat_sessions AS runtime
        SET status = 'closed',
            active_turn_id = NULL,
            updated_at = ${now}
        WHERE ${archived}::boolean IS TRUE
          AND runtime.chat_session_id IN (SELECT id FROM updated_chat)
          AND runtime.user_workos_id = ${input.actor.userId}
        RETURNING runtime.id
      ),
      notified AS MATERIALIZED (
        SELECT pg_notify(
          ${RUN_EVENT_NOTIFY_CHANNEL},
          jsonb_build_object('runId', run_id, 'sequence', sequence)::text
        )
        FROM inserted_events
      )
      SELECT
        updated_chat.id AS "conversationId",
        pg_current_xact_id()::text AS "transactionId",
        (SELECT count(*) FROM notified) AS "notifyCount",
        (SELECT count(*) FROM canceled_capabilities) AS "capabilityCancelCount"
      FROM updated_chat
    `);
    return row ? { conversationId: row.conversationId, transactionId: row.transactionId } : null;
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
        reservation.assistant_message_id AS "assistantMessageId",
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
    const attachmentTextsJson = serializeAttachmentTexts(resolvedAttachments.attachmentTexts);
    const settingsJson = JSON.stringify({
      ...(input.command.settings ?? {}),
      ...(input.command.mentions?.length ? { mentions: input.command.mentions } : {}),
    });
    const resolvedMentionSkills = await this.resolveMentionedSkills(
      input.actor.workspaceId,
      input.command.mentions?.flatMap((mention) =>
        mention.kind === "skill" ? [mention.id] : [],
      ) ?? [],
    );
    const resolvedMentionSkillsJson = JSON.stringify(
      resolvedMentionSkills.map((skill) => ({
        bundle_id: skill.bundleId,
        source_kind: skill.sourceKind,
        plugin_id: skill.pluginId,
      })),
    );
    const runtimeModel = input.command.runtimeModel ?? input.command.model;
    const assistantDebugTrace =
      input.command.engine === "opencompany"
        ? {
            schemaVersion: "opencompany.chat.debug.v1",
            model: runtimeModel,
            steps: [],
            uiMessageParts: [],
          }
        : {
            schemaVersion: "goat.codex_chat.debug.v1",
            model: runtimeModel,
            uiMessageParts: [],
          };
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

    let reservations: CreateResultRow[];
    try {
      reservations = await this.rows<CreateResultRow>(sql`
      WITH membership AS MATERIALIZED (
        SELECT 1
        FROM goat.workspace_members
        WHERE workspace_id = ${input.actor.workspaceId}
          AND user_workos_id = ${input.actor.userId}
      ),
      authorized_existing AS MATERIALIZED (
        SELECT
          chat.id, chat.model, chat.kind, chat.user_workos_id AS owner_user_workos_id,
          task.id AS task_id
        FROM goat.chat_sessions AS chat
        LEFT JOIN goat.codex_chat_sessions AS runtime ON runtime.chat_session_id = chat.id
        LEFT JOIN goat.tasks AS task
          ON task.session_id = chat.id
         AND task.user_workos_id = chat.user_workos_id
        WHERE chat.id = ${input.command.conversationId ?? null}
          AND (
            (chat.kind = 'chat' AND chat.user_workos_id = ${input.actor.userId})
            OR (
              chat.kind = 'task'
              AND (
                task.workspace_id = ${input.actor.workspaceId}
                OR (
                  task.workspace_id IS NULL
                  AND task.user_workos_id = ${input.actor.userId}
                )
              )
              AND task.archived_at IS NULL
              AND task.status IN ('succeeded', 'failed', 'canceled')
            )
          )
          AND chat.engine = ${input.command.engine}
          AND chat.closed_at IS NULL
          AND (
            runtime.id IS NULL
            OR (
              runtime.user_workos_id = chat.user_workos_id
              AND runtime.engine = ${input.command.engine}
              AND (runtime.workspace_id IS NULL OR runtime.workspace_id = ${input.actor.workspaceId})
            )
          )
          AND EXISTS (SELECT 1 FROM membership)
      ),
      continued_task AS MATERIALIZED (
        UPDATE goat.tasks AS task
        SET status = 'queued',
            stage = 'queued',
            result = NULL,
            error = NULL,
            reported_outcome = NULL,
            outcome_comment = NULL,
            next_run_at = ${now},
            lease_id = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = ${now}
        FROM authorized_existing AS existing
        WHERE existing.kind = 'task'
          AND task.id = existing.task_id
          AND task.status IN ('succeeded', 'failed', 'canceled')
        RETURNING task.id
      ),
      admitted_existing AS MATERIALIZED (
        SELECT
          existing.id, existing.model, existing.owner_user_workos_id, existing.task_id
        FROM authorized_existing AS existing
        WHERE existing.kind = 'chat'
           OR existing.task_id IN (SELECT id FROM continued_task)
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
          AND (
            ${input.command.conversationId ?? null}::text IS NULL
            OR EXISTS (SELECT 1 FROM admitted_existing)
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
        RETURNING
          id, model, ${input.actor.userId}::text AS owner_user_workos_id,
          NULL::text AS task_id
      ),
      target_chat AS MATERIALIZED (
        SELECT id, model, owner_user_workos_id, task_id FROM created_chat
        UNION ALL
        SELECT id, model, owner_user_workos_id, task_id
        FROM admitted_existing WHERE EXISTS (SELECT 1 FROM winner)
      ),
      dismissed_approvals AS MATERIALIZED (
        UPDATE goat.run_approvals AS approval
        SET status = 'canceled',
            resolution = 'canceled',
            response = jsonb_build_object('resolution', 'canceled'),
            resolved_at = ${now},
            updated_at = ${now}
        FROM goat.codex_chat_turns AS paused, target_chat AS chat
        WHERE approval.run_id = paused.id
          AND approval.status = 'pending'
          AND paused.chat_session_id = chat.id
          AND paused.user_workos_id = chat.owner_user_workos_id
          AND paused.status = 'paused'
        RETURNING approval.id, approval.run_id, approval.tool_call_id
      ),
      dismissed_capabilities AS MATERIALIZED (
        UPDATE goat.capability_runs AS capability
        SET status = 'canceled',
            updated_at = ${now}
        FROM dismissed_approvals AS approval
        JOIN goat.codex_chat_turns AS paused ON paused.id = approval.run_id
        WHERE capability.tool_call_id = approval.tool_call_id
          AND capability.chat_session_id = paused.chat_session_id
          AND capability.user_workos_id = paused.user_workos_id
          AND capability.workspace_id = ${input.actor.workspaceId}
          AND capability.status IN ('awaiting_approval', 'approved')
        RETURNING capability.id
      ),
      dismissed_approval_messages AS MATERIALIZED (
        UPDATE goat.chat_messages AS message
        SET debug_trace = jsonb_set(
              message.debug_trace,
              '{uiMessageParts}',
              COALESCE(
                (
                  SELECT jsonb_agg(
                    CASE
                      WHEN part.value ->> 'state' = 'approval-requested'
                        AND part.value -> 'approval' ->> 'id' IN (
                          SELECT dismissed.id
                          FROM dismissed_approvals AS dismissed
                          WHERE dismissed.run_id = paused.id
                        )
                      THEN part.value || jsonb_build_object(
                        'state', 'output-denied',
                        'approval', (part.value -> 'approval') || jsonb_build_object(
                          'approved', false,
                          'reason', 'The user continued without responding to this approval.'
                        )
                      )
                      ELSE part.value
                    END
                    ORDER BY part.ordinality
                  )
                  FROM jsonb_array_elements(
                    COALESCE(message.debug_trace -> 'uiMessageParts', '[]'::jsonb)
                  ) WITH ORDINALITY AS part(value, ordinality)
                ),
                '[]'::jsonb
              )
            ),
            updated_at = ${now}
        FROM goat.codex_chat_turns AS paused
        WHERE message.id = paused.assistant_message_id
          AND message.role = 'assistant'
          AND message.debug_trace IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM dismissed_approvals AS dismissed
            WHERE dismissed.run_id = paused.id
          )
        RETURNING paused.id AS run_id
      ),
      canceled_paused_runs AS MATERIALIZED (
        UPDATE goat.codex_chat_turns AS paused
        SET status = 'interrupted',
            completed_at = ${now},
            event_sequence = paused.event_sequence + 1,
            updated_at = ${now}
        FROM target_chat AS chat
        WHERE paused.chat_session_id = chat.id
          AND paused.user_workos_id = chat.owner_user_workos_id
          AND paused.status = 'paused'
          AND (
            NOT EXISTS (
              SELECT 1 FROM dismissed_approvals AS dismissed
              WHERE dismissed.run_id = paused.id
            )
            OR EXISTS (
              SELECT 1 FROM dismissed_approval_messages AS message
              WHERE message.run_id = paused.id
            )
          )
        RETURNING paused.id, paused.event_sequence
      ),
      canceled_pause_events AS MATERIALIZED (
        INSERT INTO goat.run_events (
          id, run_id, sequence, schema_version, type, payload, created_at
        )
        SELECT
          'run_event_' || gen_random_uuid()::text,
          canceled.id,
          canceled.event_sequence,
          1,
          'run.canceled',
          jsonb_build_object('by', 'user'),
          ${now}
        FROM canceled_paused_runs AS canceled
        RETURNING run_id, sequence
      ),
      upserted_runtime AS MATERIALIZED (
        INSERT INTO goat.codex_chat_sessions (
          id, user_workos_id, chat_session_id, engine, model, workspace_id,
          host_tool_contract_version, active_turn_id, status, created_at, updated_at
        )
        SELECT
          ${runtimeId}, target_chat.owner_user_workos_id, target_chat.id, ${input.command.engine},
          ${runtimeModel}, ${input.actor.workspaceId},
          CASE WHEN target_chat.task_id IS NULL
            THEN ${
              input.command.engine === "opencompany"
                ? CHAT_HOST_TOOL_CONTRACT_VERSION
                : ACTION_HOST_TOOL_CONTRACT_VERSION
            }
            ELSE NULL
          END,
          ${runId}, 'queued', ${now}, ${now}
        FROM target_chat
        ON CONFLICT (chat_session_id) DO UPDATE
        SET workspace_id = COALESCE(goat.codex_chat_sessions.workspace_id, EXCLUDED.workspace_id),
            host_tool_contract_version = COALESCE(
              EXCLUDED.host_tool_contract_version,
              goat.codex_chat_sessions.host_tool_contract_version
            ),
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
          id, session_id, role, content, task_id, attachments, attachment_texts,
          created_at, updated_at
        )
        SELECT
          reservation.message_id, target_chat.id, 'user', ${input.command.content},
          target_chat.task_id, ${attachmentsJson}::jsonb, ${attachmentTextsJson}::jsonb,
          ${now}, ${now}
        FROM winner AS reservation
        JOIN target_chat ON true
        JOIN upserted_runtime ON upserted_runtime.chat_session_id = target_chat.id
        WHERE (SELECT COUNT(*) FROM claimed_attachments) = ${attachmentIds.length}
        RETURNING id
      ),
      captured_chat_plugins AS MATERIALIZED (
        INSERT INTO goat.chat_session_plugins (chat_session_id, plugin_id)
        SELECT target_chat.id, plugin.id
        FROM inserted_user_message
        JOIN target_chat ON true
        JOIN upserted_runtime ON upserted_runtime.chat_session_id = target_chat.id
        JOIN goat.plugins AS plugin
          ON plugin.workspace_id = ${input.actor.workspaceId}
         AND plugin.status = 'enabled'
        WHERE ${input.command.engine !== "opencompany"}::boolean
          AND NOT EXISTS (
            SELECT 1
            FROM goat.codex_chat_turns AS prior_coding_turn
            WHERE prior_coding_turn.chat_session_id = target_chat.id
          )
        ON CONFLICT (chat_session_id, plugin_id) DO NOTHING
        RETURNING plugin_id
      ),
      activated_skill_bundles AS MATERIALIZED (
        INSERT INTO goat.chat_session_skill_bundles (
          chat_session_id, bundle_id, name, activated_message_id, source_kind
        )
        SELECT
          target_chat.id, bundle.id, bundle.name, inserted_user_message.id,
          resolved_skill.source_kind
        FROM inserted_user_message
        JOIN target_chat ON true
        CROSS JOIN jsonb_to_recordset(
          ${resolvedMentionSkillsJson}::jsonb
        ) AS resolved_skill(bundle_id text, source_kind text)
        JOIN goat.skill_bundles AS bundle
          ON bundle.id = resolved_skill.bundle_id
         AND bundle.workspace_id = ${input.actor.workspaceId}
        WHERE NOT EXISTS (
            SELECT 1
            FROM goat.chat_session_skill_bundles AS fixed
            JOIN goat.skill_bundles AS fixed_bundle ON fixed_bundle.id = fixed.bundle_id
            WHERE fixed.chat_session_id = target_chat.id
              AND fixed_bundle.name = bundle.name
        )
        ON CONFLICT (chat_session_id, name) DO NOTHING
        RETURNING bundle_id
      ),
      captured_activated_skill_plugins AS MATERIALIZED (
        INSERT INTO goat.chat_session_plugins (chat_session_id, plugin_id)
        SELECT target_chat.id, plugin.id
        FROM activated_skill_bundles AS activated
        JOIN target_chat ON true
        CROSS JOIN jsonb_to_recordset(
          ${resolvedMentionSkillsJson}::jsonb
        ) AS resolved_skill(bundle_id text, source_kind text, plugin_id text)
        JOIN goat.plugin_skills AS plugin_skill
          ON plugin_skill.workspace_id = ${input.actor.workspaceId}
         AND plugin_skill.plugin_id = resolved_skill.plugin_id
         AND plugin_skill.skill_bundle_id = activated.bundle_id
        JOIN goat.plugins AS plugin
          ON plugin.id = plugin_skill.plugin_id
         AND plugin.workspace_id = plugin_skill.workspace_id
         AND plugin.status = 'enabled'
        WHERE resolved_skill.source_kind = 'plugin'
          AND resolved_skill.bundle_id = activated.bundle_id
        ON CONFLICT (chat_session_id, plugin_id) DO NOTHING
        RETURNING plugin_id
      ),
      inserted_assistant_message AS (
        INSERT INTO goat.chat_messages (
          id, session_id, role, content, task_id, debug_trace, created_at, updated_at
        )
        SELECT
          reservation.assistant_message_id, target_chat.id, 'assistant', '',
          target_chat.task_id,
          ${JSON.stringify(assistantDebugTrace)}::jsonb,
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
            reservation.run_id, target_chat.owner_user_workos_id,
            upserted_runtime.id, target_chat.id,
          reservation.message_id, reservation.assistant_message_id, 'queued',
          ${input.command.content}, ${settingsJson}::jsonb, 1, ${now}, ${now}
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
        JOIN target_chat ON true
        RETURNING id, run_id, sequence
      ),
      notified AS MATERIALIZED (
        SELECT pg_notify(
          ${RUN_EVENT_NOTIFY_CHANNEL},
          jsonb_build_object('runId', run_id, 'sequence', sequence)::text
        )
        FROM (
          SELECT run_id, sequence FROM inserted_event
          UNION ALL
          SELECT run_id, sequence FROM canceled_pause_events
        ) AS event
      ),
      updated_chat AS (
        UPDATE goat.chat_sessions AS chat
        SET updated_at = ${now}, last_seen_at = ${now}, has_unseen = false
        FROM target_chat, inserted_run
        WHERE chat.id = target_chat.id
        RETURNING chat.id
      )
      SELECT
        reservation.command_id AS "commandId",
        reservation.request_hash AS "requestHash",
        reservation.conversation_id AS "conversationId",
        reservation.message_id AS "messageId",
        reservation.assistant_message_id AS "assistantMessageId",
        reservation.run_id AS "runId",
        reservation.transaction_id AS "transactionId",
        reservation.command_id <> ${commandId} AS replayed,
        CASE
          WHEN reservation.command_id <> ${commandId} OR EXISTS (SELECT 1 FROM inserted_run)
            THEN true
          ELSE jsonb_array_length(jsonb_build_object('reason', 'unmaterialized')) = 0
        END AS materialized,
        (SELECT count(*) FROM notified) AS "notifyCount",
        (SELECT count(*) FROM dismissed_capabilities) AS "capabilityCancelCount"
      FROM reservation
      `);
    } catch (error) {
      if (attachmentIds.length > 0 && isUnmaterializedGuardError(error)) {
        throw new CoreError("invalid_argument", "An attachment is unavailable or has expired.");
      }
      throw error;
    }
    const [reservation] = reservations;

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
        AND (
          (chat.kind = 'chat' AND run.user_workos_id = ${input.actor.userId})
          OR (
            chat.kind = 'task'
            AND EXISTS (
              SELECT 1 FROM goat.tasks AS task
              WHERE task.session_id = chat.id
                AND task.user_workos_id = run.user_workos_id
                AND (
                  task.workspace_id = ${input.actor.workspaceId}
                  OR (
                    task.workspace_id IS NULL
                    AND task.user_workos_id = ${input.actor.userId}
                  )
                )
            )
          )
        )
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
        SELECT run.id, task.id AS task_id
        FROM goat.codex_chat_turns AS run
        JOIN goat.codex_chat_sessions AS runtime ON runtime.id = run.codex_chat_session_id
        JOIN goat.chat_sessions AS chat ON chat.id = run.chat_session_id
        LEFT JOIN goat.tasks AS task
          ON task.session_id = chat.id
         AND task.user_workos_id = run.user_workos_id
         AND (task.workspace_id = runtime.workspace_id OR task.workspace_id IS NULL)
        WHERE run.id = ${input.runId}
          AND runtime.workspace_id = ${input.actor.workspaceId}
          AND (
            (chat.kind = 'chat' AND run.user_workos_id = ${input.actor.userId})
            OR (
              chat.kind = 'task'
              AND task.id IS NOT NULL
              AND (
                task.workspace_id = ${input.actor.workspaceId}
                OR (
                  task.workspace_id IS NULL
                  AND task.user_workos_id = ${input.actor.userId}
                )
              )
            )
          )
          AND EXISTS (
            SELECT 1 FROM goat.workspace_members AS member
            WHERE member.workspace_id = ${input.actor.workspaceId}
              AND member.user_workos_id = ${input.actor.userId}
          )
      ),
      changed AS (
        UPDATE goat.codex_chat_turns AS run
        SET status = CASE WHEN run.status IN ('queued', 'paused') THEN 'interrupted' ELSE run.status END,
            interrupt_requested_at = CASE
              WHEN run.status = 'running' THEN ${now}
              ELSE run.interrupt_requested_at
            END,
            completed_at = CASE
              WHEN run.status IN ('queued', 'paused') THEN ${now}
              ELSE run.completed_at
            END,
            event_sequence = run.event_sequence + 1,
            updated_at = ${now}
        WHERE run.id IN (SELECT id FROM authorized)
          AND (
            run.status IN ('queued', 'paused')
            OR (run.status = 'running' AND run.interrupt_requested_at IS NULL)
          )
        RETURNING run.id, run.status, run.event_sequence
      ),
      canceled_approvals AS MATERIALIZED (
        UPDATE goat.run_approvals AS approval
        SET status = 'canceled',
            resolution = 'canceled',
            response = jsonb_build_object('resolution', 'canceled'),
            resolved_at = ${now},
            updated_at = ${now}
        WHERE approval.run_id IN (SELECT id FROM changed WHERE status = 'interrupted')
          AND approval.status = 'pending'
        RETURNING approval.id, approval.run_id, approval.tool_call_id
      ),
      canceled_capabilities AS MATERIALIZED (
        UPDATE goat.capability_runs AS capability
        SET status = 'canceled',
            updated_at = ${now}
        FROM canceled_approvals AS approval
        JOIN goat.codex_chat_turns AS run ON run.id = approval.run_id
        WHERE capability.tool_call_id = approval.tool_call_id
          AND capability.chat_session_id = run.chat_session_id
          AND capability.user_workos_id = run.user_workos_id
          AND capability.workspace_id = ${input.actor.workspaceId}
          AND capability.status IN ('awaiting_approval', 'approved')
        RETURNING capability.id
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
      canceled_task AS (
        UPDATE goat.tasks AS task
        SET status = 'canceled',
            stage = 'canceled',
            error = 'Stopped by user.',
            lease_id = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = ${now}
        FROM authorized, changed
        WHERE authorized.id = changed.id
          AND task.id = authorized.task_id
          AND task.status IN ('queued', 'running')
        RETURNING task.id
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
              AND pending.status IN ('queued', 'running', 'paused')
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
        (SELECT count(*) FROM notified) AS "notifyCount",
        (SELECT count(*) FROM canceled_capabilities) AS "capabilityCancelCount"
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
      answer?: string | EngineQuestionAnswer;
    };
  }): Promise<ResolveApprovalResult | null> {
    if (typeof input.command.answer === "object") {
      return this.resolveEngineQuestionApproval({
        actor: input.actor,
        runId: input.command.runId,
        approvalId: input.command.approvalId,
        answer: input.command.answer,
      });
    }
    const now = this.options.now?.() ?? new Date();
    const eventId = (this.options.ids ?? defaultIds).event();
    const response = { resolution: input.command.resolution, answer: input.command.answer };
    const approvalResponse = {
      id: input.command.approvalId,
      approved: input.command.resolution === "approved",
      ...(input.command.resolution === "approved"
        ? {}
        : {
            reason:
              typeof input.command.answer === "string" ? input.command.answer : "Denied by user.",
          }),
    };
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
          AND runtime.workspace_id = ${input.actor.workspaceId}
          AND (
            (chat.kind = 'chat' AND run.user_workos_id = ${input.actor.userId})
            OR (
              chat.kind = 'task'
              AND EXISTS (
                SELECT 1 FROM goat.tasks AS task
                WHERE task.session_id = chat.id
                  AND task.user_workos_id = run.user_workos_id
                  AND (
                    task.workspace_id = ${input.actor.workspaceId}
                    OR (
                      task.workspace_id IS NULL
                      AND task.user_workos_id = ${input.actor.userId}
                    )
                  )
              )
            )
          )
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
        RETURNING approval.id, approval.run_id, approval.tool_call_id
      ),
      transitioned_capability AS MATERIALIZED (
        UPDATE goat.capability_runs AS capability
        SET status = CASE
              WHEN ${input.command.resolution === "approved"}::boolean THEN 'approved'
              ELSE 'canceled'
            END,
            approved_at = CASE
              WHEN ${input.command.resolution === "approved"}::boolean THEN ${now}
              ELSE capability.approved_at
            END,
            updated_at = ${now}
        FROM changed
        JOIN goat.codex_chat_turns AS approved_run ON approved_run.id = changed.run_id
        WHERE capability.tool_call_id = changed.tool_call_id
          AND capability.chat_session_id = approved_run.chat_session_id
          AND capability.user_workos_id = approved_run.user_workos_id
          AND capability.workspace_id = ${input.actor.workspaceId}
          AND ${
            input.command.resolution === "approved" ||
            input.command.resolution === "denied" ||
            input.command.resolution === "canceled"
          }::boolean
          AND (
            (${input.command.resolution === "approved"}::boolean
              AND capability.status = 'awaiting_approval'
              AND capability.approval_expires_at > ${now})
            OR
            (${input.command.resolution !== "approved"}::boolean
              AND capability.status IN ('awaiting_approval', 'approved')
              AND capability.approval_expires_at > ${now})
          )
        RETURNING capability.id
      ),
      rewritten_assistant AS MATERIALIZED (
        UPDATE goat.chat_messages AS message
        SET debug_trace = jsonb_set(
              message.debug_trace,
              '{uiMessageParts}',
              COALESCE(
                (
                  SELECT jsonb_agg(
                    CASE
                      WHEN part.value ->> 'state' = 'approval-requested'
                        AND part.value -> 'approval' ->> 'id' = ${input.command.approvalId}
                      THEN part.value || jsonb_build_object(
                        'state', 'approval-responded',
                        'approval', ${JSON.stringify(approvalResponse)}::jsonb
                      )
                      ELSE part.value
                    END
                    ORDER BY part.ordinality
                  )
                  FROM jsonb_array_elements(
                    COALESCE(message.debug_trace -> 'uiMessageParts', '[]'::jsonb)
                  ) WITH ORDINALITY AS part(value, ordinality)
                ),
                '[]'::jsonb
              )
            ),
            updated_at = ${now}
        FROM changed
        JOIN goat.codex_chat_turns AS run ON run.id = changed.run_id
        WHERE message.id = run.assistant_message_id
          AND message.role = 'assistant'
          AND message.debug_trace IS NOT NULL
        RETURNING message.id
      ),
      advanced_run AS MATERIALIZED (
        UPDATE goat.codex_chat_turns AS run
        SET event_sequence = run.event_sequence + 1,
            status = CASE
              WHEN EXISTS (
                SELECT 1
                FROM goat.run_approvals AS pending
                WHERE pending.run_id = run.id
                  AND pending.status = 'pending'
                  AND pending.id NOT IN (SELECT id FROM changed)
              ) THEN 'paused'
              ELSE 'queued'
            END,
            settings = CASE
              WHEN EXISTS (
                SELECT 1
                FROM goat.run_approvals AS pending
                WHERE pending.run_id = run.id
                  AND pending.status = 'pending'
                  AND pending.id NOT IN (SELECT id FROM changed)
              ) THEN run.settings
              ELSE jsonb_set(run.settings, '{approvalContinuation}', 'true'::jsonb, true)
            END,
            updated_at = ${now}
        WHERE run.id = ${input.command.runId}
          AND run.status = 'paused'
          AND EXISTS (SELECT 1 FROM changed)
          AND EXISTS (SELECT 1 FROM rewritten_assistant)
        RETURNING run.id, run.event_sequence, run.status, run.codex_chat_session_id
      ),
      queued_runtime AS MATERIALIZED (
        UPDATE goat.codex_chat_sessions AS runtime
        SET status = 'queued',
            active_turn_id = run.id,
            error = NULL,
            updated_at = ${now}
        FROM advanced_run AS run
        WHERE runtime.id = run.codex_chat_session_id
          AND run.status = 'queued'
        RETURNING runtime.id
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
        (SELECT count(*) FROM notified) AS "notifyCount",
        (SELECT count(*) FROM transitioned_capability) AS "capabilityTransitionCount"
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

  private async resolveEngineQuestionApproval(input: {
    actor: Actor;
    runId: string;
    approvalId: string;
    answer: EngineQuestionAnswer;
  }): Promise<ResolveApprovalResult | null> {
    const [current] = await this.rows<{
      request: Record<string, unknown>;
      response: Record<string, unknown> | null;
      status: string;
    }>(sql`
      SELECT interaction.request, approval.response, interaction.status
      FROM goat.codex_chat_interactions AS interaction
      JOIN goat.run_approvals AS approval
        ON approval.id = interaction.id
       AND approval.run_id = interaction.codex_chat_turn_id
      JOIN goat.codex_chat_turns AS run ON run.id = interaction.codex_chat_turn_id
      JOIN goat.codex_chat_sessions AS runtime ON runtime.id = run.codex_chat_session_id
      JOIN goat.chat_sessions AS chat ON chat.id = run.chat_session_id
      WHERE interaction.id = ${input.approvalId}
        AND run.id = ${input.runId}
        AND runtime.workspace_id = ${input.actor.workspaceId}
        AND chat.kind = 'chat'
        AND chat.user_workos_id = ${input.actor.userId}
        AND run.user_workos_id = ${input.actor.userId}
        AND chat.closed_at IS NULL
        AND EXISTS (
          SELECT 1 FROM goat.workspace_members AS member
          WHERE member.workspace_id = ${input.actor.workspaceId}
            AND member.user_workos_id = ${input.actor.userId}
        )
      LIMIT 1
    `);
    if (!current) return null;
    const answers = normalizeEngineQuestionAnswers(current.request, input.answer.answers);
    const canonicalAnswer = { type: "engine_questions", schemaVersion: 1, answers } as const;
    const storedAnswer = current.response?.answer;
    if (current.status === "resolved") {
      if (JSON.stringify(storedAnswer) !== JSON.stringify(canonicalAnswer)) {
        throw new CoreError(
          "idempotency_conflict",
          "The approval was already resolved differently.",
        );
      }
      return {
        approvalId: input.approvalId,
        runId: input.runId,
        resolution: "answered",
        idempotentReplay: true,
      };
    }
    if (current.status !== "pending") {
      throw new CoreError("conflict", "This engine question is no longer waiting.");
    }

    const now = this.options.now?.() ?? new Date();
    const interactionResponse = { answers };
    const approvalResponse = { resolution: "answered", answer: canonicalAnswer };
    const [changed] = await this.rows<{ id: string }>(sql`
      WITH resolved_interaction AS MATERIALIZED (
        UPDATE goat.codex_chat_interactions AS interaction
        SET status = 'resolved',
            response = ${JSON.stringify(interactionResponse)}::jsonb,
            resolved_at = ${now},
            updated_at = ${now}
        WHERE interaction.id = ${input.approvalId}
          AND interaction.codex_chat_turn_id = ${input.runId}
          AND interaction.status = 'pending'
          AND EXISTS (
            SELECT 1 FROM goat.codex_chat_turns AS run
            WHERE run.id = interaction.codex_chat_turn_id
              AND run.status = 'running'
              AND run.lease_id = interaction.lease_id
          )
        RETURNING interaction.id
      )
      UPDATE goat.run_approvals AS approval
      SET status = 'resolved',
          resolution = 'answered',
          response = ${JSON.stringify(approvalResponse)}::jsonb,
          resolved_at = ${now},
          updated_at = ${now}
      WHERE approval.id IN (SELECT id FROM resolved_interaction)
        AND approval.run_id = ${input.runId}
        AND approval.status = 'pending'
      RETURNING approval.id
    `);
    if (!changed) {
      throw new CoreError("conflict", "This engine question is no longer waiting.");
    }
    return {
      approvalId: input.approvalId,
      runId: input.runId,
      resolution: "answered",
      idempotentReplay: false,
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

  private async resolveMentionedSkills(
    workspaceId: string,
    mentionedSkillIds: readonly string[],
  ): Promise<ResolvedWorkspaceSkill[]> {
    const skillIds = [...new Set(mentionedSkillIds)];
    if (skillIds.length === 0) return [];
    const skillIdList = sql.join(
      skillIds.map((id) => sql`${id}`),
      sql`, `,
    );
    const candidates = await this.rows<ResolvedWorkspaceSkill>(sql`
      SELECT
        installation.name AS id,
        bundle.id AS "bundleId",
        bundle.name,
        bundle.description,
        bundle.body,
        'standalone'::text AS "sourceKind",
        installation.id AS "installationId",
        NULL::text AS "pluginId",
        NULL::text AS "pluginName"
      FROM goat.skill_installations AS installation
      JOIN goat.skill_bundles AS bundle
        ON bundle.id = installation.bundle_id
       AND bundle.workspace_id = installation.workspace_id
      WHERE installation.workspace_id = ${workspaceId}
        AND installation.enabled
        AND installation.archived_at IS NULL
        AND installation.name IN (${skillIdList})
      UNION ALL
      SELECT
        plugin_skill.skill_name AS id,
        bundle.id AS "bundleId",
        bundle.name,
        bundle.description,
        bundle.body,
        'plugin'::text AS "sourceKind",
        NULL::text AS "installationId",
        plugin.id AS "pluginId",
        plugin.name AS "pluginName"
      FROM goat.plugin_skills AS plugin_skill
      JOIN goat.plugins AS plugin
        ON plugin.id = plugin_skill.plugin_id
       AND plugin.workspace_id = plugin_skill.workspace_id
      JOIN goat.skill_bundles AS bundle
        ON bundle.id = plugin_skill.skill_bundle_id
       AND bundle.workspace_id = plugin_skill.workspace_id
      WHERE plugin_skill.workspace_id = ${workspaceId}
        AND plugin.status = 'enabled'
        AND plugin_skill.skill_name IN (${skillIdList})
    `);
    return resolveSkillCandidates(
      candidates.filter((candidate) => candidate.sourceKind === "standalone"),
      candidates.filter((candidate) => candidate.sourceKind === "plugin"),
    ).skills;
  }

  private async rows<Row>(query: SQL): Promise<Row[]> {
    return rowsFromExecute<Row>(await this.execute(query));
  }
}

function normalizeEngineQuestionAnswers(
  request: Record<string, unknown>,
  rawAnswers: Readonly<Record<string, { answers: readonly string[] }>>,
) {
  const questions = Array.isArray(request.questions) ? request.questions : [];
  const expectedIds = questions.flatMap((question) => {
    if (!question || typeof question !== "object" || Array.isArray(question)) return [];
    const id = (question as Record<string, unknown>).id;
    return typeof id === "string" && id.trim() ? [id] : [];
  });
  if (
    expectedIds.length === 0 ||
    expectedIds.length !== questions.length ||
    new Set(expectedIds).size !== expectedIds.length ||
    Object.keys(rawAnswers).some((id) => !expectedIds.includes(id))
  ) {
    throw new CoreError("invalid_argument", "The engine question is invalid.");
  }
  return Object.fromEntries(
    expectedIds.map((id) => {
      const answers = rawAnswers[id]?.answers.map((answer) => answer.trim()).filter(Boolean) ?? [];
      if (answers.length === 0 || answers.length > 8) {
        throw new CoreError("invalid_argument", "Answer every engine question.");
      }
      return [id, { answers }];
    }),
  );
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
      previous_attempt AS MATERIALIZED (
        SELECT attempt.deploy_version
        FROM goat.run_attempts AS attempt
        INNER JOIN fenced_run ON fenced_run.id = attempt.run_id
        WHERE attempt.lease_id IS DISTINCT FROM ${input.leaseId}
        ORDER BY attempt.number DESC
        LIMIT 1
      ),
      abandoned AS (
        UPDATE goat.run_attempts AS attempt
        SET status = 'abandoned',
            error_code = 'lease_reclaimed',
            error_message = 'The worker lease expired and execution was reclaimed.',
            completed_at = ${startedAt}
        WHERE attempt.run_id IN (SELECT id FROM fenced_run)
          AND attempt.status = 'running'
          AND attempt.lease_id IS DISTINCT FROM ${input.leaseId}
        RETURNING attempt.id
      ),
      inserted AS (
        INSERT INTO goat.run_attempts (
          id, run_id, number, status, worker_id, deploy_version, lease_id, started_at, created_at
        )
        SELECT
          ${input.attemptId}, fenced_run.id, fenced_run.attempts, 'running',
          ${input.worker.workerId}, ${input.worker.deployVersion ?? null}, ${input.leaseId},
          ${startedAt}, ${startedAt}
        FROM fenced_run
        LEFT JOIN (SELECT COUNT(*) AS abandoned_count FROM abandoned) AS recovery ON TRUE
        ON CONFLICT DO NOTHING
        RETURNING *
      )
      SELECT inserted.*, previous_attempt.deploy_version AS previous_deploy_version
      FROM inserted
      LEFT JOIN previous_attempt ON true
      UNION ALL
      SELECT attempt.*, previous_attempt.deploy_version AS previous_deploy_version
      FROM goat.run_attempts AS attempt
      JOIN fenced_run ON fenced_run.id = attempt.run_id
      LEFT JOIN previous_attempt ON true
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

  async pauseForApprovals(input: Parameters<RunExecutionRepository["pauseForApprovals"]>[0]) {
    if (input.approvals.length === 0) return [];
    const pausedAt = this.now();
    const eventDrafts = [
      ...input.approvals.map((approval) => ({
        id: `run_event_${randomUUID()}`,
        type: "approval.requested",
        payload: {
          approvalId: approval.id,
          toolCallId: approval.toolCallId,
          kind: approval.kind,
          prompt: approval.prompt,
          ...(approval.action ? { action: approval.action } : {}),
          ...(approval.options ? { options: approval.options } : {}),
        },
      })),
      {
        id: `run_event_${randomUUID()}`,
        type: "run.paused",
        payload: { reason: "approval_required" },
      },
    ];
    const rows = await this.rows<RunApprovalRow>(sql`
      WITH fenced_attempt AS MATERIALIZED (
        SELECT attempt.id, attempt.run_id
        FROM goat.run_attempts AS attempt
        JOIN goat.codex_chat_turns AS run ON run.id = attempt.run_id
        WHERE attempt.id = ${input.attemptId}
          AND attempt.run_id = ${input.runId}
          AND attempt.status = 'running'
          AND attempt.lease_id = ${input.leaseId}
          AND attempt.worker_id = ${input.worker.workerId}
          AND run.status = 'running'
          AND run.lease_id = ${input.leaseId}
          AND run.lease_owner = ${input.worker.workerId}
      ),
      approval_input AS MATERIALIZED (
        SELECT
          item.value ->> 'id' AS id,
          item.value ->> 'toolCallId' AS tool_call_id,
          item.value ->> 'kind' AS kind,
          item.value ->> 'prompt' AS prompt,
          item.value -> 'options' AS options,
          item.ordinality
        FROM jsonb_array_elements(${JSON.stringify(input.approvals)}::jsonb)
          WITH ORDINALITY AS item(value, ordinality)
      ),
      inserted_approvals AS MATERIALIZED (
        INSERT INTO goat.run_approvals (
          id, run_id, attempt_id, tool_call_id, kind, prompt, options, status, created_at, updated_at
        )
        SELECT
          approval.id, fenced.run_id, fenced.id, approval.tool_call_id, approval.kind, approval.prompt,
          approval.options, 'pending', ${pausedAt}, ${pausedAt}
        FROM approval_input AS approval
        CROSS JOIN fenced_attempt AS fenced
        WHERE NOT EXISTS (
          SELECT 1
          FROM goat.run_approvals AS existing
          JOIN approval_input AS requested ON requested.id = existing.id
        )
        ON CONFLICT DO NOTHING
        RETURNING *
      ),
      finished_attempt AS MATERIALIZED (
        UPDATE goat.run_attempts AS attempt
        SET status = 'completed', completed_at = ${pausedAt}
        FROM fenced_attempt AS fenced
        WHERE attempt.id = fenced.id
          AND (SELECT COUNT(*) FROM inserted_approvals) = ${input.approvals.length}
        RETURNING attempt.id
      ),
      paused_run AS MATERIALIZED (
        UPDATE goat.codex_chat_turns AS run
        SET status = 'paused',
            lease_id = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL,
            event_sequence = run.event_sequence + ${eventDrafts.length},
            updated_at = ${pausedAt}
        FROM fenced_attempt AS fenced
        WHERE run.id = fenced.run_id
          AND EXISTS (SELECT 1 FROM finished_attempt)
          AND EXISTS (
            SELECT 1
            FROM goat.codex_chat_sessions AS runtime
            WHERE runtime.id = run.codex_chat_session_id
          )
        RETURNING run.id, run.event_sequence - ${eventDrafts.length} AS base_sequence,
                  run.codex_chat_session_id
      ),
      event_input AS MATERIALIZED (
        SELECT
          item.value ->> 'id' AS id,
          item.value ->> 'type' AS type,
          item.value -> 'payload' AS payload,
          item.ordinality
        FROM jsonb_array_elements(${JSON.stringify(eventDrafts)}::jsonb)
          WITH ORDINALITY AS item(value, ordinality)
      ),
      inserted_events AS MATERIALIZED (
        INSERT INTO goat.run_events (
          id, run_id, attempt_id, sequence, schema_version, type, payload, created_at
        )
        SELECT
          event.id, run.id, ${input.attemptId}, run.base_sequence + event.ordinality,
          1, event.type, event.payload, ${pausedAt}
        FROM event_input AS event
        CROSS JOIN paused_run AS run
        RETURNING run_id, sequence
      ),
      idled_runtime AS MATERIALIZED (
        UPDATE goat.codex_chat_sessions AS runtime
        SET status = 'idle', active_turn_id = NULL, updated_at = ${pausedAt}
        FROM paused_run AS run
        WHERE runtime.id = run.codex_chat_session_id
        RETURNING runtime.id, runtime.chat_session_id
      ),
      updated_chat AS MATERIALIZED (
        UPDATE goat.chat_sessions AS chat
        SET has_unseen = true, updated_at = ${pausedAt}
        FROM idled_runtime AS runtime
        WHERE chat.id = runtime.chat_session_id
        RETURNING chat.id
      ),
      notified AS MATERIALIZED (
        SELECT pg_notify(
          ${RUN_EVENT_NOTIFY_CHANNEL},
          jsonb_build_object('runId', run_id, 'sequence', max(sequence))::text
        )
        FROM inserted_events
        GROUP BY run_id
      )
      SELECT approval.*
      FROM inserted_approvals AS approval
      WHERE (SELECT COUNT(*) FROM inserted_events) = ${eventDrafts.length}
        AND EXISTS (SELECT 1 FROM idled_runtime)
        AND EXISTS (SELECT 1 FROM updated_chat)
        AND EXISTS (SELECT 1 FROM notified)
      ORDER BY approval.created_at ASC, approval.id ASC
    `);
    return rows.map(mapRunApproval);
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
  runtimeStatus: NonNullable<Conversation["runtime"]>["status"] | null;
  activeRunId: string | null;
  runtimeHasError: boolean | null;
  runtimeUpdatedAt: Date | string | null;
  activityState: Conversation["activityState"];
  hasUnseen: boolean;
  pinnedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

type MessageRow = {
  id: string;
  conversationId: string;
  role: Message["role"];
  content: string;
  attachments: ChatMessageAttachment[] | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

type MessagePageRow = {
  authorizedConversationId: string;
  id: string | null;
  conversationId: string | null;
  role: Message["role"] | null;
  content: string | null;
  attachments: ChatMessageAttachment[] | null;
  createdAt: Date | string | null;
  updatedAt: Date | string | null;
};

type LegacyRunStatus = "queued" | "running" | "paused" | "completed" | "failed" | "interrupted";
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
  deploy_version?: string | null;
  deployVersion?: string | null;
  previous_deploy_version?: string | null;
  previousDeployVersion?: string | null;
  started_at?: Date | string;
  startedAt?: Date | string;
  completed_at?: Date | string | null;
  completedAt?: Date | string | null;
  error_code?: string | null;
  errorCode?: string | null;
  error_message?: string | null;
  errorMessage?: string | null;
};

type RunApprovalRow = {
  id: string;
  runId?: string;
  run_id?: string;
  attemptId?: string | null;
  attempt_id?: string | null;
  toolCallId?: string | null;
  tool_call_id?: string | null;
  kind: string;
  prompt: string;
  options: string[] | null;
  status: RunApproval["status"];
  resolution: RunApproval["resolution"];
  response: Record<string, unknown> | null;
  createdAt?: Date | string;
  created_at?: Date | string;
  updatedAt?: Date | string;
  updated_at?: Date | string;
  resolvedAt?: Date | string | null;
  resolved_at?: Date | string | null;
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
  format: ChatMessageAttachment["kind"];
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
  assistantMessageId: string;
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
  assistantMessageId: string | null;
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
    !row.assistantMessageId ||
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
      assistantMessageId: row.assistantMessageId,
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
    assistantMessageId: row.assistantMessageId,
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
      AND runtime.workspace_id = ${actor.workspaceId}
      AND (
        (chat.kind = 'chat' AND run.user_workos_id = ${actor.userId})
        OR (
          chat.kind = 'task'
          AND EXISTS (
            SELECT 1 FROM goat.tasks AS task
            WHERE task.session_id = chat.id
              AND task.user_workos_id = run.user_workos_id
              AND (
                task.workspace_id = ${actor.workspaceId}
                OR (
                  task.workspace_id IS NULL
                  AND task.user_workos_id = ${actor.userId}
                )
              )
          )
        )
      )
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
    runtime:
      row.runtimeStatus !== null && row.runtimeHasError !== null && row.runtimeUpdatedAt !== null
        ? {
            status: row.runtimeStatus,
            activeRunId: row.activeRunId,
            hasError: row.runtimeHasError,
            updatedAt: asDate(row.runtimeUpdatedAt),
          }
        : null,
    activityState: row.activityState,
    hasUnseen: row.hasUnseen,
    pinnedAt: row.pinnedAt === null ? null : asDate(row.pinnedAt),
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
    payload: mapRunEventPayload(row.type, row.payload),
    createdAt: asDate(row.createdAt ?? (row as unknown as { created_at: string }).created_at),
  };
}

function mapRunEventPayload(
  type: RunEvent["type"],
  payload: Record<string, unknown>,
): Readonly<Record<string, unknown>> {
  if (type !== "run.queued") return payload;

  // The canonical Task cutover briefly persisted a Task association in this payload. A Task is
  // metadata around the Run's Conversation, not part of the versioned Run Event contract. Project
  // the canonical fields explicitly so those durable rows remain streamable without a backfill.
  return {
    conversationId: payload.conversationId,
    triggerMessageId: payload.triggerMessageId,
  };
}

function serializeAttachmentTexts(
  attachmentTexts: ResolvedChatAttachments["attachmentTexts"],
): string | null {
  return attachmentTexts && Object.keys(attachmentTexts).length > 0
    ? JSON.stringify(attachmentTexts)
    : null;
}

function mapRunAttempt(row: RunAttemptRow): RunAttempt {
  return {
    id: row.id,
    runId: row.runId ?? row.run_id ?? "",
    number: row.number,
    status: row.status,
    workerId: row.workerId ?? row.worker_id ?? "",
    deployVersion: row.deployVersion ?? row.deploy_version ?? null,
    previousDeployVersion: row.previousDeployVersion ?? row.previous_deploy_version ?? null,
    startedAt: asDate(row.startedAt ?? row.started_at ?? new Date(0)),
    completedAt:
      (row.completedAt ?? row.completed_at)
        ? asDate(row.completedAt ?? row.completed_at ?? new Date(0))
        : null,
    errorCode: row.errorCode ?? row.error_code ?? null,
    errorMessage: row.errorMessage ?? row.error_message ?? null,
  };
}

function mapRunApproval(row: RunApprovalRow): RunApproval {
  return {
    id: row.id,
    runId: row.runId ?? row.run_id ?? "",
    attemptId: row.attemptId ?? row.attempt_id ?? null,
    toolCallId: row.toolCallId ?? row.tool_call_id ?? null,
    kind: row.kind,
    prompt: row.prompt,
    options: row.options,
    status: row.status,
    resolution: row.resolution,
    response: row.response,
    createdAt: asDate(row.createdAt ?? row.created_at ?? new Date(0)),
    updatedAt: asDate(row.updatedAt ?? row.updated_at ?? new Date(0)),
    resolvedAt:
      (row.resolvedAt ?? row.resolved_at)
        ? asDate(row.resolvedAt ?? row.resolved_at ?? new Date(0))
        : null,
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

function toPublicAttachment(attachment: ChatMessageAttachment): MessageAttachment {
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
        runtimeModel: command.runtimeModel ?? null,
        settings: command.settings ?? {},
        attachmentIds: command.attachmentIds ?? [],
        mentions: command.mentions ?? [],
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

function isUnmaterializedGuardError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const record = error as { code?: unknown; message?: unknown };
  return (
    record.code === "22023" ||
    (typeof record.message === "string" &&
      record.message.includes("cannot get array length of a non-array"))
  );
}
