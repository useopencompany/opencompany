import { randomUUID } from "node:crypto";
import type { ChatPresentationPublisher } from "@opencompany/chat-presentation";
import { PostgresRunExecutionRepository } from "@opencompany/db/chat-repository";
import {
  type CodexChatSession,
  type CodexChatTurn,
  type CodexChatTurnSettings,
  codexChatSessions,
  tasks,
} from "@opencompany/db/product-schema";
import { captureException, createLogger } from "@opencompany/observability";
import { METRICS, recordHistogram } from "@opencompany/telemetry";
import { and, eq, sql } from "drizzle-orm";
import { runClaudeCodeChatTurn } from "./claude-code-chat";
import { runCodexChatTurn } from "./codex-chat";
import {
  CodexChatHandoffError,
  CodexChatLeaseLostError,
  CodexChatRetryableInfrastructureError,
} from "./codex-chat-errors";
import { createCodexChatProjector, loadCodexChatAssistantMessageParts } from "./codex-chat-events";
import { settledCodingSandboxIdleTimeoutMs } from "./coding-sandbox-lifecycle";
import { getDb } from "./db";
import type { RunnerEnv } from "./env";
import { runProductChatTurn } from "./opencompany-chat";
import { recoveryReasonForDeployVersions, runnerDeployVersion } from "./runner-deploy-version";
import { armSandboxActiveTimeoutById, armSandboxIdleTimeoutById } from "./sandbox";
import { rowsFromExecute } from "./sql-exec";
import { buildTaskTerminalProjection, type TaskTurnContext } from "./task-turn";

const logger = createLogger({
  service: "opencompany-runner",
  runtime: "goat-codex-chat-worker",
});
const CODEX_CHAT_SANDBOX_SWEEP_INTERVAL_MS = 60_000;
const CODEX_CHAT_RETRY_BASE_DELAY_MS = 5_000;
const CODEX_CHAT_RETRY_MAX_DELAY_MS = 60_000;
export const CODEX_CHAT_MAX_INFRASTRUCTURE_ATTEMPTS = 5;
const CODEX_CHAT_UNEXPECTED_FAILURE_MESSAGE =
  "This chat run failed before the coding engine could finish. Send your message again to retry.";
const CODEX_CHAT_INFRASTRUCTURE_RETRY_EXHAUSTED_MESSAGE =
  "This chat run could not start after several infrastructure retries. Send your message again to retry.";

let registeredWakeup: (() => void) | null = null;

export function setCodexChatWakeup(wake: (() => void) | null) {
  registeredWakeup = wake;
}

export function wakeCodexChatWorker() {
  registeredWakeup?.();
}

