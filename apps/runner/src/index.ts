import "./load-env";
import {
  createLogger,
  flushObservability,
  isObservabilityEnabled,
  setExceptionReporter,
} from "@opencompany/observability";
import { flushBraintrust } from "@opencompany/observability/braintrust";
import * as Sentry from "@sentry/bun";
import { listActiveRuns } from "./active-runs";
import { assertRunnerDbConfig, closeDb } from "./db";
import { flushAllSessionStreams } from "./durable-streams";
import { loadEnv } from "./env";
import { startRunnerJobWorker } from "./jobs";
import { createServer } from "./server";
import {
  finalizeOrphanedAbortingSessions,
  interruptActiveRuns,
  interruptStaleActiveRuns,
} from "./session-interruptions";

const logger = createLogger({ service: "opencompany-runner", runtime: "index" });
const RENDER_SHUTDOWN_INTERRUPT_AFTER_MS = 270_000;

initializeExceptionReporting();

const env = loadEnv();
assertRunnerDbConfig();
const jobWorker = startRunnerJobWorker(env, {
  concurrency: env.workerConcurrency,
  // Reconcile both orphaned-run shapes on the same cadence: runs whose heartbeat went stale, and
  // sessions stuck in the transient `aborting` state with no live lease to finalize them.
  staleRunSweep: async () => {
    const [interrupted, finalized] = await Promise.all([
      interruptStaleActiveRuns(),
      finalizeOrphanedAbortingSessions(),
    ]);
    return interrupted + finalized;
  },
});
const server = createServer(env, { onJobEnqueued: jobWorker.notify });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    logger.info("Runner shutdown started", {
      event: "opencompany.runner_shutdown_started",
      signal,
      active_job_count: jobWorker.activeCount(),
      active_run_count: listActiveRuns().length,
    });
    // Stop accepting work and drain in-flight jobs/requests first, flush any pending
    // Durable Stream batches so live viewers don't lose the tail of an in-flight turn,
    // then close the DB pool so no checked-out connection is cut mid-query, then flush
    // telemetry.
    void Promise.allSettled([
      jobWorker.stop({
        interruptAfterMs: RENDER_SHUTDOWN_INTERRUPT_AFTER_MS,
        onInterrupt: async () => {
          logger.warn("Runner shutdown interrupting runs", {
            event: "opencompany.runner_shutdown_interrupting_runs",
            active_job_count: jobWorker.activeCount(),
            active_run_count: listActiveRuns().length,
          });
          const interrupted = await interruptActiveRuns("runner_shutdown");
          logger.warn("Runner shutdown interrupted runs", {
            event: "opencompany.runner_shutdown_interrupted_runs",
            interrupted_run_count: interrupted,
          });
        },
      }),
      server.close(),
    ])
      .then(() => Promise.allSettled([flushAllSessionStreams()]))
      .then(() => Promise.allSettled([closeDb()]))
      .then(() => {
        logger.info("Runner shutdown finished", {
          event: "opencompany.runner_shutdown_finished",
          signal,
        });
        return Promise.allSettled([flushObservability(), flushBraintrust()]);
      })
      .finally(() => {
        process.exit(0);
      });
  });
}

await server.listen({ host: "0.0.0.0", port: env.port });

function initializeExceptionReporting() {
  const dsn = process.env.BETTER_STACK_ERRORS_DSN?.trim();
  if (!isObservabilityEnabled() || !dsn) return;

  Sentry.init({
    dsn,
    environment: process.env.OBSERVABILITY_ENV ?? process.env.NODE_ENV ?? "development",
    release:
      process.env.OBSERVABILITY_RELEASE ??
      process.env.RENDER_GIT_COMMIT ??
      process.env.VERCEL_GIT_COMMIT_SHA,
    tracesSampleRate: 0,
  });

  setExceptionReporter({
    captureException(error, fields) {
      Sentry.withScope((scope) => {
        if (typeof fields.user_id === "string" && fields.user_id) {
          scope.setUser({ id: fields.user_id });
        }
        scope.setContext("opencompany", fields);
        for (const [key, value] of Object.entries(fields)) {
          if (
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean"
          ) {
            scope.setTag(key, String(value));
          }
        }
        Sentry.captureException(error);
      });
    },
    flush() {
      return Sentry.flush();
    },
  });
}
