import "./load-env";
import { RedisChatPresentationStream } from "@opencompany/chat-presentation";
import {
  captureException,
  createLogger,
  flushObservability,
  isObservabilityEnabled,
  setExceptionReporter,
} from "@opencompany/observability";
import { flushBraintrust } from "@opencompany/observability/braintrust";
import { METRICS, recordCounter } from "@opencompany/telemetry";
import { flushLatitude } from "@opencompany/telemetry/latitude";
import { registerNodeObservability, shutdownNodeObservability } from "@opencompany/telemetry/node";
import * as Sentry from "@sentry/bun";
import { startAttioFlushWorker } from "./attio-flush-worker";
import { setBrainImportWakeup, startBrainImportWorker } from "./brain-import-worker";
import { setBrainIngestWakeup, startBrainIngestWorker } from "./brain-ingest-worker";
import { startBrainWorkerAdmissionListener } from "./brain-worker-admission";
import {
  requireChatAttachmentCleanupToken,
  startChatAttachmentCleanupWorker,
} from "./chat-attachment-cleanup-worker";
import { startCodexChatSelfHealSweeper } from "./codex-chat-self-heal";
import {
  setCodexChatWakeup,
  startCodexChatWorker,
  sweepTerminalCodexChatSandboxes,
} from "./codex-chat-worker";
import { assertRunnerDbConfig, closeDb, getDbPool } from "./db";
import { loadEnv } from "./env";
import { startFathomPollWorker } from "./fathom-poll-worker";
import { startGmailFlushWorker } from "./gmail-flush-worker";
import { startGmailPollWorker } from "./gmail-poll-worker";
import { setGoogleDriveSyncWakeup, startGoogleDriveSyncWorker } from "./google-drive-sync-worker";
import { startGranolaPollWorker } from "./granola-poll-worker";
import { startHubspotFlushWorker } from "./hubspot-flush-worker";
import { startLinearFlushWorker } from "./linear-flush-worker";
import { settleExpiredBrokerTokens } from "./llm-broker-tokens";
import { drainRunnerTasks, type RunnerDrainTask, settlesWithin } from "./runner-shutdown";
import { startSandboxReconciler } from "./sandbox-reconciler";
import { startTaskScheduleWorker } from "./scheduler";
import { createServer } from "./server";
import { activeSlackBotEventCount, drainSlackBotEvents } from "./slack-bot-events";
import { startStuckWorkMonitor } from "./stuck-work-monitor";
import { setWikiIngestWakeup, startWikiIngestWorker } from "./wiki-ingest-worker";
import { startWorkflowEventWorker } from "./workflow-event-worker";

const logger = createLogger({
  service: "opencompany-runner",
  runtime: "index",
});
// Render sends SIGTERM on deploy and SIGKILLs after `maxShutdownDelaySeconds` (300s,
// render.yaml). Workers stop claiming immediately, then active runner jobs and durable opencompany Codex
// turns get most of that window to finish in place. The remaining minute covers interruption or
// handoff, stream/telemetry flushes, and closing the DB pool before Render's hard kill.
const RENDER_SHUTDOWN_DRAIN_MS = 230_000;
const RENDER_SHUTDOWN_POST_DRAIN_WAIT_MS = 30_000;
const RENDER_SHUTDOWN_DB_CLOSE_MS = 10_000;
const RENDER_SHUTDOWN_TELEMETRY_FLUSH_MS = 10_000;

initializeExceptionReporting();
registerNodeObservability({ serviceName: "opencompany-runner-goat" });
installProcessErrorBackstop();

const env = loadEnv();
const chatPresentation = createChatPresentationStream();
assertRunnerDbConfig();
if (env.taskWorkerEnabled) requireChatAttachmentCleanupToken(env);
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
const codexChatWorker = env.taskWorkerEnabled
  ? startCodexChatWorker(env, {
      sandboxSweep: () =>
        sweepTerminalCodexChatSandboxes({
          idleTimeoutMs: env.codexChatIdleTimeoutMs,
        }),
      ...(chatPresentation ? { presentationPublisher: chatPresentation } : {}),
    })
  : null;
