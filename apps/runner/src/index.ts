import "./load-env";
import {
  captureException,
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
import { assertPreviewIdentity } from "./preview-guard";
import { createServer } from "./server";
import { interruptActiveRuns, interruptStaleActiveRuns } from "./session-interruptions";

const logger = createLogger({ service: "opencompany-runner", runtime: "index" });
const RENDER_SHUTDOWN_INTERRUPT_AFTER_MS = 270_000;

initializeExceptionReporting();
installProcessErrorBackstop();

const env = loadEnv();
assertRunnerDbConfig();
// Refuse to boot a preview runner that can't prove its DB belongs to its preview branch,
// and refuse to boot a prod runner carrying stray preview identity. This makes "preview
// runner polling the prod job queue" structurally impossible (issue #351 §6).
await assertPreviewIdentity();
const jobWorker = startRunnerJobWorker(env, {
  concurrency: env.workerConcurrency,
  staleRunSweep: interruptStaleActiveRuns,
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

// The runner is a single Bun process hosting every in-flight session on the instance, so a
// stray unhandled rejection must not exit it — Bun (like Node ≥15) exits with code 1 by
// default. That is exactly how prod crashed on 2026-06-10: an async e2b stream callback
// rejected with RunAbortError outside any awaited chain and took down every other session
// with it. Per-run failures are already handled at the run/tool boundaries; this backstop
// logs + reports anything that escapes them and keeps the process serving.
function installProcessErrorBackstop() {
  process.on("unhandledRejection", (reason) => {
    reportProcessError("opencompany.runner_unhandled_rejection", reason);
  });
  process.on("uncaughtException", (error) => {
    reportProcessError("opencompany.runner_uncaught_exception", error);
  });
}

function reportProcessError(event: string, error: unknown) {
  try {
    logger.error("Runner trapped a process-level error", {
      event,
      error_name: error instanceof Error ? error.name : undefined,
      error_message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    captureException(error, { event });
  } catch {
    // Never let the backstop itself crash the process.
  }
}

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
