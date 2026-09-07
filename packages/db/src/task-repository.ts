import { createHash, randomUUID } from "node:crypto";
import {
  claudeCodeCliModelNameForModelId,
  codexCliModelNameForModelId,
  getAgentModelDefinition,
  hostToolContractVersionForEngine,
  isCodexModelId,
  resolveAvailableAgentModelId,
} from "@opencompany/agent-runtime";
import type { AgentModelId } from "@opencompany/agent-runtime/types";
import {
  type Actor,
  CoreError,
  type CreateTaskCommand,
  type CreateTaskCommentCommand,
  type CreateTaskCommentResult,
  type CreateTaskResult,
  type LegacyTask,
  type LegacyTaskHistory,
  type Task,
  type TaskPage,
  type TaskRepository,
  type TaskSource,
  type TaskStatus,
  type TaskSummary,
  type UpdateTaskCommand,
  type UpdateTaskResult,
} from "@opencompany/core";
import { type SQL, sql } from "drizzle-orm";
import {
  type ChatAttachmentResolver,
  type ChatSqlExecute,
  type ResolvedChatAttachments,
  RUN_EVENT_NOTIFY_CHANNEL,
} from "./chat-repository";
import { stringifyPostgresJson } from "./postgres-json";
import type { HarnessSpec } from "./product-schema";

export type TaskRepositoryIdFactory = {
  command(): string;
  task(): string;
  conversation(): string;
  message(): string;
  runtime(): string;
  run(): string;
  event(): string;
};

const defaultIds: TaskRepositoryIdFactory = {
  command: () => `task_command_${randomUUID()}`,
  task: () => `task_${randomUUID()}`,
  conversation: () => `conversation_${randomUUID()}`,
  message: () => `message_${randomUUID()}`,
  runtime: () => `runtime_${randomUUID()}`,
  run: () => `run_${randomUUID()}`,
  event: () => `event_${randomUUID()}`,
};

type PostgresTaskRepositoryOptions = {
  ids?: TaskRepositoryIdFactory;
  resolveAttachments?: ChatAttachmentResolver;
  resolveHarness?: (input: {
    actor: Actor;
    command: CreateTaskCommand & { model: AgentModelId };
  }) => Promise<HarnessSpec>;
  compatibility?: {
    resolvedAttachments?: ResolvedChatAttachments;
    brainRef?: string | null;
    workflowBrainRef?: string | null;
    initialMessageContent?: string;
  };
  now?: () => Date;
};

export class PostgresTaskRepository implements TaskRepository {
  constructor(
    private readonly execute: ChatSqlExecute,
    private readonly options: PostgresTaskRepositoryOptions = {},
  ) {}

  async listTasks(input: {
    actor: Actor;
    cursor?: string;
    limit: number;
    archived: boolean;
  }): Promise<TaskPage> {
    const cursor = decodeTaskCursor(input.cursor);
    const rows = await this.rows<TaskRow>(sql`
      SELECT
        task.id,
        task.display_id AS "displayId",
        task.name,
        task.prompt AS goal,
        task.session_id AS "conversationId",
        task.status,
        task.source,
        conversation.engine,
        task.model,
        task.workflow_id AS "workflowId",
        task.schedule_id AS "scheduleId",
        task.scheduled_for AS "scheduledFor",
        task.result,
        task.error,
        task.reported_outcome AS "reportedStatus",
        task.outcome_comment AS "outcomeComment",
        task.archived_at AS "archivedAt",
        task.created_at AS "createdAt",
        task.updated_at AS "updatedAt"
      FROM goat.tasks AS task
      JOIN goat.chat_sessions AS conversation
        ON conversation.id = task.session_id
       AND conversation.kind = 'task'
      WHERE ${taskAccessPredicate(input.actor)}
        AND CASE WHEN ${input.archived}::boolean
          THEN task.archived_at IS NOT NULL
          ELSE task.archived_at IS NULL
        END
        AND (
          ${cursor?.updatedAt ?? null}::timestamptz IS NULL
          OR (task.updated_at, task.id) < (
            ${cursor?.updatedAt ?? null}::timestamptz,
            ${cursor?.id ?? null}::text
          )
        )
      ORDER BY task.updated_at DESC, task.id DESC
      LIMIT ${input.limit + 1}
    `);
    const tasks = rows.slice(0, input.limit).map(mapTask);
    const last = tasks.at(-1);
    return {
      tasks,
      nextCursor:
        rows.length > input.limit && last ? encodeTaskCursor(last.updatedAt, last.id) : null,
    };
  }

  async getTask(input: { actor: Actor; taskId: string }): Promise<Task | null> {
    const [row] = await this.rows<TaskRow>(sql`
      ${taskSelect()}
      WHERE (
          task.id = ${input.taskId}
          OR upper(task.display_id) = upper(${input.taskId})
        )
        AND ${taskAccessPredicate(input.actor)}
      LIMIT 1
    `);
    return row ? mapTask(row) : null;
  }

  async getTaskSummary(input: { actor: Actor; taskId: string }): Promise<TaskSummary | null> {
    const [row] = await this.rows<TaskSummaryRow>(sql`
      WITH selected_task AS MATERIALIZED (
        SELECT
          task.id,
          task.user_workos_id,
          task.session_id,
          task.status,
          task.archived_at
        FROM goat.tasks AS task
        WHERE (
            task.id = ${input.taskId}
            OR upper(task.display_id) = upper(${input.taskId})
          )
          AND ${taskAccessPredicate(input.actor)}
        LIMIT 1
      ),
      task_conversations AS MATERIALIZED (
        SELECT task.session_id AS conversation_id
        FROM selected_task AS task
        WHERE task.session_id IS NOT NULL
        UNION
        SELECT DISTINCT message.session_id
        FROM goat.chat_messages AS message
        JOIN selected_task AS task ON message.task_id = task.id
      )
      SELECT
        task.status,
        task.archived_at AS "archivedAt",
        CASE WHEN task.session_id IS NOT NULL THEN (
          SELECT SUM(
            CASE
              WHEN jsonb_typeof(message.debug_trace->'durationMs') = 'number'
                THEN (message.debug_trace->>'durationMs')::bigint
              ELSE NULL
            END
          )
          FROM goat.chat_messages AS message
          WHERE message.session_id IN (SELECT conversation_id FROM task_conversations)
            AND message.role = 'assistant'
        ) ELSE NULL END AS "runDurationMs",
        CASE WHEN task.session_id IS NULL THEN (
          SELECT MIN(message.created_at)
          FROM goat.task_messages AS message
          WHERE message.task_id = task.id
            AND message.user_workos_id = task.user_workos_id
            AND message.role <> 'user'
        ) ELSE NULL END AS "runStartedAt",
        CASE WHEN task.session_id IS NULL THEN (
          SELECT MAX(message.completed_at)
          FROM goat.task_messages AS message
          WHERE message.task_id = task.id
            AND message.user_workos_id = task.user_workos_id
        ) ELSE NULL END AS "runCompletedAt",
        CASE WHEN task.session_id IS NOT NULL THEN (
          SELECT COUNT(*)
          FROM goat.credit_ledger AS ledger
          WHERE ledger.chat_session_id IN (SELECT conversation_id FROM task_conversations)
            AND ledger.user_workos_id = task.user_workos_id
            AND ledger.amount_usd_micros < 0
        ) ELSE (
          (SELECT COUNT(*) FROM goat.task_model_usage AS usage
            WHERE usage.task_id = task.id AND usage.user_workos_id = task.user_workos_id)
          + (SELECT COUNT(*) FROM goat.task_tool_usage AS usage
            WHERE usage.task_id = task.id AND usage.user_workos_id = task.user_workos_id)
          + (SELECT COUNT(*) FROM goat.task_sandbox_usage AS usage
            WHERE usage.task_id = task.id AND usage.user_workos_id = task.user_workos_id)
        ) END AS "usageRowCount",
        CASE WHEN task.session_id IS NOT NULL THEN (
          SELECT COALESCE(SUM(-ledger.amount_usd_micros), 0)
          FROM goat.credit_ledger AS ledger
          WHERE ledger.chat_session_id IN (SELECT conversation_id FROM task_conversations)
            AND ledger.user_workos_id = task.user_workos_id
            AND ledger.amount_usd_micros < 0
        ) ELSE (
          (SELECT COALESCE(SUM(usage.total_cost_usd_micros), 0)
            FROM goat.task_model_usage AS usage
            WHERE usage.task_id = task.id AND usage.user_workos_id = task.user_workos_id)
          + (SELECT COALESCE(SUM(usage.total_cost_usd_micros), 0)
            FROM goat.task_tool_usage AS usage
            WHERE usage.task_id = task.id AND usage.user_workos_id = task.user_workos_id)
          + (SELECT COALESCE(SUM(usage.total_cost_usd_micros), 0)
            FROM goat.task_sandbox_usage AS usage
            WHERE usage.task_id = task.id AND usage.user_workos_id = task.user_workos_id)
        ) END AS "totalCostUsdMicros"
      FROM selected_task AS task
    `);
    if (!row) return null;

    const terminal =
      row.archivedAt !== null ||
      ["waiting", "succeeded", "failed", "canceled"].includes(row.status);
    const recordedDurationMs = nullableNumber(row.runDurationMs);
    const startedAt = nullableTimestamp(row.runStartedAt);
    const completedAt = nullableTimestamp(row.runCompletedAt);
    const durationMs = !terminal
      ? null
      : recordedDurationMs !== null
        ? Math.max(0, recordedDurationMs)
        : startedAt !== null && completedAt !== null
          ? Math.max(0, completedAt - startedAt)
          : null;
    const usageRowCount = Number(row.usageRowCount);
    const totalCostUsdMicros = Number(row.totalCostUsdMicros);
    return {
      cost: {
        hasRecordedCosts: Number.isFinite(usageRowCount) && usageRowCount > 0,
        totalCostUsdMicros: Number.isFinite(totalCostUsdMicros)
          ? Math.max(0, totalCostUsdMicros)
          : 0,
      },
      durationMs,
    };
  }