const brainIngestWorker = env.taskWorkerEnabled ? startBrainIngestWorker(env) : null;
const wikiIngestWorker = env.taskWorkerEnabled ? startWikiIngestWorker(env) : null;
const brainImportWorker = env.taskWorkerEnabled ? startBrainImportWorker(env) : null;
const linearFlushWorker = env.taskWorkerEnabled ? startLinearFlushWorker() : null;
const hubspotFlushWorker = env.taskWorkerEnabled ? startHubspotFlushWorker(env) : null;
const attioFlushWorker = env.taskWorkerEnabled ? startAttioFlushWorker() : null;
const gmailPollWorker = env.taskWorkerEnabled ? startGmailPollWorker(env) : null;
const gmailFlushWorker = env.taskWorkerEnabled ? startGmailFlushWorker(env) : null;
const granolaPollWorker = env.taskWorkerEnabled ? startGranolaPollWorker() : null;
const fathomPollWorker = env.taskWorkerEnabled ? startFathomPollWorker() : null;
const googleDriveSyncWorker = env.taskWorkerEnabled ? startGoogleDriveSyncWorker(env) : null;
const chatAttachmentCleanupWorker = env.taskWorkerEnabled
  ? startChatAttachmentCleanupWorker(env, { pool: getDbPool() })
  : null;
const stuckWorkMonitor = env.taskWorkerEnabled
  ? startStuckWorkMonitor({
      turnThresholdMs: Math.max(env.codexTimeoutMs + 15 * 60_000, 20 * 60_000),
    })
  : null;
const codexChatSelfHealSweeper =
  env.taskWorkerEnabled && env.codexChatSelfHealEnabled ? startCodexChatSelfHealSweeper() : null;
const sandboxReconciler = env.taskWorkerEnabled
  ? startSandboxReconciler({ namespace: env.sandboxNamespace })
  : null;
const taskScheduleWorker = codexChatWorker
  ? startTaskScheduleWorker({
      onTaskCreated: () => {
        codexChatWorker.notify();
      },
    })
  : null;
const workflowEventWorker = codexChatWorker
  ? startWorkflowEventWorker({
      onTaskCreated: () => {
        codexChatWorker.notify();
      },
    })
  : null;
if (!codexChatWorker) {
  logger.info("opencompany task worker disabled", {
    event: "opencompany.goat_task_worker_disabled",
  });
}
setBrainIngestWakeup(() => {
  brainIngestWorker?.notify();
});
setWikiIngestWakeup(() => {
  wikiIngestWorker?.notify();
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
const brainWorkerAdmissionListener = env.taskWorkerEnabled
  ? startBrainWorkerAdmissionListener({
      pool: getDbPool(),
      callbacks: {
        brain_import: () => brainImportWorker?.notify(),
        brain_ingest: () => brainIngestWorker?.notify(),
        google_drive_sync: () => googleDriveSyncWorker?.notify(),
      },
    })
  : null;
const server = createServer(env);

let shutdownStarted = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    logger.info("Runner shutdown started", {
      event: "opencompany.runner_shutdown_started",
      signal,
      active_goat_brain_ingest_count: brainIngestWorker?.activeCount() ?? 0,
      active_goat_wiki_ingest_count: wikiIngestWorker?.activeCount() ?? 0,
      active_goat_google_drive_sync_count: googleDriveSyncWorker?.activeCount() ?? 0,
      active_goat_brain_import_count: brainImportWorker?.activeCount() ?? 0,
      active_goat_codex_chat_count: codexChatWorker?.activeCount() ?? 0,
      active_goat_slack_bot_event_count: activeSlackBotEventCount(),
    });
    clearInterval(llmBrokerSweepTimer);
    setBrainIngestWakeup(null);
    setWikiIngestWakeup(null);
    setGoogleDriveSyncWakeup(null);
    setBrainImportWakeup(null);
    setCodexChatWakeup(null);
    void shutdownRunner(signal);
  });
}

await server.listen({ host: "0.0.0.0", port: env.port });

