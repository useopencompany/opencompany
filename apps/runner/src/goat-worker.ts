import { randomUUID } from "node:crypto";
import {
  calculateHostedToolUsageCost,
  calculateModelUsageCost,
  calculateSandboxUsageCost,
} from "@opencompany/billing";
import type {
  GoatHarnessSpec,
  GoatTaskDebugTrace,
  GoatTaskEventType,
  GoatTaskMessageRole,
  GoatTaskMessageStatus,
  GoatTaskModelUsagePhase,
  GoatTaskReportedOutcome,
  GoatTaskToolName,
} from "@opencompany/db/goat-schema";
import { goatTasks } from "@opencompany/db/goat-schema";
import {
  GOAT_METRICS,
  GOAT_SPANS,
  hashGoatUserId,
  recordGoatHistogram,
  recordGoatModelCost,
  recordGoatTaskRun,
  startGoatSpan,
  withGoatSpan,
} from "@opencompany/goat-observability";
import { captureException, createLogger } from "@opencompany/observability";
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import type { RunnerEnv } from "./env";
import {
  executeGoatTask,
  type GoatTaskConversationMessage,
  type GoatTaskExecutorInput,
  type GoatTaskExecutorResult,
} from "./goat-harness";
import { getGoatAvailableGitHubRepositoryNamesForRunner } from "./goat-harness-planner";
import { rowsFromExecute } from "./sql-exec";
import { type NormalizedModelUsage, normalizeModelUsage } from "./usage";

const logger = createLogger({ service: "opencompany-runner", runtime: "goat-worker" });

export const GOAT_TASK_LEASE_TTL_MS = 5 * 60 * 1000;
export const GOAT_TASK_HEARTBEAT_INTERVAL_MS = 5_000;

type GoatTask = typeof goatTasks.$inferSelect;
type GoatTaskStage = GoatTask["stage"];
type GoatTaskExecutor = (input: GoatTaskExecutorInput) => Promise<GoatTaskExecutorResult>;
type GoatUsageCostWrite = {
  providerCostUsdMicros: number;
  platformFeeUsdMicros: number;
  totalCostUsdMicros: number;
  costBasis: Record<string, unknown>;
};

export type GoatTaskStore = {
  claimNext(input: {
    leaseId: string;
    leaseOwner: string;
    now: Date;
    leaseExpiresAt: Date;
  }): Promise<GoatTask | null>;
  heartbeat(input: {
    id: string;
    leaseId: string;
    leaseOwner: string;
    now: Date;
    leaseExpiresAt: Date;
  }): Promise<boolean>;
  updateStage(input: {
    id: string;
    leaseId: string;
    leaseOwner: string;
    now: Date;
    stage: GoatTaskStage;
    harnessSpec?: GoatHarnessSpec;
    debugTrace?: GoatTaskDebugTrace;
  }): Promise<boolean>;
  updateCodexEngineSessionId(input: {
    id: string;
    leaseId: string;
    leaseOwner: string;
    now: Date;
    codexEngineSessionId: string | null;
  }): Promise<boolean>;
  ensureUserMessage(input: {
    id: string;
    leaseId: string;
    leaseOwner: string;
    now: Date;
    messageId: string;
  }): Promise<string | null>;
  listConversationMessages(input: {
    id: string;
    leaseId: string;
    leaseOwner: string;
  }): Promise<GoatTaskConversationMessage[]>;
  createMessage(input: {
    id: string;
    leaseId: string;
    leaseOwner: string;
    now: Date;
    messageId: string;
    role: GoatTaskMessageRole;
    status: GoatTaskMessageStatus;
    content: string;
    modelMessage?: unknown;
    toolName?: GoatTaskToolName | null;
    toolCallId?: string | null;
    responseToMessageId?: string | null;
  }): Promise<boolean>;
  updateMessageContent(input: {
    id: string;
    leaseId: string;
    leaseOwner: string;
    now: Date;
    messageId: string;
    content: string;
  }): Promise<boolean>;
  completeMessage(input: {
    id: string;
    leaseId: string;
    leaseOwner: string;
    now: Date;
    messageId: string;
    content: string;
    modelMessage?: unknown;
  }): Promise<boolean>;
  failMessage(input: {
    id: string;
    leaseId: string;
    leaseOwner: string;
    now: Date;
    messageId: string;
    content?: string;
    error: string;
  }): Promise<boolean>;
  appendEvent(input: {
    id: string;
    leaseId: string;
    leaseOwner: string;
    now: Date;
    messageId?: string | null;
    type: GoatTaskEventType;
    payload: Record<string, unknown>;
  }): Promise<boolean>;
  recordModelUsage(input: {
    id: string;
    leaseId: string;
    leaseOwner: string;
    now: Date;
    messageId?: string | null;
    phase: GoatTaskModelUsagePhase;
    stepIndex: number;
    modelProvider: string;
    modelName: string;
    responseId?: string | null;
    responseModelId?: string | null;
    finishReason?: string | null;
    rawFinishReason?: string | null;
    usage: NormalizedModelUsage;
    providerCreatedAt?: Date | null;
    cost: GoatUsageCostWrite;
  }): Promise<boolean>;
  recordToolUsage(input: {
    id: string;
    leaseId: string;
    leaseOwner: string;
    now: Date;
    messageId?: string | null;
    toolCallId: string;
    toolName: GoatTaskToolName;
    provider: string;
    operation: string;
    providerRequestId?: string | null;
    rawUsage: Record<string, unknown>;
    cost: GoatUsageCostWrite;
  }): Promise<boolean>;
  recordSandboxUsage(input: {
    id: string;
    leaseId: string;
    leaseOwner: string;
    now: Date;
    messageId?: string | null;
    sandboxId: string;
    template: string | null;
    vcpu: number | null;
    ramMib: number | null;
    startedAt: Date;
    endedAt: Date;
    activeMs: number;
    rawMetrics: Record<string, unknown>;
    cost: GoatUsageCostWrite;
  }): Promise<boolean>;
  complete(input: {
    id: string;
    displayId: string;
    leaseId: string;
    leaseOwner: string;
    now: Date;
    result: string;
    harnessSpec: GoatHarnessSpec;
    debugTrace: GoatTaskDebugTrace;
    reportedOutcome?: GoatTaskReportedOutcome | null;
    outcomeComment?: string | null;
  }): Promise<boolean>;
  fail(input: {
    id: string;
    displayId: string;
    leaseId: string;
    leaseOwner: string;
    now: Date;
    error: string;
    debugTrace?: GoatTaskDebugTrace;
  }): Promise<boolean>;
};