  async listLegacyTasks(input: { actor: Actor; limit: number }): Promise<LegacyTask[]> {
    const rows = await this.rows<LegacyTaskRow>(sql`
      ${legacyTaskSelect()}
      WHERE task.session_id IS NULL
        AND ${taskAccessPredicate(input.actor)}
      ORDER BY task.updated_at DESC, task.id DESC
      LIMIT ${input.limit}
    `);
    return rows.map(mapLegacyTask);
  }

  async getLegacyTaskHistory(input: {
    actor: Actor;
    taskId: string;
  }): Promise<LegacyTaskHistory | null> {
    const [taskRow] = await this.rows<LegacyTaskRow>(sql`
      ${legacyTaskSelect()}
      WHERE task.session_id IS NULL
        AND (
          task.id = ${input.taskId}
          OR upper(task.display_id) = upper(${input.taskId})
        )
        AND ${taskAccessPredicate(input.actor)}
      LIMIT 1
    `);
    if (!taskRow) return null;

    const [messages, events] = await Promise.all([
      this.rows<LegacyTaskMessageRow>(sql`
        SELECT
          message.id,
          message.role,
          message.status,
          message.content,
          message.tool_name AS "toolName",
          message.tool_call_id AS "toolCallId",
          message.created_at AS "createdAt",
          message.updated_at AS "updatedAt",
          message.completed_at AS "completedAt"
        FROM goat.task_messages AS message
        WHERE message.task_id = ${taskRow.id}
          AND message.user_workos_id = ${taskRow.actorId}
        ORDER BY message.created_at ASC, message.id ASC
      `),
      this.rows<LegacyTaskEventRow>(sql`
        SELECT
          event.id,
          event.message_id AS "messageId",
          event.type,
          event.payload,
          event.created_at AS "createdAt"
        FROM goat.task_events AS event
        WHERE event.task_id = ${taskRow.id}
          AND event.user_workos_id = ${taskRow.actorId}
        ORDER BY event.id ASC
      `),
    ]);
    return {
      task: mapLegacyTask(taskRow),
      messages: messages.map((message) => ({
        ...message,
        createdAt: asDate(message.createdAt),
        updatedAt: asDate(message.updatedAt),
        completedAt: nullableDate(message.completedAt),
      })),
      events: events.map((event) => ({
        ...event,
        createdAt: asDate(event.createdAt),
      })),
    };
  }

  async getTaskByConversation(input: {
    actor: Actor;
    conversationId: string;
  }): Promise<Task | null> {
    const [row] = await this.rows<TaskRow>(sql`
      ${taskSelect()}
      WHERE task.session_id = ${input.conversationId}
        AND ${taskAccessPredicate(input.actor)}
      LIMIT 1
    `);
    return row ? mapTask(row) : null;
  }

