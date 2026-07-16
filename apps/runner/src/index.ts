import "./load-env";
import {
  registerGoatNodeObservability,
  shutdownGoatNodeObservability,
} from "@opencompany/goat-observability/node";
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
import { sweepDeadParentDelegatedChildren, sweepDelegationBackstop } from "./delegation";
import { flushAllSessionStreams } from "./durable-streams";
import { loadEnv } from "./env";
import { setGoatBrainImportWakeup, startGoatBrainImportWorker } from "./goat-brain-import-worker";
import { setGoatBrainIngestWakeup, startGoatBrainIngestWorker } from "./goat-brain-ingest-worker";
import { setGoatCodexChatWakeup, startGoatCodexChatWorker } from "./goat-codex-chat-worker";
import { startGoatGmailFlushWorker } from "./goat-gmail-flush-worker";
import { startGoatGmailPollWorker } from "./goat-gmail-poll-worker";
import {
  setGoatGoogleDriveSyncWakeup,
  startGoatGoogleDriveSyncWorker,
} from "./goat-google-drive-sync-worker";
import { startGoatGranolaPollWorker } from "./goat-granola-poll-worker";
import { startGoatLinearFlushWorker } from "./goat-linear-flush-worker";
import { startGoatTaskScheduleWorker } from "./goat-scheduler";
import { startGoatSlackFlushWorker } from "./goat-slack-flush-worker";
import { setGoatTaskWakeup, startGoatTaskWorker } from "./goat-worker";
import { setRunnerJobWakeup, startRunnerJobWorker } from "./jobs";
import { settleExpiredBrokerTokens } from "./llm-broker-tokens";
import { assertPreviewIdentity } from "./preview-guard";
import { createServer } from "./server";
import { interruptActiveRuns, interruptStaleActiveRuns } from "./session-interruptions";

const logger = createLogger({
  service: "opencompany-runner",
  runtime: "index",
});
// Shutdown budget. Render sends SIGTERM on deploy and SIGKILLs after
// `maxShutdownDelaySeconds` (300s, render.yaml). An interrupted turn is non-retryable —
// the job layer treats post-lease failures as terminal (see MessageTurnFailedError) and
// the user has to resend — so we drain in-flight runs for most of the grace window: turns
// that finish within it continue seamlessly across the deploy. The split below leaves
// ~60s after the interrupt fires for the interrupt writes, the aborted jobs' unwinding
// (bounded below), the stream flush, and the pool close to land before the hard kill.
const RENDER_SHUTDOWN_INTERRUPT_AFTER_MS = 240_000;
const RENDER_SHUTDOWN_POST_INTERRUPT_WAIT_MS = 30_000;

initializeExceptionReporting();
registerGoatNodeObservability({ serviceName: "opencompany-runner-goat" });
installProcessErrorBackstop();

const env = loadEnv();
assertRunnerDbConfig();
// Refuse to boot a preview runner that can't prove its DB belongs to its preview branch,
// and refuse to boot a prod runner carrying stray preview identity. This makes "preview
// runner polling the prod job queue" structurally impossible (issue #351 §6).
await assertPreviewIdentity();
const jobWorker = startRunnerJobWorker(env, {
  concurrency: env.workerConcurrency,
  // Piggyback the LLM-broker leftover settlement on the 60s stale-run sweep: tokens left
  // unsettled by a runner death mid-delegation get billed here. Cheap partial-index scan;
  // the settlement CAS makes it safe across instances.
  staleRunSweep: async () => {
    const [interrupted, settledBrokerTokens] = await Promise.all([
      interruptStaleActiveRuns(),
      settleExpiredBrokerTokens().catch((error) => {
        logger.warn("LLM broker leftover settlement failed", {
          event: "opencompany.llm_broker_sweep_failed",
          error,
        });
        return 0;
      }),
      // Delegation safety nets: re-wake any parent parked awaiting children that have all finished
      // (lost-wake backstop), and abort children orphaned by a dead parent.
      sweepDelegationBackstop().catch((error) => {
        logger.warn("Delegation backstop sweep failed", {
          event: "opencompany.delegation_backstop_sweep_failed",
          error,
        });
        return 0;
      }),
      sweepDeadParentDelegatedChildren().catch((error) => {
        logger.warn("Dead-parent delegated child sweep failed", {
          event: "opencompany.delegation_dead_parent_sweep_failed",
          error,
        });
        return 0;
      }),
    ]);
    if (settledBrokerTokens > 0) {
      logger.info("Settled leftover LLM broker tokens", {
        event: "opencompany.llm_broker_sweep_settled",
        settled_count: settledBrokerTokens,
      });
    }
    return interrupted;
  },
});
const goatTaskWorker = env.goatTaskWorkerEnabled ? startGoatTaskWorker(env) : null;
const goatCodexChatWorker = env.goatTaskWorkerEnabled ? startGoatCodexChatWorker(env) : null;
const goatBrainIngestWorker = env.goatTaskWorkerEnabled ? startGoatBrainIngestWorker(env) : null;
const goatBrainImportWorker = env.goatTaskWorkerEnabled ? startGoatBrainImportWorker(env) : null;
const goatSlackFlushWorker = env.goatTaskWorkerEnabled ? startGoatSlackFlushWorker() : null;
const goatLinearFlushWorker = env.goatTaskWorkerEnabled ? startGoatLinearFlushWorker() : null;
const goatGmailPollWorker = env.goatTaskWorkerEnabled ? startGoatGmailPollWorker(env) : null;
const goatGmailFlushWorker = env.goatTaskWorkerEnabled ? startGoatGmailFlushWorker(env) : null;
const goatGranolaPollWorker = env.goatTaskWorkerEnabled ? startGoatGranolaPollWorker() : null;
const goatGoogleDriveSyncWorker = env.goatTaskWorkerEnabled
  ? startGoatGoogleDriveSyncWorker(env)
  : null;
