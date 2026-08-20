import { type Actor, TASK_WRITE_PERMISSION, TaskApplicationService } from "@opencompany/core";
import type { HarnessSpec } from "@opencompany/db/product-schema";
import { PostgresTaskRepository } from "@opencompany/db/task-repository";
import { captureException, createLogger } from "@opencompany/observability";
import { type SQL, sql } from "drizzle-orm";
import { getDb } from "./db";
import { createPollingWorker } from "./polling-worker";
import { rowsFromExecute } from "./sql-exec";

const logger = createLogger({ service: "opencompany-runner", runtime: "workflow-events" });
const WORKFLOW_EVENT_POLL_INTERVAL_MS = 1_000;
const WORKFLOW_EVENT_MAX_ATTEMPTS = 8;
const WORKFLOW_EVENT_MAX_RETRY_DELAY_MS = 15 * 60_000;

type WorkflowEventTransaction = {
  execute(query: SQL): Promise<unknown>;
};

type PendingWorkflowEvent = {
  id: string;
  workspaceId: string;
  userWorkosId: string;
  workflowSlug: string;
  workflowName: string;
  goal: string;
  harnessSpec: HarnessSpec;
  attemptCount: number;
  eligible: boolean;
};

type WorkflowEventDependencies = {
  db?: Pick<ReturnType<typeof getDb>, "transaction">;
  createTask?: (
    tx: WorkflowEventTransaction,
    event: PendingWorkflowEvent,
    now: Date,
  ) => Promise<{ taskId: string }>;
};

export async function createNextWorkflowEventTask(
  now = new Date(),
  dependencies: WorkflowEventDependencies = {},
) {
  const db = dependencies.db ?? getDb();
  return db.transaction(async (tx) => {
    const event = rowsFromExecute<PendingWorkflowEvent>(
      await tx.execute(sql`
        SELECT
          event.id,
          event.workspace_id AS "workspaceId",
          event.user_workos_id AS "userWorkosId",
          event.workflow_slug AS "workflowSlug",
          event.workflow_name AS "workflowName",
          event.goal,
          event.harness_spec AS "harnessSpec",
          event.attempt_count AS "attemptCount",
          EXISTS (
            SELECT 1
            FROM goat.users AS actor_user
            JOIN goat.workspace_members AS member
              ON member.user_workos_id = actor_user.workos_user_id
             AND member.workspace_id = event.workspace_id
            WHERE actor_user.workos_user_id = event.user_workos_id
              AND actor_user.task_spawning_enabled = true
              AND actor_user.onboarded_at IS NOT NULL
          ) AS eligible
        FROM goat.workflow_event_runs AS event
        WHERE event.status = 'pending'
          AND event.next_attempt_at <= ${now}
        ORDER BY event.next_attempt_at ASC, event.created_at ASC, event.id ASC
        FOR UPDATE OF event SKIP LOCKED
        LIMIT 1
      `),
    )[0];
    if (!event) return { status: "none" as const };

    if (!event.eligible) {
      await tx.execute(sql`
        UPDATE goat.workflow_event_runs
        SET status = 'ignored', updated_at = ${now}
        WHERE id = ${event.id}
      `);
      return { status: "ignored" as const, eventId: event.id };
    }

    let created: { taskId: string };
    try {
      created = await (dependencies.createTask ?? createWorkflowEventTask)(tx, event, now);
    } catch (error) {
      const attemptCount = event.attemptCount + 1;
      const failed = attemptCount >= WORKFLOW_EVENT_MAX_ATTEMPTS;
      const nextAttemptAt = new Date(now.getTime() + workflowEventRetryDelayMs(attemptCount));
      const lastError = workflowEventErrorMessage(error);
      await tx.execute(sql`
        UPDATE goat.workflow_event_runs
        SET
          status = ${failed ? "failed" : "pending"},
          attempt_count = ${attemptCount},
          next_attempt_at = ${nextAttemptAt},
          last_error = ${lastError},
          updated_at = ${now}
        WHERE id = ${event.id}
      `);
      logger.warn("Workflow event task creation failed", {
        event: "opencompany.workflow_event_task_creation_failed",
        workflow_event_id: event.id,
        attempt_count: attemptCount,
        retrying: !failed,
        error_message: lastError,
      });
      return { status: failed ? ("failed" as const) : ("retry" as const), eventId: event.id };
    }

    await tx.execute(sql`
      UPDATE goat.workflow_event_runs
      SET
        status = 'created',
        task_id = ${created.taskId},
        attempt_count = ${event.attemptCount + 1},
        last_error = NULL,
        updated_at = ${now}
      WHERE id = ${event.id}
    `);
    return { status: "created" as const, eventId: event.id, taskId: created.taskId };
  });
}

async function createWorkflowEventTask(
  tx: WorkflowEventTransaction,
  event: PendingWorkflowEvent,
  now: Date,
) {
  const harnessSpec = eventHarness(event);
  const actor: Actor = {
    userId: event.userWorkosId,
    workspaceId: event.workspaceId,
    role: "member",
    permissions: [TASK_WRITE_PERMISSION],
    authenticationMethod: "service",
  };
  const repository = new PostgresTaskRepository((query) => tx.execute(query), {
    now: () => now,
    resolveHarness: async () => harnessSpec,
    compatibility: { initialMessageContent: harnessSpec.initialUserMessage },
  });
  const created = await new TaskApplicationService(repository).createTask(actor, {
    idempotencyKey: `workflow-event:${event.id}`,
    name: event.workflowName,
    goal: event.goal,
    engine: harnessSpec.engine,
    model: harnessSpec.model,
    source: "workflow",
    workflowId: event.workflowSlug,
  });
  return { taskId: created.task.id };
}

export function startWorkflowEventWorker(
  input: { pollIntervalMs?: number; onTaskCreated?: () => void } = {},
) {
  return createPollingWorker({
    pollIntervalMs: Math.max(250, input.pollIntervalMs ?? WORKFLOW_EVENT_POLL_INTERVAL_MS),
    poll: async ({ signal, stopping }) => {
      while (!stopping()) {
        signal.throwIfAborted();
        const result = await createNextWorkflowEventTask();
        if (result.status === "none") break;
        if (result.status === "created") input.onTaskCreated?.();
      }
    },
    onError: (error) => {
      captureException(error, { event: "opencompany.workflow_event_worker_failed" });
      logger.error("Workflow event worker failed", {
        event: "opencompany.workflow_event_worker_failed",
        error,
      });
    },
  });
}

export function eventHarness(
  event: Pick<PendingWorkflowEvent, "workflowName" | "goal" | "harnessSpec">,
) {
  return {
    ...event.harnessSpec,
    initialUserMessage: [`Task: ${event.workflowName}`, "", event.goal].join("\n"),
  };
}

export function workflowEventRetryDelayMs(attemptCount: number) {
  return Math.min(WORKFLOW_EVENT_MAX_RETRY_DELAY_MS, 1_000 * 2 ** Math.max(0, attemptCount - 1));
}

function workflowEventErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 2_000);
}