export function createDbGoatTaskStore(): GoatTaskStore {
  return {
    async claimNext(input) {
      const result = await getDb().execute(sql`
        WITH candidate AS (
          SELECT task.id
          FROM goat.tasks AS task
          INNER JOIN goat.users AS "user"
            ON "user".workos_user_id = task.user_workos_id
          WHERE
            "user".task_spawning_enabled = true
            AND task.session_id IS NULL
            AND (
              (task.status = 'queued' AND task.next_run_at <= ${input.now})
              OR (task.status = 'running' AND task.lease_expires_at < ${input.now})
            )
          ORDER BY task.next_run_at ASC, task.created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE goat.tasks AS task
        SET status = 'running',
            stage = 'planning',
            attempts = task.attempts + 1,
            lease_id = ${input.leaseId},
            lease_owner = ${input.leaseOwner},
            lease_expires_at = ${input.leaseExpiresAt},
            updated_at = ${input.now}
        FROM candidate
        WHERE task.id = candidate.id
        RETURNING ${goatTaskColumnsSql}
      `);
      const row = rowsFromExecute<GoatTaskRow>(result)[0];
      return row ? goatTaskFromRow(row) : null;
    },

    async heartbeat(input) {
      const result = await getDb().execute(sql`
        UPDATE goat.tasks
        SET lease_expires_at = ${input.leaseExpiresAt},
            updated_at = ${input.now}
        WHERE id = ${input.id}
          AND lease_id = ${input.leaseId}
          AND lease_owner = ${input.leaseOwner}
          AND status = 'running'
        RETURNING id
      `);
      return rowsFromExecute<{ id: string }>(result).length > 0;
    },

    async updateStage(input) {
      const result = await getDb().execute(sql`
        UPDATE goat.tasks
        SET stage = ${input.stage},
            model = COALESCE(${input.harnessSpec?.model ?? null}, model),
            harness_spec = COALESCE(${input.harnessSpec ? JSON.stringify(input.harnessSpec) : null}::jsonb, harness_spec),
            debug_trace = COALESCE(${input.debugTrace ? JSON.stringify(input.debugTrace) : null}::jsonb, debug_trace),
            updated_at = ${input.now}
        WHERE id = ${input.id}
          AND lease_id = ${input.leaseId}
          AND lease_owner = ${input.leaseOwner}
          AND status = 'running'
        RETURNING id
      `);
      return rowsFromExecute<{ id: string }>(result).length > 0;
    },

    async updateCodexEngineSessionId(input) {
      const result = await getDb().execute(sql`
        UPDATE goat.tasks
        SET codex_engine_session_id = ${input.codexEngineSessionId},
            updated_at = ${input.now}
        WHERE id = ${input.id}
          AND lease_id = ${input.leaseId}
          AND lease_owner = ${input.leaseOwner}
          AND status = 'running'
        RETURNING id
      `);
      return rowsFromExecute<{ id: string }>(result).length > 0;
    },

    async ensureUserMessage(input) {
      const result = await getDb().execute(sql`
        WITH owned_task AS (
          SELECT id, user_workos_id, prompt, created_at
          FROM goat.tasks
          WHERE id = ${input.id}
            AND lease_id = ${input.leaseId}
            AND lease_owner = ${input.leaseOwner}
            AND status = 'running'
        ),
        existing AS (
          SELECT message.id
          FROM goat.task_messages AS message
          INNER JOIN owned_task AS task ON task.id = message.task_id
          WHERE message.role = 'user'
          ORDER BY message.created_at ASC
          LIMIT 1
        ),
        inserted AS (
          INSERT INTO goat.task_messages (
            id,
            task_id,
            user_workos_id,
            role,
            status,
            content,
            model_message,
            created_at,
            updated_at,
            completed_at
          )
          SELECT
            ${input.messageId},
            task.id,
            task.user_workos_id,
            'user',
            'completed',
            task.prompt,
            jsonb_build_object('role', 'user', 'content', task.prompt),
            task.created_at,
            ${input.now},
            ${input.now}
          FROM owned_task AS task
          WHERE NOT EXISTS (SELECT 1 FROM existing)
          RETURNING id
        )
        SELECT id FROM inserted
        UNION ALL
        SELECT id FROM existing
        LIMIT 1
      `);
      return rowsFromExecute<{ id: string }>(result)[0]?.id ?? null;
    },

    async listConversationMessages(input) {
      const result = await getDb().execute(sql`
        SELECT message.role, message.content
        FROM goat.task_messages AS message
        INNER JOIN goat.tasks AS task ON task.id = message.task_id
        WHERE task.id = ${input.id}
          AND task.lease_id = ${input.leaseId}
          AND task.lease_owner = ${input.leaseOwner}
          AND task.status = 'running'
          AND message.status = 'completed'
          AND message.role IN ('user', 'assistant')
        ORDER BY message.created_at ASC, message.id ASC
      `);
      return rowsFromExecute<GoatTaskConversationMessage>(result);
    },

    async createMessage(input) {
      const modelMessageJson =
        input.modelMessage === undefined ? null : JSON.stringify(input.modelMessage);
      const result = await getDb().execute(sql`
        INSERT INTO goat.task_messages (
          id,
          task_id,
          user_workos_id,
          role,
          status,
          content,
          model_message,
          tool_name,
          tool_call_id,
          response_to_message_id,
          created_at,
          updated_at,
          completed_at
        )
        SELECT
          ${input.messageId},
          task.id,
          task.user_workos_id,
          ${input.role},
          ${input.status},
          ${input.content},
          ${modelMessageJson}::jsonb,
          ${input.toolName ?? null},
          ${input.toolCallId ?? null},
          ${input.responseToMessageId ?? null},
          ${input.now},
          ${input.now},
          ${input.status === "completed" ? input.now : null}
        FROM goat.tasks AS task
        WHERE task.id = ${input.id}
          AND task.lease_id = ${input.leaseId}
          AND task.lease_owner = ${input.leaseOwner}
          AND task.status = 'running'
        RETURNING id
      `);
      return rowsFromExecute<{ id: string }>(result).length > 0;
    },

    async updateMessageContent(input) {
      const result = await getDb().execute(sql`
        UPDATE goat.task_messages AS message
        SET content = ${input.content},
            updated_at = ${input.now}
        FROM goat.tasks AS task
        WHERE message.id = ${input.messageId}
          AND message.task_id = task.id
          AND task.id = ${input.id}
          AND task.lease_id = ${input.leaseId}
          AND task.lease_owner = ${input.leaseOwner}
          AND task.status = 'running'
        RETURNING message.id
      `);
      return rowsFromExecute<{ id: string }>(result).length > 0;
    },

    async completeMessage(input) {
      const modelMessageJson =
        input.modelMessage === undefined ? null : JSON.stringify(input.modelMessage);
      const result = await getDb().execute(sql`
        UPDATE goat.task_messages AS message
        SET status = 'completed',
            content = ${input.content},
            model_message = COALESCE(${modelMessageJson}::jsonb, message.model_message),
            updated_at = ${input.now},
            completed_at = ${input.now}
        FROM goat.tasks AS task
        WHERE message.id = ${input.messageId}
          AND message.task_id = task.id
          AND task.id = ${input.id}
          AND task.lease_id = ${input.leaseId}
          AND task.lease_owner = ${input.leaseOwner}
          AND task.status = 'running'
        RETURNING message.id
      `);
      return rowsFromExecute<{ id: string }>(result).length > 0;
    },

    async failMessage(input) {
      const result = await getDb().execute(sql`
        UPDATE goat.task_messages AS message
        SET status = 'failed',
            content = COALESCE(${input.content ?? null}, message.content),
            model_message = COALESCE(
              message.model_message,
              jsonb_build_object('role', message.role, 'content', COALESCE(${input.content ?? null}, message.content), 'error', ${input.error})
            ),
            updated_at = ${input.now},
            completed_at = ${input.now}
        FROM goat.tasks AS task
        WHERE message.id = ${input.messageId}
          AND message.task_id = task.id
          AND task.id = ${input.id}
          AND task.lease_id = ${input.leaseId}
          AND task.lease_owner = ${input.leaseOwner}
          AND task.status = 'running'
        RETURNING message.id
      `);
      return rowsFromExecute<{ id: string }>(result).length > 0;
    },

    async appendEvent(input) {
      const result = await getDb().execute(sql`
        INSERT INTO goat.task_events (
          task_id,
          user_workos_id,
          message_id,
          type,
          payload,
          created_at
        )
        SELECT
          task.id,
          task.user_workos_id,
          ${input.messageId ?? null},
          ${input.type},
          ${JSON.stringify(input.payload)}::jsonb,
          ${input.now}
        FROM goat.tasks AS task
        WHERE task.id = ${input.id}
          AND task.lease_id = ${input.leaseId}
          AND task.lease_owner = ${input.leaseOwner}
          AND task.status = 'running'
        RETURNING id
      `);
      return rowsFromExecute<{ id: number }>(result).length > 0;
    },

    async recordModelUsage(input) {
      const result = await getDb().execute(sql`
        INSERT INTO goat.task_model_usage (
          task_id,
          user_workos_id,
          message_id,
          run_lease_id,
          phase,
          step_index,
          model_provider,
          model_name,
          response_id,
          response_model_id,
          finish_reason,
          raw_finish_reason,
          input_tokens,
          input_no_cache_tokens,
          input_cache_read_tokens,
          input_cache_write_tokens,
          output_tokens,
          output_text_tokens,
          output_reasoning_tokens,
          total_tokens,
          raw_usage,
          provider_created_at,
          provider_cost_usd_micros,
          platform_fee_usd_micros,
          total_cost_usd_micros,
          cost_basis,
          created_at
        )
        SELECT
          task.id,
          task.user_workos_id,
          ${input.messageId ?? null},
          ${input.leaseId},
          ${input.phase},
          ${input.stepIndex},
          ${input.modelProvider},
          ${input.modelName},
          ${input.responseId ?? null},
          ${input.responseModelId ?? null},
          ${input.finishReason ?? null},
          ${input.rawFinishReason ?? null},
          ${input.usage.inputTokens},
          ${input.usage.inputNoCacheTokens},
          ${input.usage.inputCacheReadTokens},
          ${input.usage.inputCacheWriteTokens},
          ${input.usage.outputTokens},
          ${input.usage.outputTextTokens},
          ${input.usage.outputReasoningTokens},
          ${input.usage.totalTokens},
          ${JSON.stringify(input.usage.rawUsage)}::jsonb,
          ${input.providerCreatedAt ?? null},
          ${input.cost.providerCostUsdMicros},
          ${input.cost.platformFeeUsdMicros},
          ${input.cost.totalCostUsdMicros},
          ${JSON.stringify(input.cost.costBasis)}::jsonb,
          ${input.now}
        FROM goat.tasks AS task
        WHERE task.id = ${input.id}
          AND task.lease_id = ${input.leaseId}
          AND task.lease_owner = ${input.leaseOwner}
          AND task.status = 'running'
        RETURNING id
      `);
      return rowsFromExecute<{ id: number }>(result).length > 0;
    },

    async recordToolUsage(input) {
      const result = await getDb().execute(sql`
        INSERT INTO goat.task_tool_usage (
          task_id,
          user_workos_id,
          message_id,
          run_lease_id,
          tool_call_id,
          tool_name,
          provider,
          operation,
          provider_request_id,
          provider_cost_usd_micros,
          platform_fee_usd_micros,
          total_cost_usd_micros,
          raw_usage,
          cost_basis,
          created_at
        )
        SELECT
          task.id,
          task.user_workos_id,
          ${input.messageId ?? null},
          ${input.leaseId},
          ${input.toolCallId},
          ${input.toolName},
          ${input.provider},
          ${input.operation},
          ${input.providerRequestId ?? null},
          ${input.cost.providerCostUsdMicros},
          ${input.cost.platformFeeUsdMicros},
          ${input.cost.totalCostUsdMicros},
          ${JSON.stringify(input.rawUsage)}::jsonb,
          ${JSON.stringify(input.cost.costBasis)}::jsonb,
          ${input.now}
        FROM goat.tasks AS task
        WHERE task.id = ${input.id}
          AND task.lease_id = ${input.leaseId}
          AND task.lease_owner = ${input.leaseOwner}
          AND task.status = 'running'
        RETURNING id
      `);
      return rowsFromExecute<{ id: number }>(result).length > 0;
    },

    async recordSandboxUsage(input) {
      const result = await getDb().execute(sql`
        INSERT INTO goat.task_sandbox_usage (
          task_id,
          user_workos_id,
          message_id,
          run_lease_id,
          sandbox_id,
          template,
          vcpu,
          ram_mib,
          started_at,
          ended_at,
          active_ms,
          provider_cost_usd_micros,
          platform_fee_usd_micros,
          total_cost_usd_micros,
          raw_metrics,
          cost_basis,
          created_at
        )
        SELECT
          task.id,
          task.user_workos_id,
          ${input.messageId ?? null},
          ${input.leaseId},
          ${input.sandboxId},
          ${input.template},
          ${input.vcpu},
          ${input.ramMib},
          ${input.startedAt},
          ${input.endedAt},
          ${input.activeMs},
          ${input.cost.providerCostUsdMicros},
          ${input.cost.platformFeeUsdMicros},
          ${input.cost.totalCostUsdMicros},
          ${JSON.stringify(input.rawMetrics)}::jsonb,
          ${JSON.stringify(input.cost.costBasis)}::jsonb,
          ${input.now}
        FROM goat.tasks AS task
        WHERE task.id = ${input.id}
          AND task.lease_id = ${input.leaseId}
          AND task.lease_owner = ${input.leaseOwner}
          AND task.status = 'running'
        RETURNING id
      `);
      return rowsFromExecute<{ id: number }>(result).length > 0;
    },

    async complete(input) {
      const notificationContent = goatTaskSucceededChatNotification({
        displayId: input.displayId,
        result: input.result,
      });
      const result = await getDb().execute(sql`
        WITH completed_task AS (
          UPDATE goat.tasks
          SET status = 'succeeded',
              stage = 'completed',
              model = ${input.harnessSpec.model},
              result = ${input.result},
              error = NULL,
              reported_outcome = ${input.reportedOutcome ?? null},
              outcome_comment = ${input.outcomeComment ?? null},
              harness_spec = ${JSON.stringify(input.harnessSpec)}::jsonb,
              debug_trace = ${JSON.stringify(input.debugTrace)}::jsonb,
              lease_id = NULL,
              lease_owner = NULL,
              lease_expires_at = NULL,
              updated_at = ${input.now}
          WHERE id = ${input.id}
            AND lease_id = ${input.leaseId}
            AND lease_owner = ${input.leaseOwner}
            AND status = 'running'
          RETURNING id, display_id, name
        ),
        origin_chat AS (
          SELECT message.session_id
          FROM goat.chat_messages AS message
          INNER JOIN goat.chat_sessions AS session ON session.id = message.session_id
          INNER JOIN completed_task AS task ON task.id = message.task_id
          WHERE session.closed_at IS NULL
          ORDER BY message.created_at ASC
          LIMIT 1
        ),
        inserted_notification AS (
          INSERT INTO goat.chat_messages (
            id,
            session_id,
            role,
            content,
            debug_trace,
            created_at,
            updated_at
          )
          SELECT
            ${newGoatChatMessageId()},
            origin.session_id,
            'assistant',
            ${notificationContent},
            jsonb_build_object(
              'schemaVersion', 'goat.chat.debug.v1',
              'taskNotification', jsonb_build_object(
                'taskId', task.id,
                'taskDisplayId', task.display_id,
                'taskName', task.name,
                'status', 'succeeded'
              )
            ),
            ${input.now},
            ${input.now}
          FROM completed_task AS task
          CROSS JOIN origin_chat AS origin
          WHERE NOT EXISTS (
            SELECT 1
            FROM goat.chat_messages AS existing
            WHERE existing.session_id = origin.session_id
              AND existing.debug_trace->'taskNotification'->>'taskId' = task.id
          )
          RETURNING session_id
        ),
        touched_chat AS (
          UPDATE goat.chat_sessions AS session
          SET updated_at = ${input.now}
          FROM inserted_notification AS notification
          WHERE session.id = notification.session_id
          RETURNING session.id
        )
        SELECT id FROM completed_task
      `);
      return rowsFromExecute<{ id: string }>(result).length > 0;
    },

    async fail(input) {
      const result = await getDb().execute(sql`
        UPDATE goat.tasks
        SET status = 'failed',
            stage = 'failed',
            error = ${input.error},
            debug_trace = COALESCE(${input.debugTrace ? JSON.stringify(input.debugTrace) : null}::jsonb, debug_trace),
            lease_id = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = ${input.now}
        WHERE id = ${input.id}
          AND lease_id = ${input.leaseId}
          AND lease_owner = ${input.leaseOwner}
          AND status = 'running'
        RETURNING id, display_id, name
      `);
      const failedTask = rowsFromExecute<{ id: string; display_id: string; name: string }>(
        result,
      )[0];
      if (!failedTask) return false;

      try {
        await insertGoatTaskFailureNotification({
          taskId: failedTask.id,
          displayId: failedTask.display_id,
          name: failedTask.name,
          error: input.error,
          now: input.now,
        });
      } catch (error) {
        captureException(error, {
          event: "opencompany.goat_task_failure_notification_failed",
          task_id: failedTask.id,
        });
        logger.warn("Failed to insert Goat task failure notification", {
          event: "opencompany.goat_task_failure_notification_failed",
          task_id: failedTask.id,
          error,
        });
      }

      return true;
    },
  };
}