  async createTaskAndRun(input: {
    actor: Actor;
    command: CreateTaskCommand;
  }): Promise<CreateTaskResult> {
    const requestHash = hashTaskCommand(input.command);
    const [preflight] = await this.rows<TaskCreateRow>(sql`
      WITH actor_scope AS MATERIALIZED (
        SELECT "user".task_spawning_enabled AS "featureEnabled"
        FROM goat.users AS "user"
        JOIN goat.workspace_members AS member
          ON member.user_workos_id = "user".workos_user_id
         AND member.workspace_id = ${input.actor.workspaceId}
        WHERE "user".workos_user_id = ${input.actor.userId}
      )
      SELECT
        EXISTS (SELECT 1 FROM actor_scope) AS authorized,
        COALESCE((SELECT "featureEnabled" FROM actor_scope), false) AS "featureEnabled",
        reservation.command_id AS "commandId",
        reservation.request_hash AS "requestHash",
        reservation.task_id AS "taskId",
        reservation.conversation_id AS "reservedConversationId",
        reservation.message_id AS "messageId",
        reservation.assistant_message_id AS "assistantMessageId",
        reservation.run_id AS "runId",
        reservation.transaction_id AS "transactionId",
        true AS replayed,
        EXISTS (
          SELECT 1
          FROM goat.tasks AS task
          JOIN goat.codex_chat_turns AS run ON run.id = reservation.run_id
          WHERE task.id = reservation.task_id
            AND task.session_id = reservation.conversation_id
            AND run.chat_session_id = reservation.conversation_id
            AND run.user_message_id = reservation.message_id
            AND run.assistant_message_id = reservation.assistant_message_id
        ) AS materialized,
        task.id,
        task.display_id AS "displayId",
        task.name,
        task.prompt AS goal,
        task.session_id AS "taskConversationId",
        task.status,
        task.source,
        conversation.engine,
        task.model,
        task.workflow_id AS "workflowId",
        task.schedule_id AS "scheduleId",
        task.scheduled_for AS "scheduledFor",
        task.result,
        task.error,
        task.reported_outcome AS "reportedStatus",
        task.outcome_comment AS "outcomeComment",
        task.archived_at AS "archivedAt",
        task.created_at AS "createdAt",
        task.updated_at AS "updatedAt"
      FROM (SELECT 1) AS singleton
      LEFT JOIN goat.task_command_idempotency AS reservation
        ON reservation.user_workos_id = ${input.actor.userId}
       AND reservation.workspace_id = ${input.actor.workspaceId}
       AND reservation.idempotency_key = ${input.command.idempotencyKey}
       AND EXISTS (SELECT 1 FROM actor_scope)
      LEFT JOIN goat.tasks AS task ON task.id = reservation.task_id
      LEFT JOIN goat.chat_sessions AS conversation ON conversation.id = task.session_id
      LIMIT 1
    `);
    if (!preflight?.authorized) {
      throw new CoreError("not_found", "Workspace membership not found.");
    }
    if (preflight.commandId) {
      return taskCreateResult(preflight, requestHash);
    }
    if (!preflight.featureEnabled) {
      throw new CoreError("forbidden", "Tasks & Workflows is disabled for this actor.");
    }

    const resolvedAttachments =
      this.options.compatibility?.resolvedAttachments ??
      (await this.resolveAttachments(input.actor, input.command.attachmentIds ?? []));
    const attachmentsRequireClaim = !this.options.compatibility?.resolvedAttachments;
    const ids = this.options.ids ?? defaultIds;
    const commandId = ids.command();
    const taskId = ids.task();
    const conversationId = ids.conversation();
    const messageId = ids.message();
    const assistantMessageId = ids.message();
    const runtimeId = ids.runtime();
    const runId = ids.run();
    const eventId = ids.event();
    const activityId = `task_activity_${randomUUID()}`;
    const now = this.options.now?.() ?? new Date();
    const assistantCreatedAt = new Date(now.getTime() + 1);
    const initialMessageContent =
      this.options.compatibility?.initialMessageContent ?? input.command.goal;
    const requestedModel = getAgentModelDefinition(input.command.model)?.id;
    const model =
      requestedModel && input.command.engine === "opencompany"
        ? resolveAvailableAgentModelId(requestedModel)
        : requestedModel;
    const runtimeModel = model ? runtimeModelName(input.command.engine, model) : null;
    if (!runtimeModel || !model) {
      throw new CoreError("invalid_argument", `Unsupported ${input.command.engine} Task model.`);
    }
    const normalizedCommand = { ...input.command, model };
    const attachments = resolvedAttachments.attachments;
    const attachmentTexts = resolvedAttachments.attachmentTexts;
    const attachmentIds = input.command.attachmentIds ?? [];
    const attachmentIdList = attachmentIds.length
      ? sql.join(
          attachmentIds.map((id) => sql`${id}`),
          sql`, `,
        )
      : sql`NULL`;
    const harness = this.options.resolveHarness
      ? await this.options.resolveHarness({
          actor: input.actor,
          command: normalizedCommand,
        })
      : defaultHarness(normalizedCommand);
    validateHarness(harness, normalizedCommand, initialMessageContent);
    const assistantDebugTrace = {
      schemaVersion:
        input.command.engine === "opencompany"
          ? "opencompany.chat.debug.v1"
          : "goat.codex_chat.debug.v1",
      model: runtimeModel,
      uiMessageParts: [],
    };

    let rows: TaskCreateRow[];
    try {
      rows = await this.rows<TaskCreateRow>(sql`
        WITH actor_scope AS MATERIALIZED (
          SELECT
            "user".workos_user_id,
            "user".task_spawning_enabled AS feature_enabled
          FROM goat.users AS "user"
          JOIN goat.workspace_members AS member
            ON member.user_workos_id = "user".workos_user_id
           AND member.workspace_id = ${input.actor.workspaceId}
          WHERE "user".workos_user_id = ${input.actor.userId}
          FOR UPDATE OF "user"
        ),
        enabled_task_plugins AS MATERIALIZED (
          SELECT COALESCE(jsonb_agg(plugin.id ORDER BY plugin.id), '[]'::jsonb) AS plugin_ids
          FROM goat.plugins AS plugin
          WHERE plugin.workspace_id = ${input.actor.workspaceId}
            AND plugin.status = 'enabled'
        ),
        prior AS MATERIALIZED (
          SELECT *
          FROM goat.task_command_idempotency
          WHERE user_workos_id = ${input.actor.userId}
            AND workspace_id = ${input.actor.workspaceId}
            AND idempotency_key = ${input.command.idempotencyKey}
        ),
        locked_attachment_commands AS MATERIALIZED (
          -- Completion and cleanup also lock keyed commands before their upload row.
          SELECT command.command_id
          FROM goat.chat_attachment_upload_commands AS command
          WHERE command.attachment_id IN (${attachmentIdList})
          FOR UPDATE
        ),
        eligible_attachments AS MATERIALIZED (
          SELECT upload.id
          FROM goat.chat_attachment_uploads AS upload
          WHERE ${attachmentsRequireClaim}::boolean
            AND upload.user_workos_id = ${input.actor.userId}
            AND upload.workspace_id = ${input.actor.workspaceId}
            AND upload.claimed_at IS NULL
            AND upload.expires_at > ${now}
            AND upload.id IN (${attachmentIdList})
            AND EXISTS (SELECT 1 FROM actor_scope)
            AND (SELECT count(*) FROM locked_attachment_commands) >= 0
          FOR UPDATE
        ),
        reservation AS MATERIALIZED (
          INSERT INTO goat.task_command_idempotency (
            command_id, user_workos_id, workspace_id, idempotency_key, request_hash,
            task_id, conversation_id, message_id, assistant_message_id, runtime_id, run_id,
            created_at, touched_at
          )
          SELECT
            ${commandId}, ${input.actor.userId}, ${input.actor.workspaceId},
            ${input.command.idempotencyKey}, ${requestHash}, ${taskId}, ${conversationId},
            ${messageId}, ${assistantMessageId}, ${runtimeId}, ${runId}, ${now}, ${now}
          FROM actor_scope
          WHERE actor_scope.feature_enabled = true OR EXISTS (SELECT 1 FROM prior)
          ON CONFLICT (user_workos_id, workspace_id, idempotency_key)
          DO UPDATE SET touched_at = EXCLUDED.touched_at
          RETURNING *
        ),
        winner AS MATERIALIZED (
          SELECT * FROM reservation WHERE command_id = ${commandId}
        ),
        resolved_brain AS MATERIALIZED (
          SELECT brain.id
          FROM goat.brains AS brain
          WHERE brain.workspace_id = ${input.actor.workspaceId}
            AND (
              ${this.options.compatibility?.brainRef ?? null}::text IS NULL
              OR brain.id = ${this.options.compatibility?.brainRef ?? null}
            )
            AND EXISTS (SELECT 1 FROM winner)
          ORDER BY
            CASE WHEN brain.id = ${this.options.compatibility?.brainRef ?? null} THEN 0 ELSE 1 END,
            CASE WHEN brain.slug = 'general' THEN 0 ELSE 1 END,
            brain.created_at ASC,
            brain.id ASC
          LIMIT 1
        ),
        created_conversation AS MATERIALIZED (
          INSERT INTO goat.chat_sessions (
            id, user_workos_id, title, model, engine, kind, created_at, updated_at
          )
          SELECT
            winner.conversation_id, ${input.actor.userId}, ${input.command.name},
            ${model}, ${input.command.engine}, 'task', ${now}, ${assistantCreatedAt}
          FROM winner
          RETURNING id
        ),
        created_task AS MATERIALIZED (
          INSERT INTO goat.tasks (
            id, name, user_workos_id, workspace_id, prompt, source, model, session_id,
            schedule_id, scheduled_for, workflow_id, workflow_brain_ref,
            status, stage, next_run_at,
            harness_spec, created_at, updated_at
          )
          SELECT
            winner.task_id, ${input.command.name}, ${input.actor.userId},
            ${input.actor.workspaceId}, ${input.command.goal}, ${input.command.source},
            ${model}, conversation.id, ${input.command.scheduleId ?? null},
            ${input.command.scheduledFor ?? null}, ${input.command.workflowId ?? null},
            ${this.options.compatibility?.workflowBrainRef ?? null},
            'queued', 'queued', ${now},
            CASE WHEN ${stringifyPostgresJson(harness)}::jsonb ? 'workflow'
              THEN jsonb_set(
                ${stringifyPostgresJson(harness)}::jsonb,
                '{workflow,pluginIds}',
                (SELECT plugin_ids FROM enabled_task_plugins),
                true
              )
              ELSE ${stringifyPostgresJson(harness)}::jsonb
            END,
            ${now}, ${now}
          FROM winner
          JOIN created_conversation AS conversation ON conversation.id = winner.conversation_id
          RETURNING *
        ),
        created_activity AS MATERIALIZED (
          INSERT INTO goat.task_activities (
            id, task_id, author, author_workos_id, kind, metadata, created_at
          )
          SELECT
            ${activityId}, task.id, 'user', ${input.actor.userId}, 'created',
            jsonb_strip_nulls(jsonb_build_object(
              'source', task.source,
              'workflowId', task.workflow_id,
              'scheduleId', task.schedule_id,
              'scheduledFor', task.scheduled_for
            )),
            ${now}
          FROM created_task AS task
          RETURNING id
        ),
        selected_task AS MATERIALIZED (
          SELECT created.*
          FROM created_task AS created
          UNION ALL
          SELECT existing.*
          FROM goat.tasks AS existing
          JOIN reservation ON reservation.task_id = existing.id
          WHERE NOT EXISTS (SELECT 1 FROM created_task)
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
        terminal_attachment_commands AS MATERIALIZED (
          UPDATE goat.chat_attachment_upload_commands AS command
          SET claimed_at = ${now},
              cleaned_at = ${now},
              touched_at = ${now}
          FROM claimed_attachments AS upload
          WHERE command.attachment_id = upload.id
            AND command.claimed_at IS NULL
            AND command.cleaned_at IS NULL
          RETURNING command.command_id
        ),
        inserted_user_message AS MATERIALIZED (
          INSERT INTO goat.chat_messages (
            id, session_id, role, content, attachments, attachment_texts, created_at, updated_at
          )
          SELECT
            winner.message_id, task.session_id, 'user', ${initialMessageContent},
            ${attachmentsJson(attachments)}::jsonb, ${attachmentTextsJson(attachmentTexts)}::jsonb,
            ${now}, ${now}
          FROM winner
          JOIN created_task AS task ON task.id = winner.task_id
          WHERE (
            NOT ${attachmentsRequireClaim}::boolean
            OR (SELECT COUNT(*) FROM claimed_attachments) = ${attachmentIds.length}
          )
          RETURNING id
        ),
        inserted_assistant_message AS MATERIALIZED (
          INSERT INTO goat.chat_messages (
            id, session_id, role, content, debug_trace, created_at, updated_at
          )
          SELECT
            winner.assistant_message_id, task.session_id, 'assistant', '',
            ${stringifyPostgresJson(assistantDebugTrace)}::jsonb, ${assistantCreatedAt}, ${assistantCreatedAt}
          FROM winner
          JOIN created_task AS task ON task.id = winner.task_id
          RETURNING id
        ),
        inserted_runtime AS MATERIALIZED (
          INSERT INTO goat.codex_chat_sessions (
            id, user_workos_id, chat_session_id, engine, model, brain_ref, workspace_id,
            host_tool_contract_version, active_turn_id, status, created_at, updated_at
          )
          SELECT
            winner.runtime_id, ${input.actor.userId}, task.session_id, ${input.command.engine},
            ${runtimeModel}, (SELECT id FROM resolved_brain), ${input.actor.workspaceId},
            ${hostToolContractVersionForEngine(input.command.engine)},
            winner.run_id, 'queued', ${now}, ${now}
          FROM winner
          JOIN created_task AS task ON task.id = winner.task_id
          RETURNING id
        ),
        inserted_run AS MATERIALIZED (
          INSERT INTO goat.codex_chat_turns (
            id, user_workos_id, codex_chat_session_id, chat_session_id, user_message_id,
            assistant_message_id, status, prompt, settings, event_sequence, created_at, updated_at
          )
          SELECT
            winner.run_id, ${input.actor.userId}, runtime.id, task.session_id,
            winner.message_id, winner.assistant_message_id, 'queued', ${initialMessageContent},
            ${stringifyPostgresJson(turnSettingsFromHarness(harness))}::jsonb, 1, ${now}, ${now}
          FROM winner
          JOIN created_task AS task ON task.id = winner.task_id
          JOIN inserted_runtime AS runtime ON true
          JOIN inserted_user_message AS user_message ON user_message.id = winner.message_id
          JOIN inserted_assistant_message AS assistant_message
            ON assistant_message.id = winner.assistant_message_id
          RETURNING id
        ),
        inserted_event AS MATERIALIZED (
          INSERT INTO goat.run_events (
            id, run_id, sequence, schema_version, type, payload, created_at
          )
          SELECT
            ${eventId}, run.id, 1, 1, 'run.queued',
            jsonb_build_object(
              'conversationId', winner.conversation_id,
              'triggerMessageId', winner.message_id
            ),
            ${now}
          FROM inserted_run AS run
          JOIN winner ON winner.run_id = run.id
          RETURNING run_id, sequence
        ),
        notified AS MATERIALIZED (
          SELECT pg_notify(
            ${RUN_EVENT_NOTIFY_CHANNEL},
            jsonb_build_object('runId', run_id, 'sequence', sequence)::text
          )
          FROM inserted_event
        )
        SELECT
          EXISTS (SELECT 1 FROM actor_scope) AS authorized,
          COALESCE((SELECT feature_enabled FROM actor_scope), false) AS "featureEnabled",
          reservation.command_id AS "commandId",
          reservation.request_hash AS "requestHash",
          reservation.task_id AS "taskId",
          reservation.conversation_id AS "reservedConversationId",
          reservation.message_id AS "messageId",
          reservation.assistant_message_id AS "assistantMessageId",
          reservation.run_id AS "runId",
          reservation.transaction_id AS "transactionId",
          reservation.command_id <> ${commandId} AS replayed,
          CASE
            WHEN reservation.command_id <> ${commandId}
              OR (
                EXISTS (SELECT 1 FROM inserted_run)
                AND EXISTS (SELECT 1 FROM created_activity)
              )
              THEN true
            ELSE jsonb_array_length(jsonb_build_object('reason', 'unmaterialized')) = 0
          END AS materialized,
          task.id,
          task.display_id AS "displayId",
          task.name,
          task.prompt AS goal,
          task.session_id AS "taskConversationId",
          task.status,
          task.source,
          ${input.command.engine}::text AS engine,
          task.model,
          task.workflow_id AS "workflowId",
          task.schedule_id AS "scheduleId",
          task.scheduled_for AS "scheduledFor",
          task.result,
          task.error,
          task.reported_outcome AS "reportedStatus",
          task.outcome_comment AS "outcomeComment",
          task.archived_at AS "archivedAt",
          task.created_at AS "createdAt",
          task.updated_at AS "updatedAt",
          (SELECT count(*) FROM notified) AS "notifyCount",
          (SELECT count(*) FROM terminal_attachment_commands) AS "terminalAttachmentCommandCount"
        FROM actor_scope
        LEFT JOIN reservation ON true
        LEFT JOIN selected_task AS task ON task.id = reservation.task_id
      `);
    } catch (error) {
      if (attachmentIds.length > 0 && isUnmaterializedGuardError(error)) {
        throw new CoreError("invalid_argument", "An attachment is unavailable or has expired.");
      }
      throw error;
    }

    const [row] = rows;
    if (!row?.authorized) throw new CoreError("not_found", "Workspace membership not found.");
    if (!row.commandId) {
      if (!row.featureEnabled) {
        throw new CoreError("forbidden", "Tasks & Workflows is disabled for this actor.");
      }
      throw new Error("The Task command reservation was not materialized.");
    }
    if (row.replayed && !row.id) {
      return this.createTaskAndRun(input);
    }
    return taskCreateResult(row, requestHash);
  }

