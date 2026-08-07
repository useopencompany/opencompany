import "./load-env";
import {
  captureException,
  createLogger,
  flushObservability,
  isObservabilityEnabled,
  setExceptionReporter,
} from "@opencompany/observability";
import { flushBraintrust } from "@opencompany/observability/braintrust";
import { flushLatitude } from "@opencompany/telemetry/latitude";
import { registerNodeObservability, shutdownNodeObservability } from "@opencompany/telemetry/node";
import * as Sentry from "@sentry/bun";
import { startAttioFlushWorker } from "./attio-flush-worker";
import { setBrainImportWakeup, startBrainImportWorker } from "./brain-import-worker";
import { setBrainIngestWakeup, startBrainIngestWorker } from "./brain-ingest-worker";
import { assertRunnerDbConfig, closeDb } from "./db";
import { loadEnv } from "./env";
import { startFathomPollWorker } from "./fathom-poll-worker";
import { startGitHubFlushWorker } from "./github-flush-worker";
import { startGmailFlushWorker } from "./gmail-flush-worker";
import { startGmailPollWorker } from "./gmail-poll-worker";
import { setGoogleDriveSyncWakeup, startGoogleDriveSyncWorker } from "./google-drive-sync-worker";
import { startGranolaPollWorker } from "./granola-poll-worker";
import { startHubspotFlushWorker } from "./hubspot-flush-worker";
import { startLinearFlushWorker } from "./linear-flush-worker";
import { settleExpiredBrokerTokens } from "./llm-broker-tokens";
import { assertPreviewIdentity } from "./preview-guard";
import { startTaskScheduleWorker } from "./scheduler";
import { createServer } from "./server";
import { startSlackFlushWorker } from "./slack-flush-worker";
import {
  setCodexChatWakeup,
  startCodexChatWorker,
  sweepTerminalCodexChatSandboxes,
} from "./turn-worker";

const logger = createLogger({
  service: "opencompany-runner",
  runtime: "index",
});
// Render sends SIGTERM on deploy and SIGKILLs after `maxShutdownDelaySeconds` (300s,
// render.yaml). Workers stop claiming immediately, then active runner jobs and durable Codex
// turns get most of that window to finish in place. The remaining minute covers interruption or
// handoff, stream/telemetry flushes, and closing the DB pool before Render's hard kill.
const RENDER_SHUTDOWN_DRAIN_MS = 240_000;
const RENDER_SHUTDOWN_POST_DRAIN_WAIT_MS = 30_000;

initializeExceptionReporting();
registerNodeObservability({ serviceName: "opencompany-runner-goat" });
installProcessErrorBackstop();

const env = loadEnv();
assertRunnerDbConfig();
// Refuse to boot a preview runner that can't prove its DB belongs to its preview branch,
// and refuse to boot a prod runner carrying stray preview identity. This makes "preview
// runner polling the prod job queue" structurally impossible (issue #351 §6).
await assertPreviewIdentity();
// The LLM broker can be left holding unsettled tokens if a runner dies mid-delegation.
// Sweep them on the same 60s cadence the legacy stale-run sweep used: cheap partial-index
// scan, and the settlement CAS makes it safe across instances.
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
const codexChatWorker = env.taskWorkerEnabled
  ? startCodexChatWorker(env, {
      sandboxSweep: () =>
        sweepTerminalCodexChatSandboxes({
          idleTimeoutMs: env.codexChatIdleTimeoutMs,
        }),
    })
  : null;
const brainIngestWorker = env.taskWorkerEnabled ? startBrainIngestWorker(env) : null;
const brainImportWorker = env.taskWorkerEnabled ? startBrainImportWorker(env) : null;
const slackFlushWorker = env.taskWorkerEnabled ? startSlackFlushWorker() : null;
const linearFlushWorker = env.taskWorkerEnabled ? startLinearFlushWorker() : null;
const gitHubFlushWorker = env.taskWorkerEnabled ? startGitHubFlushWorker() : null;
const hubspotFlushWorker = env.taskWorkerEnabled ? startHubspotFlushWorker(env) : null;
const attioFlushWorker = env.taskWorkerEnabled ? startAttioFlushWorker() : null;
const gmailPollWorker = env.taskWorkerEnabled ? startGmailPollWorker(env) : null;
const gmailFlushWorker = env.taskWorkerEnabled ? startGmailFlushWorker(env) : null;
const granolaPollWorker = env.taskWorkerEnabled ? startGranolaPollWorker() : null;
const fathomPollWorker = env.taskWorkerEnabled ? startFathomPollWorker() : null;
const googleDriveSyncWorker = env.taskWorkerEnabled ? startGoogleDriveSyncWorker(env) : null;
const taskScheduleWorker = codexChatWorker
  ? startTaskScheduleWorker({
      onTaskCreated: () => {
        codexChatWorker.notify();
      },
    })
  : null;
if (!codexChatWorker) {
  logger.info("Task worker disabled", {
    event: "opencompany.goat_task_worker_disabled",
  });
}
setBrainIngestWakeup(() => {
  brainIngestWorker?.notify();
});
setGoogleDriveSyncWakeup(() => {
  googleDriveSyncWorker?.notify();
});
setBrainImportWakeup(() => {
  brainImportWorker?.notify();
});
setCodexChatWakeup(() => {
  codexChatWorker?.notify();
});
const server = createServer(env);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    logger.info("Runner shutdown started", {
      event: "opencompany.runner_shutdown_started",
      signal,
      active_goat_brain_ingest_count: brainIngestWorker?.activeCount() ?? 0,
      active_goat_google_drive_sync_count: googleDriveSyncWorker?.activeCount() ?? 0,
      active_goat_brain_import_count: brainImportWorker?.activeCount() ?? 0,
      active_goat_codex_chat_count: codexChatWorker?.activeCount() ?? 0,
    });
    clearInterval(llmBrokerSweepTimer);
    // Stop accepting work and drain in-flight requests first, then close the DB pool so
    // no checked-out connection is cut mid-query, then flush telemetry.
    void Promise.allSettled([
      taskScheduleWorker?.stop() ?? Promise.resolve(),
      codexChatWorker?.stop({
        handoffAfterMs: RENDER_SHUTDOWN_DRAIN_MS,
        postHandoffWaitMs: RENDER_SHUTDOWN_POST_DRAIN_WAIT_MS,
        onHandoff: (activeCount) => {
          logger.info("Runner shutdown handing off Codex chat turns", {
            event: "opencompany.runner_shutdown_handing_off_goat_codex_chat",
            active_goat_codex_chat_count: activeCount,
          });
        },
      }) ?? Promise.resolve(),
      brainIngestWorker?.stop() ?? Promise.resolve(),
      brainImportWorker?.stop() ?? Promise.resolve(),
      slackFlushWorker?.stop() ?? Promise.resolve(),
      linearFlushWorker?.stop() ?? Promise.resolve(),
      gitHubFlushWorker?.stop() ?? Promise.resolve(),
      hubspotFlushWorker?.stop() ?? Promise.resolve(),
      attioFlushWorker?.stop() ?? Promise.resolve(),
      gmailPollWorker?.stop() ?? Promise.resolve(),
      gmailFlushWorker?.stop() ?? Promise.resolve(),
      granolaPollWorker?.stop() ?? Promise.resolve(),
      fathomPollWorker?.stop() ?? Promise.resolve(),
      googleDriveSyncWorker?.stop() ?? Promise.resolve(),
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
          shutdownNodeObservability(),
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