async function insertGoatTaskFailureNotification(input: {
  taskId: string;
  displayId: string;
  name: string;
  error: string;
  now: Date;
}) {
  const notificationContent = goatTaskFailedChatNotification({
    displayId: input.displayId,
    error: input.error,
  });
  await getDb().execute(sql`
    WITH origin_chat AS (
      SELECT message.session_id
      FROM goat.chat_messages AS message
      INNER JOIN goat.chat_sessions AS session ON session.id = message.session_id
      WHERE message.task_id = ${input.taskId}
        AND session.closed_at IS NULL
      ORDER BY message.created_at ASC
      LIMIT 1
    ),
    inserted_notification AS (
      INSERT INTO goat.chat_messages (
        id,
        session_id,
        role,
        content,
        debug_trace,
        created_at,
        updated_at
      )
      SELECT
        ${newGoatChatMessageId()},
        origin.session_id,
        'assistant',
        ${notificationContent},
        jsonb_build_object(
          'schemaVersion', 'goat.chat.debug.v1',
          'taskNotification', jsonb_build_object(
            'taskId', ${input.taskId},
            'taskDisplayId', ${input.displayId},
            'taskName', ${input.name},
            'status', 'failed'
          ),
          'error', ${input.error}
        ),
        ${input.now},
        ${input.now}
      FROM origin_chat AS origin
      WHERE NOT EXISTS (
        SELECT 1
        FROM goat.chat_messages AS existing
        WHERE existing.session_id = origin.session_id
          AND existing.debug_trace->'taskNotification'->>'taskId' = ${input.taskId}
      )
      RETURNING session_id
    )
    UPDATE goat.chat_sessions AS session
    SET updated_at = ${input.now}
    FROM inserted_notification AS notification
    WHERE session.id = notification.session_id
  `);
}

