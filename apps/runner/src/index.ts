import "./load-env";
import { flushLatitude } from "@opencompany/goat-observability/latitude";
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
import { assertRunnerDbConfig, closeDb } from "./db";
import { loadEnv } from "./env";
import { startGoatAttioFlushWorker } from "./goat-attio-flush-worker";
import { setGoatBrainImportWakeup, startGoatBrainImportWorker } from "./goat-brain-import-worker";
import { setGoatBrainIngestWakeup, startGoatBrainIngestWorker } from "./goat-brain-ingest-worker";
import {
  setGoatCodexChatWakeup,
  startGoatCodexChatWorker,
  sweepTerminalGoatCodexChatSandboxes,
} from "./goat-codex-chat-worker";
import { startGoatFathomPollWorker } from "./goat-fathom-poll-worker";
import { startGoatGitHubFlushWorker } from "./goat-github-flush-worker";
import { startGoatGmailFlushWorker } from "./goat-gmail-flush-worker";
import { startGoatGmailPollWorker } from "./goat-gmail-poll-worker";
import {
  setGoatGoogleDriveSyncWakeup,
  startGoatGoogleDriveSyncWorker,
} from "./goat-google-drive-sync-worker";
import { startGoatGranolaPollWorker } from "./goat-granola-poll-worker";
import { startGoatHubspotFlushWorker } from "./goat-hubspot-flush-worker";
import { startGoatLinearFlushWorker } from "./goat-linear-flush-worker";
import { startGoatTaskScheduleWorker } from "./goat-scheduler";
import { startGoatSlackFlushWorker } from "./goat-slack-flush-worker";
import { settleExpiredBrokerTokens } from "./llm-broker-tokens";
import { createServer } from "./server";

const logger = createLogger({
  service: "opencompany-runner",
  runtime: "index",
});
// Render sends SIGTERM on deploy and SIGKILLs after `maxShutdownDelaySeconds` (300s,
// render.yaml). Workers stop claiming immediately, then active runner jobs and durable Goat Codex
// turns get most of that window to finish in place. The remaining minute covers interruption or
// handoff, stream/telemetry flushes, and closing the DB pool before Render's hard kill.
const RENDER_SHUTDOWN_DRAIN_MS = 240_000;
const RENDER_SHUTDOWN_POST_DRAIN_WAIT_MS = 30_000;

initializeExceptionReporting();
registerGoatNodeObservability({ serviceName: "opencompany-runner-goat" });
installProcessErrorBackstop();

const env = loadEnv();
assertRunnerDbConfig();
// The LLM broker can be left holding unsettled tokens if a runner dies mid-delegation.
// Sweep them every 60s; the partial-index scan is cheap and the settlement CAS makes it safe
// across instances.
const LLM_BROKER_SWEEP_INTERVAL_MS = 60_000;
const llmBrokerSweepTimer = setInterval(() => {
  void settleExpiredBrokerTokens()
    .then((settled) => {
      if (settled > 0) {
        logger.info("Settled leftover LLM broker tokens", {
          event: "opencompany.llm_broker_sweep_settled",
          settled_count: settled,
        });
      }
    })
    .catch((error) => {
      logger.warn("LLM broker leftover settlement failed", {
        event: "opencompany.llm_broker_sweep_failed",
        error,
      });
    });
}, LLM_BROKER_SWEEP_INTERVAL_MS);
const goatCodexChatWorker = env.goatTaskWorkerEnabled
  ? startGoatCodexChatWorker(env, {
      sandboxSweep: () =>
        sweepTerminalGoatCodexChatSandboxes({
          idleTimeoutMs: env.goatCodexChatIdleTimeoutMs,
        }),
    })
  : null;
