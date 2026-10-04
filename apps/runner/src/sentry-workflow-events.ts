import { admitSentryTask } from "@opencompany/db/sentry";
import { createLogger } from "@opencompany/observability";
import { sql } from "drizzle-orm";
import { sentryTaskGoal } from "./sentry-task-context";
import { rowsFromExecute } from "./sql-exec";
import type { WorkflowEventProviderAdapter } from "./workflow-event-worker";

const logger = createLogger({ service: "opencompany-runner", runtime: "workflow-events" });

// Sentry deliveries carry per-issue admission (active runs, cooldown, daily cap) and prior Task
// history. All of it runs inside the Task creation transaction, under the connection row lock.
export const sentryWorkflowEventAdapter: WorkflowEventProviderAdapter = {
  admit: (tx, event, now) => admitSentryTask(tx, event.id, now),

  suppressed(event, reason) {
    logger.info("Sentry run suppressed", {
      event: "opencompany.sentry_run_suppressed",
      workflow_event_id: event.id,
      reason,
    });
  },

  async goal(tx, event) {
    const prior = rowsFromExecute<{ id: string; result: string | null; links: string[] }>(
      await tx.execute(sql`
        SELECT task.id, left(task.result, 2000) AS result,
          ARRAY(SELECT url FROM goat.session_pull_requests WHERE chat_session_id = task.session_id LIMIT 5) AS links
        FROM goat.sentry_issue_runs prior
        JOIN goat.tasks task ON task.id = prior.task_id
        JOIN goat.sentry_issue_runs current ON current.event_run_id = ${event.id}
        WHERE prior.workspace_id = current.workspace_id AND prior.issue_id = current.issue_id
          AND task.status IN ('succeeded','failed','canceled')
        ORDER BY task.updated_at DESC, task.id DESC LIMIT 3
      `),
    );
    return sentryTaskGoal(event.goal, prior);
  },

  async started(tx, event, taskId, now) {
    await tx.execute(
      sql`UPDATE goat.sentry_issue_runs SET task_id = ${taskId}, started_at = ${now} WHERE event_run_id = ${event.id}`,
    );
    const [receipt] = rowsFromExecute<{ receivedAt: Date }>(
      await tx.execute(
        sql`SELECT receipt.received_at AS "receivedAt" FROM goat.sentry_webhook_receipts receipt JOIN goat.sentry_issue_runs run ON run.receipt_id = receipt.id WHERE run.event_run_id = ${event.id}`,
      ),
    );
    // Logged after commit, so the latency covers the whole path to a visible Task.
    return () =>
      logger.info("Sentry Task started", {
        event: "opencompany.sentry_task_started",
        workflow_event_id: event.id,
        workspace_id: event.workspaceId,
        task_id: taskId,
        receipt_to_task_ms: receipt
          ? Math.max(0, Date.now() - new Date(receipt.receivedAt).getTime())
          : null,
      });
  },
};