let registeredGoatTaskWakeup: (() => void) | null = null;

export function setGoatTaskWakeup(wake: (() => void) | null) {
  registeredGoatTaskWakeup = wake;
}

export function wakeGoatTaskWorker() {
  registeredGoatTaskWakeup?.();
}

export async function claimNextGoatTask(input: {
  leaseOwner: string;
  store?: GoatTaskStore;
  leaseTtlMs?: number;
}) {
  const now = new Date();
  const leaseId = newGoatTaskLeaseId();
  const span = startGoatSpan(GOAT_SPANS.taskClaim, {
    "goat.lease_owner": input.leaseOwner,
  });
  try {
    const task = await (input.store ?? createDbGoatTaskStore()).claimNext({
      leaseId,
      leaseOwner: input.leaseOwner,
      now,
      leaseExpiresAt: goatTaskLeaseExpiresAt(now, input.leaseTtlMs),
    });
    span.end({
      "goat.lease_owner": input.leaseOwner,
      "goat.outcome": task ? "success" : "skipped",
      "goat.task_id": task?.id,
      "goat.display_id": task?.displayId,
      "goat.model": task?.model,
      "goat.status": task?.status,
      "goat.stage": task?.stage,
    });
    return task;
  } catch (error) {
    span.fail(error, {
      "goat.lease_owner": input.leaseOwner,
    });
    span.end();
    throw error;
  }
}