const goatBrainIngestWorker = env.goatTaskWorkerEnabled ? startGoatBrainIngestWorker(env) : null;
const goatBrainImportWorker = env.goatTaskWorkerEnabled ? startGoatBrainImportWorker(env) : null;
const goatSlackFlushWorker = env.goatTaskWorkerEnabled ? startGoatSlackFlushWorker() : null;
const goatLinearFlushWorker = env.goatTaskWorkerEnabled ? startGoatLinearFlushWorker() : null;
const goatGitHubFlushWorker = env.goatTaskWorkerEnabled ? startGoatGitHubFlushWorker() : null;
const goatHubspotFlushWorker = env.goatTaskWorkerEnabled ? startGoatHubspotFlushWorker(env) : null;
const goatAttioFlushWorker = env.goatTaskWorkerEnabled ? startGoatAttioFlushWorker() : null;
const goatGmailPollWorker = env.goatTaskWorkerEnabled ? startGoatGmailPollWorker(env) : null;
const goatGmailFlushWorker = env.goatTaskWorkerEnabled ? startGoatGmailFlushWorker(env) : null;
const goatGranolaPollWorker = env.goatTaskWorkerEnabled ? startGoatGranolaPollWorker() : null;
const goatFathomPollWorker = env.goatTaskWorkerEnabled ? startGoatFathomPollWorker() : null;
const goatGoogleDriveSyncWorker = env.goatTaskWorkerEnabled
  ? startGoatGoogleDriveSyncWorker(env)
  : null;
const goatTaskScheduleWorker = goatCodexChatWorker
  ? startGoatTaskScheduleWorker({
      onTaskCreated: () => {
        goatCodexChatWorker.notify();
      },
    })
  : null;
if (!goatCodexChatWorker) {
  logger.info("Goat task worker disabled", {
    event: "opencompany.goat_task_worker_disabled",
  });
}
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
const server = createServer(env);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    logger.info("Runner shutdown started", {
      event: "opencompany.runner_shutdown_started",
      signal,
      active_goat_brain_ingest_count: goatBrainIngestWorker?.activeCount() ?? 0,
      active_goat_google_drive_sync_count: goatGoogleDriveSyncWorker?.activeCount() ?? 0,
      active_goat_brain_import_count: goatBrainImportWorker?.activeCount() ?? 0,
      active_goat_codex_chat_count: goatCodexChatWorker?.activeCount() ?? 0,
    });
    clearInterval(llmBrokerSweepTimer);
    // Stop accepting work and drain in-flight requests first, then close the DB pool so
    // no checked-out connection is cut mid-query, then flush telemetry.
    void Promise.allSettled([
      goatTaskScheduleWorker?.stop() ?? Promise.resolve(),
      goatCodexChatWorker?.stop({
        handoffAfterMs: RENDER_SHUTDOWN_DRAIN_MS,
        postHandoffWaitMs: RENDER_SHUTDOWN_POST_DRAIN_WAIT_MS,
        onHandoff: (activeCount) => {
          logger.info("Runner shutdown handing off Goat Codex chat turns", {
            event: "opencompany.runner_shutdown_handing_off_goat_codex_chat",
            active_goat_codex_chat_count: activeCount,
          });
        },
      }) ?? Promise.resolve(),
      goatBrainIngestWorker?.stop() ?? Promise.resolve(),
      goatBrainImportWorker?.stop() ?? Promise.resolve(),
      goatSlackFlushWorker?.stop() ?? Promise.resolve(),
      goatLinearFlushWorker?.stop() ?? Promise.resolve(),
      goatGitHubFlushWorker?.stop() ?? Promise.resolve(),
      goatHubspotFlushWorker?.stop() ?? Promise.resolve(),
      goatAttioFlushWorker?.stop() ?? Promise.resolve(),
      goatGmailPollWorker?.stop() ?? Promise.resolve(),
      goatGmailFlushWorker?.stop() ?? Promise.resolve(),
      goatGranolaPollWorker?.stop() ?? Promise.resolve(),
      goatFathomPollWorker?.stop() ?? Promise.resolve(),
      goatGoogleDriveSyncWorker?.stop() ?? Promise.resolve(),
      server.close(),
    ])
      .then(() => Promise.allSettled([closeDb()]))
      .then(() => {
        logger.info("Runner shutdown finished", {
          event: "opencompany.runner_shutdown_finished",
          signal,
        });
        return Promise.allSettled([
          flushObservability(),
          flushBraintrust(),
          flushLatitude(),
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