type ClaimedTurnRow = {
  id: string;
  user_workos_id: string;
  codex_chat_session_id: string;
  chat_session_id: string;
  user_message_id: string;
  assistant_message_id: string;
  codex_turn_id: string | null;
  status: CodexChatTurn["status"];
  prompt: string;
  settings: CodexChatTurnSettings;
  error: string | null;
  interrupt_requested_at: Date | string | null;
  attempts: number;
  recovery_attempts: number;
  engine_recovery_required: boolean;
  engine_turn_baseline_ids: string[] | null;
  event_sequence: number;
  lease_id: string | null;
  lease_owner: string | null;
  lease_expires_at: Date | string | null;
  run_after: Date | string | null;
  completed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

// Claims the next runnable codex chat turn. Three predicates shape the queue:
//  - claimable: freshly queued, or a running turn whose lease expired (worker crash);
//  - one active turn per session: skip while a sibling holds a live running lease;
//  - per-session FIFO: an earlier queued sibling always goes first.
export async function claimNextCodexChatTurn(input: {
  leaseOwner: string;
  leaseTtlMs: number;
}): Promise<CodexChatTurn | null> {
  const now = new Date();
  const leaseId = `goat_codex_chat_lease_${randomUUID()}`;
  const leaseExpiresAt = new Date(now.getTime() + input.leaseTtlMs);
  const result = await getDb().execute(sql`
    WITH candidate AS (
      SELECT turn.id
      FROM goat.codex_chat_turns AS turn
      WHERE (
          turn.status = 'queued'
          OR (turn.status = 'running' AND turn.lease_expires_at < ${now})
        )
        AND (turn.run_after IS NULL OR turn.run_after <= ${now})
        AND EXISTS (
          SELECT 1
          FROM goat.codex_chat_sessions AS session
          INNER JOIN goat.chat_sessions AS chat
            ON chat.id = session.chat_session_id
           AND chat.user_workos_id = session.user_workos_id
          WHERE session.id = turn.codex_chat_session_id
            AND session.user_workos_id = turn.user_workos_id
            AND session.status <> 'closed'
            AND chat.closed_at IS NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM goat.codex_chat_turns AS sibling
          WHERE sibling.codex_chat_session_id = turn.codex_chat_session_id
            AND sibling.id <> turn.id
            AND sibling.status = 'running'
            AND sibling.lease_expires_at >= ${now}
        )
        AND NOT EXISTS (
          SELECT 1 FROM goat.codex_chat_turns AS earlier
          WHERE earlier.codex_chat_session_id = turn.codex_chat_session_id
            AND earlier.id <> turn.id
            AND earlier.status = 'queued'
            AND (earlier.run_after IS NULL OR earlier.run_after <= ${now})
            AND (
              earlier.created_at < turn.created_at
              OR (earlier.created_at = turn.created_at AND earlier.id < turn.id)
            )
        )
      ORDER BY turn.created_at ASC, turn.id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    ), claimed AS (
      UPDATE goat.codex_chat_turns AS turn
      SET status = 'running',
          attempts = turn.attempts + 1,
          lease_id = ${leaseId},
          lease_owner = ${input.leaseOwner},
          lease_expires_at = ${leaseExpiresAt},
          updated_at = ${now}
      FROM candidate
      WHERE turn.id = candidate.id
      RETURNING turn.*
    ), started_session AS (
      UPDATE goat.codex_chat_sessions AS session
      SET status = 'starting',
          active_turn_id = claimed.id,
          error = NULL,
          sandbox_timeout_armed_at = NULL,
          updated_at = ${now}
      FROM claimed
      WHERE session.id = claimed.codex_chat_session_id
        AND session.user_workos_id = claimed.user_workos_id
      RETURNING session.id
    )
    SELECT claimed.*
    FROM claimed
    INNER JOIN started_session
      ON started_session.id = claimed.codex_chat_session_id
  `);
  const row = rowsFromExecute<ClaimedTurnRow>(result)[0];
  return row ? turnFromRow(row) : null;
}

export async function heartbeatCodexChatTurn(input: {
  turnId: string;
  leaseId: string;
  leaseOwner: string;
  leaseTtlMs: number;
}) {
  const now = new Date();
  const renewedLeaseExpiresAt = new Date(now.getTime() + input.leaseTtlMs);
  const interruptedLeaseExpiresAt = new Date(now.getTime() - 1);
  const result = await getDb().execute(sql`
    WITH heartbeat AS (
      UPDATE goat.codex_chat_turns
      SET lease_id = CASE WHEN interrupt_requested_at IS NULL THEN lease_id ELSE NULL END,
          lease_owner = CASE WHEN interrupt_requested_at IS NULL THEN lease_owner ELSE NULL END,
          lease_expires_at = CASE
            WHEN interrupt_requested_at IS NULL THEN ${renewedLeaseExpiresAt}
            WHEN lease_expires_at IS NULL OR lease_expires_at > ${interruptedLeaseExpiresAt}
              THEN ${interruptedLeaseExpiresAt}
            ELSE lease_expires_at
          END,
          updated_at = ${now}
      WHERE id = ${input.turnId}
        AND lease_id = ${input.leaseId}
        AND lease_owner = ${input.leaseOwner}
        AND status = 'running'
      RETURNING id, interrupt_requested_at
    )
    SELECT id
    FROM heartbeat
    WHERE interrupt_requested_at IS NULL
  `);
  return rowsFromExecute<{ id: string }>(result).length > 0;
}

export async function runClaimedTurn(
  turn: CodexChatTurn,
  env: RunnerEnv,
  options: {
    handoffSignal?: AbortSignal;
    presentationPublisher?: ChatPresentationPublisher;
  } = {},
) {
  const leaseId = turn.leaseId;
  const leaseOwner = turn.leaseOwner;
  if (!leaseId || !leaseOwner) throw new Error(`Claimed turn ${turn.id} is missing its lease.`);

  const [claimedSession] = await getDb()
    .select({
      session: codexChatSessions,
      task: tasks,
    })
    .from(codexChatSessions)
    .leftJoin(
      tasks,
      and(
        eq(tasks.sessionId, codexChatSessions.chatSessionId),
        eq(tasks.userWorkosId, turn.userWorkosId),
      ),
    )
    .where(
      and(
        eq(codexChatSessions.id, turn.codexChatSessionId),
        eq(codexChatSessions.userWorkosId, turn.userWorkosId),
      ),
    )
    .limit(1);
  if (!claimedSession) {
    throw new Error(`Codex chat session ${turn.codexChatSessionId} not found.`);
  }
  const { session, task } = claimedSession;
  const taskContext = task ? { task, harnessSpec: task.harnessSpec } : null;
  const execution = new PostgresRunExecutionRepository((query) => getDb().execute(query));
  const deployVersion = runnerDeployVersion();
  const requestedAttemptId = `run_attempt_${randomUUID()}`;
  const attempt = await execution.startAttempt({
    worker: { workerId: leaseOwner, deployVersion },
    runId: turn.id,
    attemptId: requestedAttemptId,
    leaseId,
  });
  if (!attempt) throw new CodexChatLeaseLostError();
  const canonicalAttemptId = attempt.id;
  const startedEvents = await execution.appendEvents({
    worker: { workerId: leaseOwner },
    runId: turn.id,
    attemptId: canonicalAttemptId,
    leaseId,
    events: [
      {
        id: `run_event_${randomUUID()}`,
        type: "run.started",
        payload: { attemptNumber: attempt.number },
      },
    ],
  });
  if (startedEvents.length !== 1) throw new CodexChatLeaseLostError();

  if (turn.attempts === 1) {
    const queueStartedAt =
      turn.runAfter && turn.runAfter > turn.createdAt ? turn.runAfter : turn.createdAt;
    recordHistogram(
      METRICS.codexChatQueueWaitMs,
      Math.max(0, Date.now() - queueStartedAt.getTime()),
      {
        "goat.engine": session.engine,
        "goat.model": session.model,
        "goat.status": turn.status,
        "goat.attempt": turn.attempts,
      },
    );
  }

  const recoveryRequired =
    session.engine !== "opencompany" &&
    turn.attempts > 1 &&
    (turn.engineRecoveryRequired || turn.codexTurnId !== null);
  const recoveryReason = recoveryReasonForDeployVersions({
    current: deployVersion,
    previous: attempt.previousDeployVersion ?? null,
  });
  if (recoveryRequired) {
    logger.info("Reattaching reclaimed opencompany Codex chat turn", {
      event: "opencompany.goat_codex_chat_turn_reattach_started",
      turn_id: turn.id,
      codex_chat_session_id: session.id,
      has_sandbox: Boolean(session.sandboxId),
      has_codex_thread: Boolean(session.codexThreadId),
      has_codex_turn: Boolean(turn.codexTurnId),
      lease_claim: turn.attempts,
      recovery_attempts: turn.recoveryAttempts,
      recovery_reason: recoveryReason,
      deploy_version: deployVersion,
      previous_deploy_version: attempt.previousDeployVersion ?? null,
    });
  }
  if (turn.attempts > 1) {
    logger.warn("Reclaimed durable opencompany chat turn", {
      event: "opencompany.goat_codex_chat_turn_reclaimed",
      turn_id: turn.id,
      codex_chat_session_id: session.id,
      chat_session_id: session.chatSessionId,
      engine: session.engine,
      attempt: turn.attempts,
      interrupt_requested: Boolean(turn.interruptRequestedAt),
      lease_expires_at: turn.leaseExpiresAt?.toISOString(),
      recovery_reason: recoveryReason,
      deploy_version: deployVersion,
      previous_deploy_version: attempt.previousDeployVersion ?? null,
    });
  }

  let heartbeatAbort: CodexChatLeaseLostError | null = null;
  let rejectHeartbeatAbort: ((error: CodexChatLeaseLostError) => void) | null = null;
  const heartbeatAbortPromise = new Promise<never>((_, reject) => {
    rejectHeartbeatAbort = reject;
  });
  const markHeartbeatLost = (error: unknown) => {
    if (heartbeatAbort) return;
    heartbeatAbort = new CodexChatLeaseLostError();
    rejectHeartbeatAbort?.(heartbeatAbort);
    captureException(error, {
      event: "opencompany.goat_codex_chat_heartbeat_failed",
      turn_id: turn.id,
    });
    logger.warn("opencompany codex chat heartbeat failed", {
      event: "opencompany.goat_codex_chat_heartbeat_failed",
      turn_id: turn.id,
      error,
    });
  };
  const heartbeat = setInterval(
    () => {
      void heartbeatCodexChatTurn({
        turnId: turn.id,
        leaseId,
        leaseOwner,
        leaseTtlMs: codexChatLeaseTtlMs(env),
      })
        .then((owned) => {
          if (!owned) markHeartbeatLost(new CodexChatLeaseLostError());
        })
        .catch(markHeartbeatLost);
    },
    Math.max(5_000, Math.floor(codexChatLeaseTtlMs(env) / 3)),
  );
  let handedOff = false;
  let retryableError: CodexChatRetryableInfrastructureError | null = null;
  let runPromise: Promise<
    "settled" | "handed_off" | { retryableError: CodexChatRetryableInfrastructureError } | void
  > | null = null;
  try {
    runPromise = (async () => {
      const turnInput = {
        turn,
        session,
        env,
        canonicalAttemptId,
        ...(options.presentationPublisher
          ? { presentationPublisher: options.presentationPublisher }
          : {}),
        ...(taskContext ? { taskContext } : {}),
        ...(recoveryRequired ? { recovery: { reason: recoveryReason } } : {}),
        shouldAbort: () =>
          options.handoffSignal?.aborted ? new CodexChatHandoffError() : heartbeatAbort,
      };
      const outcome =
        session.engine === "opencompany"
          ? await runProductChatTurn(turnInput)
          : session.engine === "claude_code"
            ? await runClaudeCodeChatTurn(turnInput)
            : await runCodexChatTurn(turnInput);
      return outcome;
    })().catch((error) => {
      if (error instanceof CodexChatHandoffError) {
        return "handed_off" as const;
      } else if (error instanceof CodexChatRetryableInfrastructureError) {
        return { retryableError: error };
      } else {
        throw error;
      }
    });
    const outcome = await Promise.race([runPromise, heartbeatAbortPromise]);
    if (outcome && typeof outcome === "object") {
      retryableError = outcome.retryableError;
    } else {
      handedOff = outcome === "handed_off";
    }
  } catch (error) {
    if (error instanceof CodexChatLeaseLostError) throw error;
    captureException(error, {
      event: "opencompany.goat_codex_chat_turn_terminal_failure",
      turn_id: turn.id,
      codex_chat_session_id: session.id,
    });
    logger.error("Terminal opencompany chat turn failure", {
      event: "opencompany.goat_codex_chat_turn_terminal_failure",
      turn_id: turn.id,
      codex_chat_session_id: session.id,
      engine: session.engine,
      attempt: turn.attempts,
      error,
    });
    await failClaimedTurn({
      turn,
      session,
      canonicalAttemptId,
      taskContext,
      message: CODEX_CHAT_UNEXPECTED_FAILURE_MESSAGE,
    });
    return;
  } finally {
    clearInterval(heartbeat);
    if (heartbeatAbort) void runPromise?.catch(() => undefined);
  }
  if (retryableError) {
    if (turn.attempts >= CODEX_CHAT_MAX_INFRASTRUCTURE_ATTEMPTS) {
      logger.error("opencompany chat infrastructure retry budget exhausted", {
        event: "opencompany.goat_codex_chat_turn_retry_exhausted",
        turn_id: turn.id,
        codex_chat_session_id: session.id,
        engine: session.engine,
        attempt: turn.attempts,
        error: retryableError.cause ?? retryableError,
      });
      await failClaimedTurn({
        turn,
        session,
        canonicalAttemptId,
        taskContext,
        message: CODEX_CHAT_INFRASTRUCTURE_RETRY_EXHAUSTED_MESSAGE,
      });
      return;
    }
    const failedAttempt = await execution.finishAttempt({
      worker: { workerId: leaseOwner },
      runId: turn.id,
      attemptId: canonicalAttemptId,
      leaseId,
      status: "failed",
      errorCode: "retryable_infrastructure",
      errorMessage: retryableError.message,
    });
    if (!failedAttempt) throw new CodexChatLeaseLostError();
    const retryAt = codexChatRetryAt(new Date(), turn.attempts);
    await deferCodexChatTurnForRetry({
      turnId: turn.id,
      codexChatSessionId: turn.codexChatSessionId,
      userWorkosId: turn.userWorkosId,
      leaseId,
      leaseOwner,
      retryAt,
    });
    logger.warn("Deferred opencompany Codex chat turn after transient infrastructure failure", {
      event: "opencompany.goat_codex_chat_turn_retry_deferred",
      turn_id: turn.id,
      codex_chat_session_id: session.id,
      attempt: turn.attempts,
      retry_at: retryAt.toISOString(),
      error_name:
        retryableError.cause instanceof Error
          ? retryableError.cause.name
          : typeof retryableError.cause,
      error:
        retryableError.cause instanceof Error
          ? retryableError.cause.message
          : retryableError.message,
    });
    return;
  }
  if (handedOff) {
    const abandonedAttempt = await execution.finishAttempt({
      worker: { workerId: leaseOwner },
      runId: turn.id,
      attemptId: canonicalAttemptId,
      leaseId,
      status: "abandoned",
      errorCode: "worker_handoff",
      errorMessage: "The worker handed this Run off during shutdown.",
    });
    if (!abandonedAttempt) throw new CodexChatLeaseLostError();
    await releaseCodexChatTurnForHandoff({ turnId: turn.id, leaseId, leaseOwner });
  }
}

async function failClaimedTurn(input: {
  turn: CodexChatTurn;
  session: CodexChatSession;
  canonicalAttemptId: string;
  taskContext: TaskTurnContext | null;
  message: string;
}) {
  const { turn, session } = input;
  const leaseId = turn.leaseId;
  const leaseOwner = turn.leaseOwner;
  if (!leaseId || !leaseOwner) throw new CodexChatLeaseLostError();
  const initialParts = await loadCodexChatAssistantMessageParts(turn.assistantMessageId);
  const projector = createCodexChatProjector({
    target: {
      userWorkosId: turn.userWorkosId,
      workspaceId: session.workspaceId,
      codexChatSessionId: session.id,
      chatSessionId: session.chatSessionId,
      turnId: turn.id,
      userMessageId: turn.userMessageId,
      assistantMessageId: turn.assistantMessageId,
      model: session.model,
      engine: session.engine,
      leaseId,
      leaseOwner,
      canonicalAttemptId: input.canonicalAttemptId,
      planMode: turn.settings.planModeReasoningEffort != null,
      turnCreatedAt:
        turn.runAfter && turn.runAfter > turn.createdAt ? turn.runAfter : turn.createdAt,
    },
    redact: (value) => value,
    initialParts,
  });
  await projector.fail(input.message, {
    sessionStatus: "failed",
    ...(input.taskContext
      ? { taskCompletion: buildTaskTerminalProjection(input.taskContext) }
      : {}),
  });
}

export async function deferCodexChatTurnForRetry(input: {
  turnId: string;
  codexChatSessionId: string;
  userWorkosId: string;
  leaseId: string;
  leaseOwner: string;
  retryAt: Date;
}) {
  const now = new Date();
  const result = await getDb().execute(sql`
    WITH deferred AS (
      UPDATE goat.codex_chat_turns AS turn
      SET lease_id = NULL,
          lease_owner = NULL,
          lease_expires_at = ${input.retryAt},
          error = NULL,
          updated_at = ${now}
      WHERE turn.id = ${input.turnId}
        AND turn.codex_chat_session_id = ${input.codexChatSessionId}
        AND turn.user_workos_id = ${input.userWorkosId}
        AND turn.lease_id = ${input.leaseId}
        AND turn.lease_owner = ${input.leaseOwner}
        AND turn.status = 'running'
      RETURNING turn.id
    )
    UPDATE goat.codex_chat_sessions AS session
    SET status = 'queued',
        active_turn_id = ${input.turnId},
        error = NULL,
        updated_at = ${now}
    WHERE session.id = ${input.codexChatSessionId}
      AND session.user_workos_id = ${input.userWorkosId}
      AND EXISTS (SELECT 1 FROM deferred)
    RETURNING session.id
  `);
  if (rowsFromExecute(result).length === 0) {
    throw new CodexChatLeaseLostError();
  }
}

export function codexChatRetryAt(now: Date, attempts: number) {
  const delayMs = Math.min(
    CODEX_CHAT_RETRY_MAX_DELAY_MS,
    CODEX_CHAT_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1),
  );
  return new Date(now.getTime() + delayMs);
}