export async function runClaimedGoatTask(input: {
  task: GoatTask;
  env: RunnerEnv;
  store?: GoatTaskStore;
  executor?: GoatTaskExecutor;
}) {
  const runStartedAt = performance.now();
  const store = input.store ?? createDbGoatTaskStore();
  const executor = input.executor ?? executeGoatTask;
  const leaseId = requireTaskLease(input.task, "leaseId");
  const leaseOwner = requireTaskLease(input.task, "leaseOwner");
  const userIdHash = hashGoatUserId(input.task.userWorkosId);
  const baseAttributes = {
    ...(userIdHash ? { "goat.user_id_hash": userIdHash } : {}),
    "goat.task_id": input.task.id,
    "goat.display_id": input.task.displayId,
    "goat.model": input.task.model,
    "goat.status": input.task.status,
    "goat.stage": input.task.stage,
    "goat.attempt": input.task.attempts,
    "goat.lease_owner": leaseOwner,
  };
  const runSpan = startGoatSpan(GOAT_SPANS.taskRun, baseAttributes);
  const abortController = new AbortController();
  let leaseActive = true;
  let currentStage = input.task.stage;
  let currentModel = input.task.model;
  let stageStartedAt = performance.now();
  let latestDebugTrace: GoatTaskDebugTrace | undefined =
    Object.keys(input.task.debugTrace).length > 0 ? input.task.debugTrace : undefined;

  const logTaskRunFinished = (input: {
    outcome: "success" | "failure" | "aborted";
    status: string;
    stage: string;
    failureCategory?: string;
  }) => {
    const durationMs = Math.round(performance.now() - runStartedAt);
    const logFields = {
      event: "opencompany.goat_task_run_finished",
      outcome: input.outcome,
      ...(input.failureCategory ? { failure_category: input.failureCategory } : {}),
      task_id: baseAttributes["goat.task_id"],
      display_id: baseAttributes["goat.display_id"],
      model: currentModel,
      status: input.status,
      stage: input.stage,
      attempts: baseAttributes["goat.attempt"],
      duration_ms: durationMs,
    };
    if (input.outcome === "success") {
      logger.info("Goat task run finished", logFields);
    } else {
      logger.warn("Goat task run finished", logFields);
    }
  };

  const recordCurrentStageDuration = () => {
    recordGoatHistogram(
      GOAT_METRICS.taskStageDurationMs,
      Math.round(performance.now() - stageStartedAt),
      {
        ...baseAttributes,
        "goat.stage": currentStage,
      },
    );
  };

  const finishAbortedTelemetry = () => {
    recordCurrentStageDuration();
    runSpan.end({
      ...baseAttributes,
      "goat.outcome": "aborted",
      "goat.failure_category": "lease_lost",
    });
    recordGoatTaskRun({
      durationMs: Math.round(performance.now() - runStartedAt),
      outcome: "aborted",
      attributes: {
        ...baseAttributes,
        "goat.failure_category": "lease_lost",
      },
    });
    logTaskRunFinished({
      outcome: "aborted",
      status: "running",
      stage: currentStage,
      failureCategory: "lease_lost",
    });
  };

  const handleLeaseLost = () => {
    if (!leaseActive) return;
    leaseActive = false;
    abortController.abort();
    runSpan.setAttributes({
      ...baseAttributes,
      "goat.outcome": "aborted",
      "goat.failure_category": "lease_lost",
    });
    logger.warn("Goat task lease lost", {
      event: "opencompany.goat_task_lease_lost",
      task_id: input.task.id,
    });
  };

  const requireLeaseWrite = async (write: Promise<boolean>, action: string) => {
    const active = await write;
    if (active) return;
    handleLeaseLost();
    throw new Error(`Goat task lease lost while trying to ${action}.`);
  };

  const heartbeat = async () => {
    const now = new Date();
    const active = await store.heartbeat({
      id: input.task.id,
      leaseId,
      leaseOwner,
      now,
      leaseExpiresAt: goatTaskLeaseExpiresAt(now, input.env.jobLeaseTtlMs),
    });
    if (!active) handleLeaseLost();
  };

  const heartbeatTimer = setInterval(() => {
    void heartbeat().catch((error) => {
      captureException(error, {
        event: "opencompany.goat_task_heartbeat_failed",
        task_id: input.task.id,
      });
      logger.warn("Goat task heartbeat failed", {
        event: "opencompany.goat_task_heartbeat_failed",
        task_id: input.task.id,
        error,
      });
      handleLeaseLost();
    });
  }, GOAT_TASK_HEARTBEAT_INTERVAL_MS);

  try {
    const userMessageId = await store.ensureUserMessage({
      id: input.task.id,
      leaseId,
      leaseOwner,
      now: new Date(),
      messageId: newGoatTaskMessageId(),
    });
    if (!userMessageId) {
      handleLeaseLost();
      finishAbortedTelemetry();
      return;
    }

    const conversationMessages = await store.listConversationMessages({
      id: input.task.id,
      leaseId,
      leaseOwner,
    });

    const githubRepositories = input.task.harnessSpec.tools.some((tool) =>
      tool.startsWith("github_"),
    )
      ? await getGoatAvailableGitHubRepositoryNamesForRunner(input.task.userWorkosId)
      : [];

    const result = await runSpan.runInContext(() =>
      executor({
        task: input.task,
        env: input.env,
        conversationMessages,
        plannerContext: { githubRepositories },
        signal: abortController.signal,
        sink: {
          createUserMessage: async (messageInput) => {
            const messageId = newGoatTaskMessageId();
            await requireLeaseWrite(
              store.createMessage({
                id: input.task.id,
                leaseId,
                leaseOwner,
                now: new Date(),
                messageId,
                role: "user",
                status: "completed",
                content: messageInput.content,
                modelMessage: { role: "user", content: messageInput.content },
              }),
              "create user message",
            );
            await requireLeaseWrite(
              store.appendEvent({
                id: input.task.id,
                leaseId,
                leaseOwner,
                now: new Date(),
                type: "message.created",
                payload: { role: "user", status: "completed" },
                messageId,
              }),
              "append user message event",
            );
            return { id: messageId };
          },
          createAssistantMessage: async (messageInput) => {
            const messageId = newGoatTaskMessageId();
            await requireLeaseWrite(
              store.createMessage({
                id: input.task.id,
                leaseId,
                leaseOwner,
                now: new Date(),
                messageId,
                role: "assistant",
                status: "running",
                content: messageInput.content,
                modelMessage: messageInput.modelMessage,
              }),
              "create assistant message",
            );
            return { id: messageId };
          },
          updateMessageContent: async (messageInput) => {
            await requireLeaseWrite(
              store.updateMessageContent({
                id: input.task.id,
                leaseId,
                leaseOwner,
                now: new Date(),
                messageId: messageInput.messageId,
                content: messageInput.content,
              }),
              "update message content",
            );
          },
          completeMessage: async (messageInput) => {
            await requireLeaseWrite(
              store.completeMessage({
                id: input.task.id,
                leaseId,
                leaseOwner,
                now: new Date(),
                messageId: messageInput.messageId,
                content: messageInput.content,
                modelMessage: messageInput.modelMessage,
              }),
              "complete message",
            );
          },
          failMessage: async (messageInput) => {
            await requireLeaseWrite(
              store.failMessage({
                id: input.task.id,
                leaseId,
                leaseOwner,
                now: new Date(),
                messageId: messageInput.messageId,
                error: messageInput.error,
                ...(messageInput.content ? { content: messageInput.content } : {}),
              }),
              "fail message",
            );
          },
          createToolMessage: async (messageInput) => {
            const messageId = newGoatTaskMessageId();
            await requireLeaseWrite(
              store.createMessage({
                id: input.task.id,
                leaseId,
                leaseOwner,
                now: new Date(),
                messageId,
                role: "tool",
                status: "running",
                content: "",
                modelMessage: {
                  role: "tool",
                  toolCallId: messageInput.toolCallId,
                  content: "",
                },
                toolName: messageInput.toolName,
                toolCallId: messageInput.toolCallId,
              }),
              "create tool message",
            );
            return { id: messageId };
          },
          completeToolMessage: async (messageInput) => {
            const content = stringifyToolPayload(messageInput.output);
            await requireLeaseWrite(
              store.completeMessage({
                id: input.task.id,
                leaseId,
                leaseOwner,
                now: new Date(),
                messageId: messageInput.messageId,
                content,
                modelMessage: {
                  role: "tool",
                  toolCallId: messageInput.toolCallId,
                  content,
                },
              }),
              "complete tool message",
            );
          },
          failToolMessage: async (messageInput) => {
            await requireLeaseWrite(
              store.failMessage({
                id: input.task.id,
                leaseId,
                leaseOwner,
                now: new Date(),
                messageId: messageInput.messageId,
                content: messageInput.error,
                error: messageInput.error,
              }),
              "fail tool message",
            );
          },
          appendEvent: async (eventInput) => {
            await requireLeaseWrite(
              store.appendEvent({
                id: input.task.id,
                leaseId,
                leaseOwner,
                now: new Date(),
                type: eventInput.type,
                payload: eventInput.payload ?? {},
                messageId: eventInput.messageId ?? null,
              }),
              "append event",
            );
          },
          recordModelUsage: async (usageInput) => {
            const usage = normalizeModelUsage(usageInput.usage);
            const calculatedCost =
              usageInput.costOverride ??
              calculateModelUsageCost({
                modelName: usageInput.modelName,
                inputTokens: usage.inputTokens,
                inputNoCacheTokens: usage.inputNoCacheTokens,
                inputCacheReadTokens: usage.inputCacheReadTokens,
                inputCacheWriteTokens: usage.inputCacheWriteTokens,
                outputTokens: usage.outputTokens,
              });
            await requireLeaseWrite(
              store.recordModelUsage({
                id: input.task.id,
                leaseId,
                leaseOwner,
                now: new Date(),
                messageId: usageInput.messageId ?? null,
                phase: usageInput.phase,
                stepIndex: usageInput.stepIndex,
                modelProvider: usageInput.modelProvider,
                modelName: usageInput.modelName,
                responseId: usageInput.responseId ?? null,
                responseModelId: usageInput.responseModelId ?? null,
                finishReason: usageInput.finishReason ?? null,
                rawFinishReason: usageInput.rawFinishReason ?? null,
                usage,
                providerCreatedAt: usageInput.providerCreatedAt ?? null,
                cost: {
                  providerCostUsdMicros: calculatedCost.providerCostUsdMicros,
                  platformFeeUsdMicros: calculatedCost.platformFeeUsdMicros,
                  totalCostUsdMicros: calculatedCost.totalCostUsdMicros,
                  costBasis: calculatedCost.costBasis,
                },
              }),
              "record model usage",
            );
            recordGoatModelCost({
              costUsdMicros: calculatedCost.totalCostUsdMicros,
              attributes: {
                "goat.model": usageInput.modelName,
                "goat.surface": "task",
              },
            });
          },
          recordToolUsage: async (usageInput) => {
            const cost = calculateHostedToolUsageCost({
              provider: usageInput.usage.provider,
              operation: usageInput.usage.operation,
              providerCostUsdMicros: usageInput.usage.costUsdMicros,
              ...(usageInput.usage.costSource ? { costSource: usageInput.usage.costSource } : {}),
            });
            await requireLeaseWrite(
              store.recordToolUsage({
                id: input.task.id,
                leaseId,
                leaseOwner,
                now: new Date(),
                messageId: usageInput.messageId ?? null,
                toolCallId: usageInput.toolCallId,
                toolName: usageInput.toolName,
                provider: usageInput.usage.provider,
                operation: usageInput.usage.operation,
                providerRequestId: usageInput.usage.providerRequestId ?? null,
                rawUsage: usageInput.usage.rawUsage,
                cost: {
                  providerCostUsdMicros: cost.providerCostUsdMicros,
                  platformFeeUsdMicros: cost.platformFeeUsdMicros,
                  totalCostUsdMicros: cost.totalCostUsdMicros,
                  costBasis: cost.costBasis,
                },
              }),
              "record tool usage",
            );
          },
          recordSandboxUsage: async (usageInput) => {
            const cost = calculateSandboxUsageCost({
              template: usageInput.template,
              vcpu: usageInput.vcpu ?? 0,
              ramMiB: usageInput.ramMib ?? 0,
              activeMs: usageInput.activeMs,
            });
            await requireLeaseWrite(
              store.recordSandboxUsage({
                id: input.task.id,
                leaseId,
                leaseOwner,
                now: new Date(),
                messageId: usageInput.messageId ?? null,
                sandboxId: usageInput.sandboxId,
                template: usageInput.template,
                vcpu: usageInput.vcpu,
                ramMib: usageInput.ramMib,
                startedAt: usageInput.startedAt,
                endedAt: usageInput.endedAt,
                activeMs: usageInput.activeMs,
                rawMetrics: usageInput.rawMetrics ?? {},
                cost: {
                  providerCostUsdMicros: cost.providerCostUsdMicros,
                  platformFeeUsdMicros: cost.platformFeeUsdMicros,
                  totalCostUsdMicros: cost.totalCostUsdMicros,
                  costBasis: cost.costBasis,
                },
              }),
              "record sandbox usage",
            );
          },
          updateCodexEngineSessionId: async (codexEngineSessionId) => {
            await requireLeaseWrite(
              store.updateCodexEngineSessionId({
                id: input.task.id,
                leaseId,
                leaseOwner,
                now: new Date(),
                codexEngineSessionId,
              }),
              "update Codex engine session id",
            );
          },
        },
        reportStage: async (stage, patch = {}) => {
          if (patch.debugTrace) {
            latestDebugTrace = mergeGoatTaskDebugTrace(patch.debugTrace, latestDebugTrace);
          }
          if (patch.harnessSpec) {
            currentModel = patch.harnessSpec.model;
          }
          const active = await store.updateStage({
            id: input.task.id,
            leaseId,
            leaseOwner,
            now: new Date(),
            stage,
            ...patch,
          });
          if (!active) handleLeaseLost();
          recordCurrentStageDuration();
          currentStage = stage;
          stageStartedAt = performance.now();
          runSpan.setAttributes({
            ...baseAttributes,
            "goat.model": currentModel,
            "goat.stage": stage,
          });
        },
      }),
    );
    if (!leaseActive) {
      finishAbortedTelemetry();
      return;
    }
    const finalAttributes = {
      ...baseAttributes,
      "goat.model": result.harnessSpec.model,
    };
    await requireLeaseWrite(
      runSpan.runInContext(() =>
        withGoatSpan(GOAT_SPANS.taskComplete, finalAttributes, () =>
          store.complete({
            id: input.task.id,
            displayId: input.task.displayId,
            leaseId,
            leaseOwner,
            now: new Date(),
            result: result.result,
            harnessSpec: result.harnessSpec,
            debugTrace: mergeGoatTaskDebugTrace(result.debugTrace, latestDebugTrace),
            reportedOutcome: result.reportedOutcome ?? null,
            outcomeComment: result.outcomeComment ?? null,
          }),
        ),
      ),
      "complete task",
    );
    recordCurrentStageDuration();
    runSpan.end({
      ...finalAttributes,
      "goat.status": "succeeded",
      "goat.stage": "completed",
      "goat.outcome": "success",
    });
    recordGoatTaskRun({
      durationMs: Math.round(performance.now() - runStartedAt),
      outcome: "success",
      attributes: {
        ...finalAttributes,
        "goat.status": "succeeded",
        "goat.stage": "completed",
      },
    });
    logTaskRunFinished({
      outcome: "success",
      status: "succeeded",
      stage: "completed",
    });
  } catch (error) {
    if (leaseActive) {
      const active = await runSpan.runInContext(() =>
        withGoatSpan(GOAT_SPANS.taskFail, baseAttributes, () =>
          store.fail({
            id: input.task.id,
            displayId: input.task.displayId,
            leaseId,
            leaseOwner,
            now: new Date(),
            error: errorMessage(error),
            ...debugTracePatch(error),
          }),
        ),
      );
      if (!active) handleLeaseLost();
      recordCurrentStageDuration();
      const failureAttributes = {
        ...baseAttributes,
        "goat.model": currentModel,
      };
      const failureCategory = runSpan.fail(error, failureAttributes);
      runSpan.end({
        ...failureAttributes,
        "goat.status": "failed",
        "goat.stage": "failed",
        "goat.outcome": "failure",
        "goat.failure_category": failureCategory,
      });
      recordGoatTaskRun({
        durationMs: Math.round(performance.now() - runStartedAt),
        outcome: "failure",
        attributes: {
          ...failureAttributes,
          "goat.status": "failed",
          "goat.stage": "failed",
          "goat.failure_category": failureCategory,
        },
      });
      logTaskRunFinished({
        outcome: "failure",
        status: "failed",
        stage: "failed",
        failureCategory,
      });
    } else {
      finishAbortedTelemetry();
    }
    throw error;
  } finally {
    clearInterval(heartbeatTimer);
  }
}