  async createTaskCommentAndRun(input: {
    actor: Actor;
    taskId: string;
    command: CreateTaskCommentCommand;
  }): Promise<CreateTaskCommentResult | null> {
    const [preflight] = await this.rows<{ idExists: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM goat.task_activities WHERE id = ${input.command.id}
      ) AS "idExists"
    `);
    const attachmentIds = input.command.attachmentIds ?? [];
    const resolvedAttachments = preflight?.idExists
      ? { attachments: [], attachmentTexts: null }
      : await this.resolveAttachments(input.actor, attachmentIds);
    const attachmentsRequireClaim = !preflight?.idExists;
    const attachmentIdList = attachmentIds.length
      ? sql.join(
          attachmentIds.map((id) => sql`${id}`),
          sql`, `,
        )
      : sql`NULL`;
    const ids = this.options.ids ?? defaultIds;
    const messageId = ids.message();
    const assistantMessageId = ids.message();
    const runId = ids.run();
    const eventId = ids.event();
    const statusActivityId = `task_activity_${randomUUID()}`;
    const now = this.options.now?.() ?? new Date();
    const assistantCreatedAt = new Date(now.getTime() + 1);
    const statusChangedAt = new Date(now.getTime() + 2);
    let rows: TaskCommentCreateRow[];
    try {
      rows = await this.rows<TaskCommentCreateRow>(sql`
      WITH existing_activity AS MATERIALIZED (
        SELECT
          activity.id,
          activity.task_id,
          activity.author,
          activity.author_workos_id,
          activity.kind,
          activity.body,
          activity.metadata,
          activity.created_at
        FROM goat.task_activities AS activity
        WHERE activity.id = ${input.command.id}
      ),
      authorized AS MATERIALIZED (
        SELECT
          task.id,
          task.status,
          task.archived_at,
          task.session_id,
          task.user_workos_id,
          task.harness_spec,
          conversation.engine,
          runtime.id AS runtime_id,
          runtime.model AS runtime_model,
          runtime.status AS runtime_status
        FROM goat.tasks AS task
        JOIN goat.chat_sessions AS conversation
          ON conversation.id = task.session_id
         AND conversation.kind = 'task'
         AND conversation.closed_at IS NULL
        JOIN goat.codex_chat_sessions AS runtime
          ON runtime.chat_session_id = conversation.id
         AND runtime.user_workos_id = task.user_workos_id
         AND runtime.engine = conversation.engine
         AND (runtime.workspace_id = ${input.actor.workspaceId} OR runtime.workspace_id IS NULL)
        WHERE (task.id = ${input.taskId} OR upper(task.display_id) = upper(${input.taskId}))
          AND ${taskAccessPredicate(input.actor)}
        FOR UPDATE OF task, runtime
      ),
      locked_attachment_commands AS MATERIALIZED (
        -- Completion and cleanup also lock keyed commands before their upload row.
        SELECT command.command_id
        FROM goat.chat_attachment_upload_commands AS command
        WHERE command.attachment_id IN (${attachmentIdList})
        FOR UPDATE
      ),
      eligible_attachments AS MATERIALIZED (
        SELECT upload.id
        FROM goat.chat_attachment_uploads AS upload
        WHERE ${attachmentsRequireClaim}::boolean
          AND upload.user_workos_id = ${input.actor.userId}
          AND upload.workspace_id = ${input.actor.workspaceId}
          AND upload.claimed_at IS NULL
          AND upload.expires_at > ${now}
          AND upload.id IN (${attachmentIdList})
          AND EXISTS (SELECT 1 FROM authorized)
          AND (SELECT count(*) FROM locked_attachment_commands) >= 0
        FOR UPDATE
      ),
      matching_replay AS MATERIALIZED (
        SELECT activity.*
        FROM existing_activity AS activity
        JOIN authorized AS task ON task.id = activity.task_id
        WHERE activity.author = 'user'
          AND activity.author_workos_id = ${input.actor.userId}
          AND activity.kind = 'comment'
          AND activity.body = ${input.command.body}
          AND COALESCE(activity.metadata->'attachmentIds', '[]'::jsonb)
            = ${stringifyPostgresJson(attachmentIds)}::jsonb
          AND NULLIF(activity.metadata->>'messageId', '') IS NOT NULL
          AND NULLIF(activity.metadata->>'assistantMessageId', '') IS NOT NULL
          AND NULLIF(activity.metadata->>'runId', '') IS NOT NULL
      ),
      eligible AS MATERIALIZED (
        SELECT task.*
        FROM authorized AS task
        WHERE task.archived_at IS NULL
          AND task.status IN ('waiting', 'succeeded', 'failed', 'canceled')
          AND task.runtime_status NOT IN ('queued', 'starting', 'running')
          AND NOT EXISTS (SELECT 1 FROM existing_activity)
      ),
      reopened_task AS MATERIALIZED (
        UPDATE goat.tasks AS task
        SET status = 'running',
            stage = 'queued',
            result = NULL,
            error = NULL,
            reported_outcome = NULL,
            outcome_comment = NULL,
            next_run_at = ${now},
            lease_id = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL,
            attempts = task.attempts + 1,
            updated_at = ${now}
        FROM eligible
        WHERE task.id = eligible.id
          AND task.status IN ('waiting', 'succeeded', 'failed', 'canceled')
          AND task.archived_at IS NULL
        RETURNING task.id, eligible.status AS previous_status
      ),
      created_comment AS MATERIALIZED (
        INSERT INTO goat.task_activities (
          id, task_id, author, author_workos_id, kind, body, metadata, created_at
        )
        SELECT
          ${input.command.id}, task.id, 'user', ${input.actor.userId}, 'comment',
          ${input.command.body},
          jsonb_build_object(
            'messageId', ${messageId}::text,
            'assistantMessageId', ${assistantMessageId}::text,
            'runId', ${runId}::text,
            'attachmentIds', ${stringifyPostgresJson(attachmentIds)}::jsonb
          ),
          ${now}
        FROM reopened_task AS task
        RETURNING *
      ),
      resumed_task_activity AS MATERIALIZED (
        INSERT INTO goat.task_activities (
          id, task_id, author, author_workos_id, kind, body, metadata, created_at
        )
        SELECT
          ${statusActivityId}, task.id, 'user', ${input.actor.userId}, 'status_changed',
          'Resumed by user.',
          jsonb_build_object(
            'fromStatus', task.previous_status,
            'toStatus', 'running',
            'runId', ${runId}::text
          ),
          ${statusChangedAt}
        FROM reopened_task AS task
        JOIN created_comment AS comment ON comment.task_id = task.id
        RETURNING task_id
      ),
      queued_runtime AS MATERIALIZED (
        UPDATE goat.codex_chat_sessions AS runtime
        SET status = 'queued',
            active_turn_id = ${runId},
            error = NULL,
            updated_at = ${now}
        FROM eligible AS task
        JOIN reopened_task AS reopened ON reopened.id = task.id
        WHERE runtime.id = task.runtime_id
          AND runtime.status NOT IN ('queued', 'starting', 'running')
          AND EXISTS (
            SELECT 1 FROM resumed_task_activity AS activity WHERE activity.task_id = task.id
          )
        RETURNING runtime.id, runtime.chat_session_id
      ),
      claimed_attachments AS MATERIALIZED (
        UPDATE goat.chat_attachment_uploads AS upload
        SET claimed_message_id = ${messageId},
            claimed_at = ${now}
        WHERE upload.id IN (SELECT id FROM eligible_attachments)
          AND upload.claimed_at IS NULL
        RETURNING upload.id
      ),
      terminal_attachment_commands AS MATERIALIZED (
        UPDATE goat.chat_attachment_upload_commands AS command
        SET claimed_at = ${now},
            cleaned_at = ${now},
            touched_at = ${now}
        FROM claimed_attachments AS upload
        WHERE command.attachment_id = upload.id
          AND command.claimed_at IS NULL
          AND command.cleaned_at IS NULL
        RETURNING command.command_id
      ),
      inserted_user_message AS MATERIALIZED (
        INSERT INTO goat.chat_messages (
          id, session_id, role, content, task_id, attachments, attachment_texts,
          created_at, updated_at
        )
        SELECT
          ${messageId}, task.session_id, 'user', ${input.command.body}, task.id,
          ${attachmentsJson(resolvedAttachments.attachments)}::jsonb,
          ${attachmentTextsJson(resolvedAttachments.attachmentTexts)}::jsonb,
          ${now}, ${now}
        FROM eligible AS task
        JOIN reopened_task AS reopened ON reopened.id = task.id
        JOIN queued_runtime AS runtime ON runtime.id = task.runtime_id
        JOIN created_comment AS comment ON comment.task_id = task.id
        WHERE (
          NOT ${attachmentsRequireClaim}::boolean
          OR (SELECT COUNT(*) FROM claimed_attachments) = ${attachmentIds.length}
        )
        RETURNING id
      ),
      inserted_assistant_message AS MATERIALIZED (
        INSERT INTO goat.chat_messages (
          id, session_id, role, content, task_id, debug_trace, created_at, updated_at
        )
        SELECT
          ${assistantMessageId}, task.session_id, 'assistant', '', task.id,
          CASE
            WHEN task.engine = 'opencompany' THEN jsonb_build_object(
              'schemaVersion', 'opencompany.chat.debug.v1',
              'model', task.runtime_model,
              'steps', jsonb_build_array(),
              'uiMessageParts', jsonb_build_array()
            )
            ELSE jsonb_build_object(
              'schemaVersion', 'goat.codex_chat.debug.v1',
              'model', task.runtime_model,
              'uiMessageParts', jsonb_build_array()
            )
          END,
          ${assistantCreatedAt}, ${assistantCreatedAt}
        FROM eligible AS task
        JOIN reopened_task AS reopened ON reopened.id = task.id
        JOIN queued_runtime AS runtime ON runtime.id = task.runtime_id
        JOIN inserted_user_message AS message ON message.id = ${messageId}
        RETURNING id
      ),
      inserted_run AS MATERIALIZED (
        INSERT INTO goat.codex_chat_turns (
          id, user_workos_id, codex_chat_session_id, chat_session_id,
          user_message_id, assistant_message_id, status, prompt, settings, event_sequence,
          created_at, updated_at
        )
        SELECT
          ${runId}, task.user_workos_id, task.runtime_id, task.session_id,
          ${messageId}, ${assistantMessageId}, 'queued', ${input.command.body},
          jsonb_strip_nulls(jsonb_build_object(
            'reasoningEffort', task.harness_spec #>> '{codex,reasoningEffort}',
            'goalMode', task.harness_spec #> '{codex,goalMode}',
            'taskResultMode', 'assistant_final'
          )),
          1, ${now}, ${now}
        FROM eligible AS task
        JOIN reopened_task AS reopened ON reopened.id = task.id
        JOIN queued_runtime AS runtime ON runtime.id = task.runtime_id
        JOIN inserted_user_message AS user_message ON user_message.id = ${messageId}
        JOIN inserted_assistant_message AS assistant_message
          ON assistant_message.id = ${assistantMessageId}
        RETURNING id
      ),
      inserted_event AS MATERIALIZED (
        INSERT INTO goat.run_events (
          id, run_id, sequence, schema_version, type, payload, created_at
        )
        SELECT
          ${eventId}, run.id, 1, 1, 'run.queued',
          jsonb_build_object(
            'conversationId', task.session_id,
            'triggerMessageId', ${messageId}::text
          ),
          ${now}
        FROM inserted_run AS run
        JOIN eligible AS task ON true
        RETURNING run_id, sequence
      ),
      notified AS MATERIALIZED (
        SELECT pg_notify(
          ${RUN_EVENT_NOTIFY_CHANNEL},
          jsonb_build_object('runId', run_id, 'sequence', sequence)::text
        )
        FROM inserted_event
      ),
      updated_conversation AS MATERIALIZED (
        UPDATE goat.chat_sessions AS conversation
        SET updated_at = ${now}, last_seen_at = ${now}, has_unseen = false
        FROM eligible AS task, inserted_run
        WHERE conversation.id = task.session_id
        RETURNING conversation.id
      ),
      selected_comment AS MATERIALIZED (
        SELECT * FROM created_comment
        UNION ALL
        SELECT * FROM matching_replay
      )
      SELECT
        EXISTS (SELECT 1 FROM existing_activity) AS "idExists",
        EXISTS (SELECT 1 FROM matching_replay) AS replayed,
        authorized.status IN ('queued', 'running') AS active,
        authorized.archived_at IS NOT NULL AS archived,
        authorized.runtime_status IN ('queued', 'starting', 'running') AS "runtimeActive",
        CASE
          WHEN EXISTS (SELECT 1 FROM matching_replay) THEN (
            EXISTS (
              SELECT 1
              FROM goat.chat_messages AS user_message
              JOIN goat.chat_messages AS assistant_message
                ON assistant_message.id = selected_comment.metadata->>'assistantMessageId'
              JOIN goat.codex_chat_turns AS run
                ON run.id = selected_comment.metadata->>'runId'
              WHERE user_message.id = selected_comment.metadata->>'messageId'
                AND run.user_message_id = user_message.id
                AND run.assistant_message_id = assistant_message.id
            )
          )
          WHEN EXISTS (SELECT 1 FROM eligible) THEN
            CASE
              WHEN EXISTS (SELECT 1 FROM inserted_event)
                AND EXISTS (SELECT 1 FROM updated_conversation)
                AND EXISTS (SELECT 1 FROM resumed_task_activity)
                THEN true
              ELSE jsonb_array_length(jsonb_build_object('reason', 'unmaterialized')) = 0
            END
          ELSE false
        END AS materialized,
        task.id,
        task.display_id AS "displayId",
        task.name,
        task.prompt AS goal,
        task.session_id AS "conversationId",
        CASE
          WHEN EXISTS (SELECT 1 FROM reopened_task) THEN 'running'
          ELSE task.status
        END AS status,
        task.source,
        conversation.engine,
        task.model,
        task.workflow_id AS "workflowId",
        task.schedule_id AS "scheduleId",
        task.scheduled_for AS "scheduledFor",
        CASE WHEN EXISTS (SELECT 1 FROM reopened_task) THEN NULL ELSE task.result END AS result,
        CASE WHEN EXISTS (SELECT 1 FROM reopened_task) THEN NULL ELSE task.error END AS error,
        CASE
          WHEN EXISTS (SELECT 1 FROM reopened_task) THEN NULL
          ELSE task.reported_outcome
        END AS "reportedStatus",
        CASE
          WHEN EXISTS (SELECT 1 FROM reopened_task) THEN NULL
          ELSE task.outcome_comment
        END AS "outcomeComment",
        task.archived_at AS "archivedAt",
        task.created_at AS "createdAt",
        CASE
          WHEN EXISTS (SELECT 1 FROM reopened_task) THEN ${now}
          ELSE task.updated_at
        END AS "updatedAt",
        selected_comment.id AS "commentId",
        selected_comment.task_id AS "commentTaskId",
        selected_comment.author_workos_id AS "commentAuthorWorkosId",
        selected_comment.body AS "commentBody",
        selected_comment.created_at AS "commentCreatedAt",
        selected_comment.metadata->>'messageId' AS "messageId",
        selected_comment.metadata->>'assistantMessageId' AS "assistantMessageId",
        selected_comment.metadata->>'runId' AS "runId",
        pg_current_xact_id()::text AS "transactionId",
        (SELECT count(*) FROM notified) AS "notifyCount",
        (SELECT count(*) FROM terminal_attachment_commands) AS "terminalAttachmentCommandCount"
      FROM authorized
      JOIN goat.tasks AS task ON task.id = authorized.id
      JOIN goat.chat_sessions AS conversation ON conversation.id = task.session_id
      LEFT JOIN selected_comment ON selected_comment.task_id = task.id
      LIMIT 1
      `);
    } catch (error) {
      if (attachmentIds.length > 0 && isUnmaterializedGuardError(error)) {
        throw new CoreError("invalid_argument", "An attachment is unavailable or has expired.");
      }
      throw error;
    }
    const [row] = rows;
    if (!row) return null;
    if (row.idExists && !row.replayed) {
      throw new CoreError(
        "idempotency_conflict",
        "The comment ID was already used for another Task comment.",
      );
    }
    if (!row.replayed && row.archived) {
      throw new CoreError("conflict", "Archived Tasks cannot receive comments.");
    }
    if (!row.replayed && (row.active || row.runtimeActive)) {
      throw new CoreError("conflict", "Wait for the active Task run to finish before commenting.");
    }
    if (!row.materialized) {
      throw new Error("The Task comment, Message, and Run were not materialized.");
    }
    return taskCommentCreateResult(row);
  }

  async updateTask(input: {
    actor: Actor;
    taskId: string;
    command: UpdateTaskCommand;
  }): Promise<UpdateTaskResult | null> {
    const now = this.options.now?.() ?? new Date();
    const archived = "archived" in input.command ? input.command.archived : null;
    const name = "name" in input.command ? input.command.name : null;
    const [row] = await this.rows<TaskUpdateRow>(sql`
      WITH authorized AS MATERIALIZED (
        SELECT task.id
        FROM goat.tasks AS task
        JOIN goat.chat_sessions AS conversation
          ON conversation.id = task.session_id
         AND conversation.kind = 'task'
        WHERE (task.id = ${input.taskId} OR upper(task.display_id) = upper(${input.taskId}))
          AND ${taskAccessPredicate(input.actor)}
      ),
      updated AS MATERIALIZED (
        UPDATE goat.tasks AS task
        SET name = COALESCE(${name}::text, task.name),
            archived_at = CASE
              WHEN ${archived}::boolean IS NULL THEN task.archived_at
              WHEN ${archived}::boolean THEN ${now}::timestamptz
              ELSE NULL
            END,
            updated_at = ${now}::timestamptz
        FROM authorized
        WHERE task.id = authorized.id
          AND (
            (${name}::text IS NOT NULL AND task.name IS DISTINCT FROM ${name}::text)
            OR (
              ${archived}::boolean IS NOT NULL
              AND task.status IN ('succeeded', 'failed', 'canceled')
              AND (
                (${archived}::boolean AND task.archived_at IS NULL)
                OR (NOT ${archived}::boolean AND task.archived_at IS NOT NULL)
              )
            )
          )
        RETURNING task.*
      ),
      updated_conversation AS (
        UPDATE goat.chat_sessions AS conversation
        SET title = updated.name,
            updated_at = ${now}::timestamptz
        FROM updated
        WHERE ${name}::text IS NOT NULL
          AND conversation.id = updated.session_id
          AND conversation.kind = 'task'
        RETURNING conversation.id
      ),
      selected_task AS MATERIALIZED (
        SELECT changed.*
        FROM updated AS changed
        UNION ALL
        SELECT existing.*
        FROM goat.tasks AS existing
        JOIN authorized ON authorized.id = existing.id
        WHERE NOT EXISTS (SELECT 1 FROM updated)
      )
      SELECT
        EXISTS (SELECT 1 FROM authorized) AS authorized,
        EXISTS (SELECT 1 FROM updated) AS changed,
        task.id,
        task.display_id AS "displayId",
        task.name,
        task.prompt AS goal,
        task.session_id AS "conversationId",
        task.status,
        task.source,
        conversation.engine,
        task.model,
        task.workflow_id AS "workflowId",
        task.schedule_id AS "scheduleId",
        task.scheduled_for AS "scheduledFor",
        task.result,
        task.error,
        task.reported_outcome AS "reportedStatus",
        task.outcome_comment AS "outcomeComment",
        task.archived_at AS "archivedAt",
        task.created_at AS "createdAt",
        task.updated_at AS "updatedAt",
        pg_current_xact_id()::text AS "transactionId"
      FROM authorized
      JOIN selected_task AS task ON task.id = authorized.id
      JOIN goat.chat_sessions AS conversation ON conversation.id = task.session_id
      LIMIT 1
    `);
    if (!row) return null;
    if (
      "archived" in input.command &&
      input.command.archived &&
      !row.changed &&
      row.archivedAt === null &&
      !["succeeded", "failed", "canceled"].includes(row.status)
    ) {
      throw new CoreError("invalid_argument", "Only a terminal Task can be archived.");
    }
    const transactionId = validTransactionId(row.transactionId);
    return { task: mapTask(row), transactionId };
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

type PhysicalTaskStatus = "queued" | "running" | "waiting" | "succeeded" | "failed" | "canceled";

type TaskRow = {
  id: string;
  displayId: string;
  name: string;
  goal: string;
  conversationId: string;
  status: PhysicalTaskStatus;
  source: TaskSource;
  engine: Task["engine"];
  model: string;
  workflowId: string | null;
  scheduleId: string | null;
  scheduledFor: Date | string | null;
  result: string | null;
  error: string | null;
  reportedStatus: Task["outcome"]["reportedStatus"];
  outcomeComment: string | null;
  archivedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

type TaskCreateRow = Omit<TaskRow, "conversationId"> & {
  authorized: boolean;
  featureEnabled: boolean;
  commandId: string | null;
  requestHash: string | null;
  taskId: string | null;
  reservedConversationId: string | null;
  messageId: string | null;
  assistantMessageId: string | null;
  runId: string | null;
  transactionId: number | string | null;
  replayed: boolean;
  materialized: boolean;
  taskConversationId: string;
};

type TaskCommentCreateRow = TaskRow & {
  idExists: boolean;
  replayed: boolean;
  active: boolean;
  archived: boolean;
  runtimeActive: boolean;
  materialized: boolean;
  commentId: string | null;
  commentTaskId: string | null;
  commentAuthorWorkosId: string | null;
  commentBody: string | null;
  commentCreatedAt: Date | string | null;
  messageId: string | null;
  assistantMessageId: string | null;
  runId: string | null;
  transactionId: number | string;
};

type TaskUpdateRow = TaskRow & {
  authorized: boolean;
  changed: boolean;
  transactionId: number | string;
};

type TaskSummaryRow = {
  status: PhysicalTaskStatus;
  archivedAt: Date | string | null;
  runDurationMs: number | string | null;
  runStartedAt: Date | string | null;
  runCompletedAt: Date | string | null;
  usageRowCount: number | string;
  totalCostUsdMicros: number | string;
};

type LegacyTaskRow = Omit<TaskRow, "conversationId"> & { actorId: string };

type LegacyTaskMessageRow = LegacyTaskHistory["messages"][number] & {
  createdAt: Date | string;
  updatedAt: Date | string;
  completedAt: Date | string | null;
};

type LegacyTaskEventRow = LegacyTaskHistory["events"][number] & {
  createdAt: Date | string;
};

function taskSelect() {
  return sql`
    SELECT
      task.id,
      task.display_id AS "displayId",
      task.name,
      task.prompt AS goal,
      task.session_id AS "conversationId",
      task.status,
      task.source,
      conversation.engine,
      task.model,
      task.workflow_id AS "workflowId",
      task.schedule_id AS "scheduleId",
      task.scheduled_for AS "scheduledFor",
      task.result,
      task.error,
      task.reported_outcome AS "reportedStatus",
      task.outcome_comment AS "outcomeComment",
      task.archived_at AS "archivedAt",
      task.created_at AS "createdAt",
      task.updated_at AS "updatedAt"
    FROM goat.tasks AS task
    JOIN goat.chat_sessions AS conversation
      ON conversation.id = task.session_id
     AND conversation.kind = 'task'
  `;
}

function legacyTaskSelect() {
  return sql`
    SELECT
      task.id,
      task.user_workos_id AS "actorId",
      task.display_id AS "displayId",
      task.name,
      task.prompt AS goal,
      task.status,
      task.source,
      CASE
        WHEN task.harness_spec->>'engine' IN ('codex', 'claude_code')
          THEN task.harness_spec->>'engine'
        ELSE 'opencompany'
      END AS engine,
      task.model,
      task.workflow_id AS "workflowId",
      task.schedule_id AS "scheduleId",
      task.scheduled_for AS "scheduledFor",
      task.result,
      task.error,
      task.reported_outcome AS "reportedStatus",
      task.outcome_comment AS "outcomeComment",
      task.archived_at AS "archivedAt",
      task.created_at AS "createdAt",
      task.updated_at AS "updatedAt"
    FROM goat.tasks AS task
  `;
}

function taskAccessPredicate(actor: Actor) {
  return sql`(
    (
      task.workspace_id = ${actor.workspaceId}
      AND EXISTS (
        SELECT 1
        FROM goat.workspace_members AS member
        WHERE member.workspace_id = ${actor.workspaceId}
          AND member.user_workos_id = ${actor.userId}
      )
    )
    OR (
      task.workspace_id IS NULL
      AND task.user_workos_id = ${actor.userId}
    )
  )`;
}

function taskCreateResult(row: TaskCreateRow, requestHash: string): CreateTaskResult {
  if (row.requestHash !== requestHash) {
    throw new CoreError(
      "idempotency_conflict",
      "The Idempotency-Key was already used for another Task command.",
    );
  }
  if (
    !row.materialized ||
    !row.taskId ||
    !row.id ||
    row.id !== row.taskId ||
    !row.reservedConversationId ||
    !row.taskConversationId ||
    row.taskConversationId !== row.reservedConversationId ||
    !row.messageId ||
    !row.assistantMessageId ||
    !row.runId
  ) {
    throw new Error("The durable Task, Message, and Run were not materialized.");
  }
  return {
    task: mapTask({ ...row, conversationId: row.taskConversationId }),
    messageId: row.messageId,
    assistantMessageId: row.assistantMessageId,
    runId: row.runId,
    transactionId: validTransactionId(row.transactionId),
    idempotentReplay: row.replayed,
  };
}

function taskCommentCreateResult(row: TaskCommentCreateRow): CreateTaskCommentResult {
  if (
    !row.commentId ||
    !row.commentTaskId ||
    row.commentTaskId !== row.id ||
    !row.commentAuthorWorkosId ||
    row.commentBody === null ||
    !row.commentCreatedAt ||
    !row.messageId ||
    !row.assistantMessageId ||
    !row.runId
  ) {
    throw new Error("The durable Task comment, Message, and Run references are incomplete.");
  }
  return {
    task: mapTask(row),
    comment: {
      id: row.commentId,
      taskId: row.commentTaskId,
      authorWorkosId: row.commentAuthorWorkosId,
      body: row.commentBody,
      createdAt: asDate(row.commentCreatedAt),
    },
    messageId: row.messageId,
    assistantMessageId: row.assistantMessageId,
    runId: row.runId,
    transactionId: validTransactionId(row.transactionId),
    idempotentReplay: row.replayed,
  };
}

function mapTask(row: TaskRow): Task {
  const archivedAt = nullableDate(row.archivedAt);
  return {
    id: row.id,
    displayId: row.displayId,
    name: row.name,
    goal: row.goal,
    conversationId: row.conversationId,
    status: canonicalTaskStatus(row.status, archivedAt),
    source: row.source,
    engine: row.engine,
    model: row.model,
    workflowId: row.workflowId,
    scheduleId: row.scheduleId,
    scheduledFor: nullableDate(row.scheduledFor),
    outcome: {
      result: row.result,
      error: row.error,
      reportedStatus: row.reportedStatus,
      comment: row.outcomeComment,
    },
    archivedAt,
    createdAt: asDate(row.createdAt),
    updatedAt: asDate(row.updatedAt),
  };
}

function mapLegacyTask(row: LegacyTaskRow): LegacyTask {
  const archivedAt = nullableDate(row.archivedAt);
  return {
    id: row.id,
    displayId: row.displayId,
    name: row.name,
    goal: row.goal,
    status: canonicalTaskStatus(row.status, archivedAt),
    source: row.source,
    engine: row.engine,
    model: row.model,
    workflowId: row.workflowId,
    scheduleId: row.scheduleId,
    scheduledFor: nullableDate(row.scheduledFor),
    outcome: {
      result: row.result,
      error: row.error,
      reportedStatus: row.reportedStatus,
      comment: row.outcomeComment,
    },
    archivedAt,
    createdAt: asDate(row.createdAt),
    updatedAt: asDate(row.updatedAt),
  };
}

function canonicalTaskStatus(status: PhysicalTaskStatus, archivedAt: Date | null): TaskStatus {
  return archivedAt ? "archived" : status;
}

function hashTaskCommand(command: CreateTaskCommand) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        name: command.name ?? null,
        goal: command.goal,
        engine: command.engine,
        model: command.model,
        attachmentIds: command.attachmentIds ?? [],
        source: command.source,
        workflowId: command.workflowId ?? null,
        scheduleId: command.scheduleId ?? null,
        scheduledFor: command.scheduledFor?.toISOString() ?? null,
      }),
    )
    .digest("hex");
}

function runtimeModelName(engine: CreateTaskCommand["engine"], model: string) {
  if (engine === "codex") return isCodexModelId(model) ? codexCliModelNameForModelId(model) : null;
  if (engine === "claude_code") return claudeCodeCliModelNameForModelId(model);
  return model;
}

function defaultHarness(command: CreateTaskCommand & { model: AgentModelId }): HarnessSpec {
  return {
    schemaVersion: "goat.harness.v1",
    engine: command.engine,
    model: command.model,
    systemPrompt: "",
    initialUserMessage: command.goal,
    tools: [],
    skills: [],
    maxModelSteps: 16,
    resultMode: "assistant_final",
  };
}

function validateHarness(
  harness: HarnessSpec,
  command: CreateTaskCommand,
  initialMessageContent: string,
) {
  if (
    harness.schemaVersion !== "goat.harness.v1" ||
    harness.engine !== command.engine ||
    harness.model !== command.model ||
    harness.initialUserMessage.trim() !== initialMessageContent
  ) {
    throw new Error("The prepared Task execution does not match its canonical command.");
  }
}

function turnSettingsFromHarness(harness: HarnessSpec) {
  return {
    ...(harness.codex?.reasoningEffort ? { reasoningEffort: harness.codex.reasoningEffort } : {}),
    ...(harness.codex?.goalMode ? { goalMode: harness.codex.goalMode } : {}),
  };
}

function attachmentsJson(attachments: ResolvedChatAttachments["attachments"]) {
  return attachments.length > 0 ? stringifyPostgresJson(attachments) : null;
}

function attachmentTextsJson(attachmentTexts: ResolvedChatAttachments["attachmentTexts"]) {
  return attachmentTexts && Object.keys(attachmentTexts).length > 0
    ? stringifyPostgresJson(attachmentTexts)
    : null;
}

function encodeTaskCursor(updatedAt: Date, id: string) {
  return Buffer.from(JSON.stringify({ updatedAt: updatedAt.toISOString(), id }), "utf8").toString(
    "base64url",
  );
}

function decodeTaskCursor(cursor?: string): { updatedAt: string; id: string } | null {
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
    throw new CoreError("invalid_argument", "The Task cursor is invalid.");
  }
}

function validTransactionId(value: number | string | null) {
  const transactionId = String(value);
  if (!/^[0-9]+$/u.test(transactionId)) {
    throw new Error("Postgres returned an invalid transaction identifier.");
  }
  return transactionId;
}

function asDate(value: Date | string) {
  return value instanceof Date ? value : new Date(value);
}

function nullableDate(value: Date | string | null) {
  return value ? asDate(value) : null;
}

function nullableNumber(value: number | string | null) {
  if (value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nullableTimestamp(value: Date | string | null) {
  if (value === null) return null;
  const timestamp = asDate(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
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