async function shutdownRunner(signal: "SIGINT" | "SIGTERM") {
  const tasks = [
    runnerDrainTask("task_schedule", taskScheduleWorker),
    runnerDrainTask("workflow_event", workflowEventWorker),
    codexChatWorker
      ? {
          name: "codex_chat",
          activeCount: codexChatWorker.activeCount,
          stop: ({ signal: abortSignal }: Parameters<RunnerDrainTask["stop"]>[0]) =>
            codexChatWorker.stop({
              ...(abortSignal ? { signal: abortSignal } : {}),
              onHandoff: (activeCount) => {
                logger.info("Runner shutdown handing off opencompany Codex chat turns", {
                  event: "opencompany.runner_shutdown_handing_off_goat_codex_chat",
                  active_goat_codex_chat_count: activeCount,
                });
              },
            }),
        }
      : null,
    runnerDrainTask("brain_ingest", brainIngestWorker),
    runnerDrainTask("wiki_ingest", wikiIngestWorker),
    runnerDrainTask("brain_import", brainImportWorker),
    {
      name: "slack_bot_events",
      activeCount: activeSlackBotEventCount,
      stop: async () => drainSlackBotEvents(),
    },
    runnerDrainTask("linear_flush", linearFlushWorker),
    runnerDrainTask("hubspot_flush", hubspotFlushWorker),
    runnerDrainTask("attio_flush", attioFlushWorker),
    runnerDrainTask("gmail_poll", gmailPollWorker),
    runnerDrainTask("gmail_flush", gmailFlushWorker),
    runnerDrainTask("granola_poll", granolaPollWorker),
    runnerDrainTask("fathom_poll", fathomPollWorker),
    runnerDrainTask("google_drive_sync", googleDriveSyncWorker),
    runnerDrainTask("chat_attachment_cleanup", chatAttachmentCleanupWorker),
    runnerDrainTask("stuck_work_monitor", stuckWorkMonitor),
    runnerDrainTask("codex_chat_self_heal", codexChatSelfHealSweeper),
    runnerDrainTask("sandbox_reconciler", sandboxReconciler),
    runnerDrainTask("brain_worker_admission", brainWorkerAdmissionListener),
    { name: "http_server", stop: async () => server.close() },
    chatPresentation
      ? { name: "chat_presentation", stop: async () => chatPresentation.close() }
      : null,
  ].filter((task): task is RunnerDrainTask => task !== null);

  try {
    const drain = await drainRunnerTasks({
      tasks,
      drainMs: RENDER_SHUTDOWN_DRAIN_MS,
      postAbortWaitMs: RENDER_SHUTDOWN_POST_DRAIN_WAIT_MS,
      onDeadline: ({ activeAtStart, interruptedAtDeadline }) => {
        const error = new Error("Runner shutdown drain deadline exceeded.");
        captureException(error, {
          event: "opencompany.runner_shutdown_drain_deadline_exceeded",
          active_at_start: activeAtStart,
          interrupted_at_deadline: interruptedAtDeadline,
        });
        logger.error("Runner shutdown drain deadline exceeded; aborting active work", {
          event: "opencompany.runner_shutdown_drain_deadline_exceeded",
          active_at_start: activeAtStart,
          interrupted_at_deadline: interruptedAtDeadline,
        });
      },
    });
    if (drain.activeAtStart > 0) {
      recordCounter(METRICS.runnerShutdownActiveWorkTotal, drain.activeAtStart);
    }
    if (drain.interruptedAtDeadline > 0) {
      recordCounter(METRICS.runnerShutdownInterruptedWorkTotal, drain.interruptedAtDeadline);
    }
    if (drain.unfinishedTasks.length > 0) {
      logger.error("Runner shutdown continuing with unfinished drain tasks", {
        event: "opencompany.runner_shutdown_drain_unfinished",
        unfinished_tasks: drain.unfinishedTasks,
      });
    }

    const dbClosed = await settlesWithin(
      Promise.allSettled([closeDb()]),
      RENDER_SHUTDOWN_DB_CLOSE_MS,
    );
    if (!dbClosed) {
      logger.error("Runner DB close exceeded its shutdown budget", {
        event: "opencompany.runner_shutdown_db_close_timeout",
      });
    }
    logger.info("Runner shutdown finished", {
      event: "opencompany.runner_shutdown_finished",
      signal,
      drain_deadline_exceeded: drain.deadlineExceeded,
    });
    await settlesWithin(
      Promise.allSettled([
        flushObservability(),
        flushBraintrust(),
        flushLatitude(),
        shutdownNodeObservability(),
      ]),
      RENDER_SHUTDOWN_TELEMETRY_FLUSH_MS,
    );
  } catch (error) {
    reportProcessError("opencompany.runner_shutdown_failed", error);
  } finally {
    process.exit(0);
  }
}

function runnerDrainTask(
  name: string,
  worker: { stop: RunnerDrainTask["stop"]; activeCount?: () => number } | null,
): RunnerDrainTask | null {
  if (!worker) return null;
  return {
    name,
    stop: (options) => worker.stop(options),
    ...(worker.activeCount ? { activeCount: worker.activeCount } : {}),
  };
}

function createChatPresentationStream() {
  const url = process.env.REDIS_URL?.trim();
  if (!url) return null;
  return new RedisChatPresentationStream({
    url,
    onError: ({ operation, error }) => {
      logger.warn("Runner transient Chat presentation degraded to Postgres", {
        event: "opencompany.runner_chat_presentation_redis_degraded",
        operation,
        error_name: error instanceof Error ? error.name : typeof error,
      });
    },
  });
}

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