function mergeGoatTaskDebugTrace(
  primary: GoatTaskDebugTrace,
  fallback: GoatTaskDebugTrace | undefined,
): GoatTaskDebugTrace {
  if (!fallback) return primary;
  const merged: GoatTaskDebugTrace = {};
  const schemaVersion = primary.schemaVersion ?? fallback.schemaVersion;
  const planner = primary.planner ?? fallback.planner;
  const harness = primary.harness ?? fallback.harness;
  if (schemaVersion) merged.schemaVersion = schemaVersion;
  if (planner) merged.planner = planner;
  if (harness) merged.harness = harness;
  return merged;
}

export function startGoatTaskWorker(
  env: RunnerEnv,
  options: {
    store?: GoatTaskStore;
    executor?: GoatTaskExecutor;
    concurrency?: number;
    pollIntervalMs?: number;
  } = {},
) {
  const store = options.store ?? createDbGoatTaskStore();
  const executor = options.executor ?? executeGoatTask;
  const concurrency = Math.max(1, options.concurrency ?? Math.min(2, env.workerConcurrency));
  const pollIntervalMs = Math.max(50, options.pollIntervalMs ?? 1_000);
  const active = new Set<Promise<void>>();
  let stopped = false;
  let pendingWake = false;
  let wake: (() => void) | null = null;

  const notify = () => {
    if (wake) {
      wake();
    } else {
      pendingWake = true;
    }
  };

  const waitForPollOrWake = () => {
    if (pendingWake) {
      pendingWake = false;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, pollIntervalMs);
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });
  };

  const runLoop = async () => {
    while (!stopped) {
      try {
        while (!stopped && active.size < concurrency) {
          const task = await claimNextGoatTask({
            leaseOwner: env.instanceId,
            store,
            leaseTtlMs: env.jobLeaseTtlMs,
          });
          if (!task) break;
          const running = runClaimedGoatTask({ task, env, store, executor })
            .catch((error) => {
              captureException(error, {
                event: "opencompany.goat_task_failed",
                task_id: task.id,
              });
              logger.error("Goat task failed", {
                event: "opencompany.goat_task_failed",
                task_id: task.id,
                error,
              });
            })
            .finally(() => active.delete(running));
          active.add(running);
        }
      } catch (error) {
        captureException(error, { event: "opencompany.goat_task_worker_failed" });
        logger.error("Goat task worker failed", {
          event: "opencompany.goat_task_worker_failed",
          error,
        });
      }
      if (stopped) break;
      await waitForPollOrWake();
    }
  };

  const loop = runLoop();
  return {
    notify,
    activeCount: () => active.size,
    stop: async () => {
      stopped = true;
      notify();
      await loop;
      await Promise.allSettled(Array.from(active));
    },
  };
}