const goatTaskScheduleWorker =
  env.goatTaskWorkerEnabled && goatTaskWorker
    ? startGoatTaskScheduleWorker({ onTaskCreated: goatTaskWorker.notify })
    : null;
if (!goatTaskWorker) {
  logger.info("Goat task worker disabled", {
    event: "opencompany.goat_task_worker_disabled",
  });
}
// Let any in-process enqueue (delegation spawn, child-finish parent-wake) nudge the worker
// immediately instead of waiting out the poll interval — the same wake the HTTP server uses.
setRunnerJobWakeup(jobWorker.notify);
setGoatTaskWakeup(() => {
  goatTaskWorker?.notify();
  goatTaskScheduleWorker?.notify();
});
setGoatBrainIngestWakeup(() => {
  goatBrainIngestWorker?.notify();
});
setGoatGoogleDriveSyncWakeup(() => {
  goatGoogleDriveSyncWorker?.notify();
});
setGoatBrainImportWakeup(() => {
  goatBrainImportWorker?.notify();
});
setGoatCodexChatWakeup(() => {
  goatCodexChatWorker?.notify();
});
const server = createServer(env, { onJobEnqueued: jobWorker.notify });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    logger.info("Runner shutdown started", {
      event: "opencompany.runner_shutdown_started",
      signal,
      active_job_count: jobWorker.activeCount(),
      active_goat_task_count: goatTaskWorker?.activeCount() ?? 0,
      active_goat_brain_ingest_count: goatBrainIngestWorker?.activeCount() ?? 0,
      active_goat_google_drive_sync_count: goatGoogleDriveSyncWorker?.activeCount() ?? 0,
      active_goat_brain_import_count: goatBrainImportWorker?.activeCount() ?? 0,
      active_run_count: listActiveRuns().length,
    });
    // Stop accepting work and drain in-flight jobs/requests first, flush any pending
    // Durable Stream batches so live viewers don't lose the tail of an in-flight turn,
    // then close the DB pool so no checked-out connection is cut mid-query, then flush
    // telemetry.
    void Promise.allSettled([
      jobWorker.stop({
        interruptAfterMs: RENDER_SHUTDOWN_INTERRUPT_AFTER_MS,
        postInterruptWaitMs: RENDER_SHUTDOWN_POST_INTERRUPT_WAIT_MS,
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
      goatTaskScheduleWorker?.stop() ?? Promise.resolve(),
      goatTaskWorker?.stop() ?? Promise.resolve(),
      goatCodexChatWorker?.stop() ?? Promise.resolve(),
      goatBrainIngestWorker?.stop() ?? Promise.resolve(),
      goatBrainImportWorker?.stop() ?? Promise.resolve(),
      goatSlackFlushWorker?.stop() ?? Promise.resolve(),
      goatLinearFlushWorker?.stop() ?? Promise.resolve(),
      goatGmailPollWorker?.stop() ?? Promise.resolve(),
      goatGmailFlushWorker?.stop() ?? Promise.resolve(),
      goatGranolaPollWorker?.stop() ?? Promise.resolve(),
      goatGoogleDriveSyncWorker?.stop() ?? Promise.resolve(),
      server.close(),
    ])
      .then(() => Promise.allSettled([flushAllSessionStreams()]))
      .then(() => Promise.allSettled([closeDb()]))
      .then(() => {
        logger.info("Runner shutdown finished", {
          event: "opencompany.runner_shutdown_finished",
          signal,
        });
        return Promise.allSettled([
          flushObservability(),
          flushBraintrust(),
          shutdownGoatNodeObservability(),
        ]);
      })
      .finally(() => {
        process.exit(0);
      });
  });
}

await server.listen({ host: "0.0.0.0", port: env.port });

// The runner is a single Bun process hosting every in-flight session on the instance, so a
// stray unhandled rejection must not exit it. That is exactly how prod crashed on 2026-06-10:
// an async e2b stream callback rejected with RunAbortError outside any awaited chain and took
// down every other session with it. Per-run failures are already handled at the run/tool
// boundaries; this backstop logs + reports anything that escapes them and keeps serving.
function installProcessErrorBackstop() {
  process.on("unhandledRejection", (reason) => {
    reportProcessError("opencompany.runner_unhandled_rejection", reason);
  });
  process.on("uncaughtException", (error) => {
    void reportFatalProcessError("opencompany.runner_uncaught_exception", error);
  });
}

async function reportFatalProcessError(event: string, error: unknown) {
  reportProcessError(event, error);
  try {
    await Promise.allSettled([flushObservability(), flushBraintrust()]);
  } finally {
    process.exit(1);
  }
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