export async function releaseCodexChatTurnForHandoff(input: {
  turnId: string;
  leaseId: string;
  leaseOwner: string;
}) {
  const released = await expireCodexChatTurnLeaseForHandoff(input);
  if (!released) {
    throw new CodexChatLeaseLostError();
  }
}

async function expireCodexChatTurnLeaseForHandoff(input: {
  turnId: string;
  leaseId: string;
  leaseOwner: string;
}) {
  const now = new Date();
  const result = await getDb().execute(sql`
    UPDATE goat.codex_chat_turns
    SET lease_id = NULL,
        lease_owner = NULL,
        lease_expires_at = ${new Date(now.getTime() - 1)},
        updated_at = ${now}
    WHERE id = ${input.turnId}
      AND lease_id = ${input.leaseId}
      AND lease_owner = ${input.leaseOwner}
      AND status = 'running'
    RETURNING id
  `);
  return rowsFromExecute<{ id: string }>(result).length > 0;
}

export async function sweepTerminalCodexChatSandboxes(input: {
  idleTimeoutMs: number;
  limit?: number;
}) {
  const result = await getDb().execute(sql`
    SELECT runtime.id, runtime.sandbox_id, runtime.updated_at, chat.kind AS chat_kind
    FROM goat.codex_chat_sessions AS runtime
    INNER JOIN goat.chat_sessions AS chat
      ON chat.id = runtime.chat_session_id
     AND chat.user_workos_id = runtime.user_workos_id
    WHERE runtime.sandbox_id IS NOT NULL
      AND runtime.status IN ('idle', 'failed', 'interrupted', 'closed')
      AND (
        runtime.sandbox_timeout_armed_at IS NULL
        OR runtime.sandbox_timeout_armed_at < runtime.updated_at
      )
    ORDER BY runtime.updated_at ASC, runtime.id ASC
    LIMIT ${Math.max(1, input.limit ?? 25)}
  `);
  let reconciled = 0;
  for (const row of rowsFromExecute<{
    id: string;
    sandbox_id: string;
    updated_at: Date | string;
    chat_kind: string;
  }>(result)) {
    try {
      const armed = await armSandboxIdleTimeoutById(
        row.sandbox_id,
        settledCodingSandboxIdleTimeoutMs({
          configuredIdleTimeoutMs: input.idleTimeoutMs,
          taskSession: row.chat_kind === "task",
        }),
      );
      const now = new Date();
      const marked = await getDb().execute(sql`
        UPDATE goat.codex_chat_sessions
        SET sandbox_id = CASE WHEN ${armed} THEN sandbox_id ELSE NULL END,
            sandbox_timeout_armed_at = ${now}
        WHERE id = ${row.id}
          AND sandbox_id = ${row.sandbox_id}
          AND status IN ('idle', 'failed', 'interrupted', 'closed')
          AND updated_at = ${row.updated_at}
        RETURNING id
      `);
      if (rowsFromExecute(marked).length === 0 && armed) {
        const current = await getDb().execute(sql`
          SELECT status
          FROM goat.codex_chat_sessions
          WHERE id = ${row.id}
            AND sandbox_id = ${row.sandbox_id}
          LIMIT 1
        `);
        const status = rowsFromExecute<{ status: string }>(current)[0]?.status;
        if (status === "queued" || status === "starting" || status === "running") {
          await armSandboxActiveTimeoutById(row.sandbox_id);
        }
      }
      reconciled += 1;
    } catch (error) {
      captureException(error, {
        event: "opencompany.goat_codex_chat_sandbox_sweep_item_failed",
        codex_chat_session_id: row.id,
      });
      logger.warn("Failed to reconcile terminal opencompany Codex chat sandbox", {
        event: "opencompany.goat_codex_chat_sandbox_sweep_item_failed",
        codex_chat_session_id: row.id,
        error,
      });
    }
  }
  return reconciled;
}