function requireTaskLease(task: GoatTask, field: "leaseId" | "leaseOwner") {
  const value = task[field];
  if (!value) {
    throw new Error(`Claimed Goat task ${task.id} is missing ${field}.`);
  }
  return value;
}

function newGoatTaskLeaseId() {
  return `goat_task_${randomUUID()}`;
}

function newGoatTaskMessageId() {
  return `goat_task_msg_${randomUUID()}`;
}

function newGoatChatMessageId() {
  return `goat_chat_msg_${randomUUID()}`;
}

function goatTaskSucceededChatNotification(input: { displayId: string; result: string }) {
  const taskLink = `[${input.displayId}](/tasks/${encodeURIComponent(input.displayId)})`;
  const trimmed = input.result.trim();
  if (!trimmed) return `Task ${taskLink} finished.`;
  return `Task ${taskLink} finished.\n\n${trimmed}`;
}

function goatTaskFailedChatNotification(input: { displayId: string; error: string }) {
  const taskLink = `[${input.displayId}](/tasks/${encodeURIComponent(input.displayId)})`;
  const trimmed = input.error.trim();
  if (!trimmed) return `Task ${taskLink} failed.`;
  return `Task ${taskLink} failed.\n\n${trimmed}`;
}

function goatTaskLeaseExpiresAt(now: Date, ttlMs: number = GOAT_TASK_LEASE_TTL_MS) {
  return new Date(now.getTime() + ttlMs);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown Goat task error.";
}

const goatTaskColumnsSql = sql`
  task.id,
  task.display_id AS "displayId",
  task.name,
  task.user_workos_id AS "userWorkosId",
  task.prompt,
  task.model,
  task.session_id AS "sessionId",
  task.schedule_id AS "scheduleId",
  task.scheduled_for AS "scheduledFor",
  task.workflow_id AS "workflowId",
  task.workflow_brain_ref AS "workflowBrainRef",
  task.status,
  task.stage,
  task.result,
  task.error,
  task.reported_outcome AS "reportedOutcome",
  task.outcome_comment AS "outcomeComment",
  task.harness_spec AS "harnessSpec",
  task.debug_trace AS "debugTrace",
  task.codex_engine_session_id AS "codexEngineSessionId",
  task.sandbox_id AS "sandboxId",
  task.attempts,
  task.next_run_at AS "nextRunAt",
  task.lease_id AS "leaseId",
  task.lease_owner AS "leaseOwner",
  task.lease_expires_at AS "leaseExpiresAt",
  task.archived_at AS "archivedAt",
  task.created_at AS "createdAt",
  task.updated_at AS "updatedAt"
`;

type GoatTaskRow = Omit<
  GoatTask,
  "scheduledFor" | "nextRunAt" | "leaseExpiresAt" | "archivedAt" | "createdAt" | "updatedAt"
> & {
  scheduledFor: Date | string | null;
  nextRunAt: Date | string;
  leaseExpiresAt: Date | string | null;
  archivedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

function goatTaskFromRow(row: GoatTaskRow): GoatTask {
  return {
    ...row,
    scheduledFor: row.scheduledFor ? toDate(row.scheduledFor) : null,
    nextRunAt: toDate(row.nextRunAt),
    leaseExpiresAt: row.leaseExpiresAt ? toDate(row.leaseExpiresAt) : null,
    archivedAt: row.archivedAt ? toDate(row.archivedAt) : null,
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
  };
}

function toDate(value: Date | string) {
  return value instanceof Date ? value : new Date(value);
}

function errorDebugTrace(error: unknown) {
  if (!error || typeof error !== "object") return undefined;
  const debugTrace = (error as { debugTrace?: unknown }).debugTrace;
  return debugTrace && typeof debugTrace === "object"
    ? (debugTrace as GoatTaskDebugTrace)
    : undefined;
}

function debugTracePatch(error: unknown) {
  const debugTrace = errorDebugTrace(error);
  return debugTrace ? { debugTrace } : {};
}

function stringifyToolPayload(value: unknown) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