export function startCodexChatWorker(
  env: RunnerEnv,
  options: {
    concurrency?: number;
    pollIntervalMs?: number;
    sandboxSweep?: () => Promise<number>;
    sandboxSweepIntervalMs?: number;
    presentationPublisher?: ChatPresentationPublisher;
  } = {},
) {
  const concurrency = resolveCodexChatWorkerConcurrency(env, options.concurrency);
  const pollIntervalMs = Math.max(50, options.pollIntervalMs ?? 1_000);
  const active = new Map<
    Promise<void>,
    {
      controller: AbortController;
      turnId: string;
      leaseId: string | null;
      leaseOwner: string | null;
    }
  >();
  const sandboxSweepIntervalMs = Math.max(
    1_000,
    options.sandboxSweepIntervalMs ?? CODEX_CHAT_SANDBOX_SWEEP_INTERVAL_MS,
  );
  let stopped = false;
  let lastSandboxSweepAt = 0;
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
        const nowMs = Date.now();
        if (options.sandboxSweep && nowMs - lastSandboxSweepAt >= sandboxSweepIntervalMs) {
          lastSandboxSweepAt = nowMs;
          void options.sandboxSweep().catch((error) => {
            captureException(error, {
              event: "opencompany.goat_codex_chat_sandbox_sweep_failed",
            });
            logger.warn("opencompany Codex chat sandbox sweep failed", {
              event: "opencompany.goat_codex_chat_sandbox_sweep_failed",
              error,
            });
          });
        }
        while (!stopped && active.size < concurrency) {
          const turn = await claimNextCodexChatTurn({
            leaseOwner: env.instanceId,
            leaseTtlMs: codexChatLeaseTtlMs(env),
          });
          if (!turn) break;
          const handoffController = new AbortController();
          const running = runClaimedTurn(turn, env, {
            handoffSignal: handoffController.signal,
            ...(options.presentationPublisher
              ? { presentationPublisher: options.presentationPublisher }
              : {}),
          })
            .catch((error) => {
              if (error instanceof CodexChatLeaseLostError) return;
              captureException(error, {
                event: "opencompany.goat_codex_chat_turn_failed",
                turn_id: turn.id,
              });
              logger.error("opencompany codex chat turn failed", {
                event: "opencompany.goat_codex_chat_turn_failed",
                turn_id: turn.id,
                error,
              });
            })
            .finally(() => active.delete(running));
          active.set(running, {
            controller: handoffController,
            turnId: turn.id,
            leaseId: turn.leaseId,
            leaseOwner: turn.leaseOwner,
          });
        }
      } catch (error) {
        captureException(error, { event: "opencompany.goat_codex_chat_worker_failed" });
        logger.error("opencompany codex chat worker failed", {
          event: "opencompany.goat_codex_chat_worker_failed",
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
    stop: async (options?: {
      signal?: AbortSignal;
      handoffAfterMs?: number;
      onHandoff?: (activeCount: number) => Promise<void> | void;
      postHandoffWaitMs?: number;
    }) => {
      stopped = true;
      notify();
      await loop;
      if (active.size === 0) return;
      if (!options?.signal && options?.handoffAfterMs === undefined) {
        await Promise.allSettled(Array.from(active.keys()));
        return;
      }
      const activeDrain = Promise.allSettled(Array.from(active.keys())).then(() => true);
      const drained = options.signal
        ? await Promise.race([
            activeDrain,
            options.signal.aborted
              ? Promise.resolve(false)
              : new Promise<false>((resolve) => {
                  options.signal?.addEventListener("abort", () => resolve(false), { once: true });
                }),
          ])
        : await Promise.race([activeDrain, sleep(options.handoffAfterMs ?? 0).then(() => false)]);
      if (drained) return;

      await options.onHandoff?.(active.size);
      for (const run of active.values()) run.controller.abort();
      const postHandoffWaitMs = options.postHandoffWaitMs ?? (options.signal ? 25_000 : undefined);
      if (postHandoffWaitMs !== undefined) {
        await Promise.race([
          Promise.allSettled(Array.from(active.keys())),
          sleep(postHandoffWaitMs),
        ]);
      }
      // Setup work may be blocked before it reaches the abort check. Fence any such process after
      // the grace period so another runner can reclaim the durable turn instead of waiting a full
      // lease TTL. The lease id/owner predicates keep this safe if ownership already changed.
      const pendingHandoffs = Array.from(active.values());
      const forcedHandoffs = await Promise.allSettled(
        pendingHandoffs.map((run) =>
          run.leaseId && run.leaseOwner
            ? expireCodexChatTurnLeaseForHandoff({
                turnId: run.turnId,
                leaseId: run.leaseId,
                leaseOwner: run.leaseOwner,
              })
            : Promise.resolve(false),
        ),
      );
      forcedHandoffs.forEach((result, index) => {
        if (result.status !== "rejected") return;
        captureException(result.reason, {
          event: "opencompany.goat_codex_chat_shutdown_forced_handoff_failed",
          turn_id: pendingHandoffs[index]?.turnId,
        });
      });
      const releasedCount = forcedHandoffs.filter(
        (result) => result.status === "fulfilled" && result.value,
      ).length;
      const failedCount = forcedHandoffs.filter((result) => result.status === "rejected").length;
      if (releasedCount > 0 || failedCount > 0) {
        logger.warn("Runner shutdown forced opencompany Codex chat lease handoff", {
          event: "opencompany.goat_codex_chat_shutdown_forced_handoff",
          released_count: releasedCount,
          failed_count: failedCount,
        });
      }
    },
  };
}

export function resolveCodexChatWorkerConcurrency(
  env: Pick<RunnerEnv, "workerConcurrency">,
  override?: number,
) {
  return Math.max(1, override ?? env.workerConcurrency);
}

export function codexChatLeaseTtlMs(env: Pick<RunnerEnv, "jobLeaseTtlMs" | "codexChatLeaseTtlMs">) {
  return env.codexChatLeaseTtlMs ?? env.jobLeaseTtlMs;
}

function turnFromRow(row: ClaimedTurnRow): CodexChatTurn {
  return {
    id: row.id,
    userWorkosId: row.user_workos_id,
    codexChatSessionId: row.codex_chat_session_id,
    chatSessionId: row.chat_session_id,
    userMessageId: row.user_message_id,
    assistantMessageId: row.assistant_message_id,
    codexTurnId: row.codex_turn_id,
    status: row.status,
    prompt: row.prompt,
    settings: row.settings ?? {},
    error: row.error,
    interruptRequestedAt: dateFromRow(row.interrupt_requested_at),
    attempts: row.attempts,
    recoveryAttempts: row.recovery_attempts,
    engineRecoveryRequired: row.engine_recovery_required,
    engineTurnBaselineIds: row.engine_turn_baseline_ids,
    eventSequence: row.event_sequence,
    leaseId: row.lease_id,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: dateFromRow(row.lease_expires_at),
    runAfter: dateFromRow(row.run_after),
    completedAt: dateFromRow(row.completed_at),
    createdAt: dateFromRow(row.created_at) ?? new Date(),
    updatedAt: dateFromRow(row.updated_at) ?? new Date(),
  };
}

function dateFromRow(value: Date | string | null): Date | null {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value);
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
