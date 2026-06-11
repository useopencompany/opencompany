import { randomUUID } from "node:crypto";
import { captureException, createLogger } from "@opencompany/observability";
import { sql } from "drizzle-orm";
import {
  resumeApproval,
  resumeQuestionResponse,
  runAfterSession,
  runMessage,
  startSession,
} from "./agent-loop";
import { getDb } from "./db";
import type { RunnerEnv } from "./env";
import { RunLeaseBusyError } from "./run-control";
import { isNonRetryableRunnerError } from "./runner-errors";
import { generateSessionTitleForMessage } from "./session-title";
import { rowsFromExecute } from "./sql-exec";

// Runner has two lease layers that work together:
//   - This job lease (RUNNER_JOB_LEASE_TTL_MS) is the *delivery* lease. It guarantees one
//     runner instance owns the right to dispatch a job kind+session+message tuple.
//   - The session run lease in `run-control.ts` is the *execution* lease. It guarantees one
//     in-flight model/tool loop per session and is what session writes check via `lease-writes.ts`.
// Both heartbeat at RUN_HEARTBEAT_INTERVAL_MS / RUNNER_JOB_HEARTBEAT_INTERVAL_MS. TTLs must
// be > 2× the heartbeat interval to survive a hiccup but short enough that a crashed runner's
// jobs/sessions get reclaimed quickly.
const logger = createLogger({ service: "opencompany-runner", runtime: "jobs" });

// Default delivery-lease TTL. The lease heartbeats every 5s while a job runs, so it stays fresh
// during a long blocking tool call — this TTL only governs how long a stalled lease (deploy /
// recycle / GC / network gap) survives before another instance may re-claim. Sized to absorb a
// normal deploy so a long opencode run is not re-claimed mid-flight. Overridable via
// RUNNER_JOB_LEASE_TTL_MS (loadEnv); this constant is the fallback for direct callers (e.g. tests).
export const RUNNER_JOB_LEASE_TTL_MS = 5 * 60 * 1000;
export const RUNNER_JOB_HEARTBEAT_INTERVAL_MS = 5_000;
export const RUNNER_JOB_MAX_ATTEMPTS = 5;
// Fallback ceiling on lease-busy re-claims for direct callers; production reads
// env.jobMaxLeaseBusyAttempts. Must stay above RUNNER_JOB_MAX_ATTEMPTS so an ordinary busy run is
// still deferred, and only the pathological runaway (one job reached 17) is cut off.
export const RUNNER_JOB_MAX_LEASE_BUSY_ATTEMPTS = 10;
// Fallback only for callers that construct the worker without options (e.g. tests).
// Production sets concurrency via `RUNNER_WORKER_CONCURRENCY` (see env.ts), passed in
// from index.ts.
const DEFAULT_WORKER_CONCURRENCY = 2;
const DEFAULT_WORKER_POLL_INTERVAL_MS = 1_000;

export type RunnerJobKind =
  | "start"
  | "message"
  | "title"
  | "after_session"
  | "resume_approval"
  | "resume_question";
export type RunnerJobStatus = "pending" | "running" | "completed" | "failed";

export type RunnerJob = {
  id: number;
  idempotencyKey: string;
  sessionId: string;
  messageId: string | null;
  kind: RunnerJobKind;
  status: RunnerJobStatus;
  attempts: number;
  nextRunAt: Date;
  leaseId: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type EnqueueRunnerJobInput = {
  sessionId: string;
  messageId?: string | null;
  kind: RunnerJobKind;
};

export type RunnerJobStore = {
  enqueue(input: EnqueueRunnerJobInput & { idempotencyKey: string; now: Date }): Promise<RunnerJob>;
  claimNext(input: {
    leaseId: string;
    leaseOwner: string;
    now: Date;
    leaseExpiresAt: Date;
  }): Promise<RunnerJob | null>;
  heartbeat(input: {
    id: number;
    leaseId: string;
    leaseOwner: string;
    now: Date;
    leaseExpiresAt: Date;
  }): Promise<boolean>;
  complete(input: { id: number; leaseId: string; leaseOwner: string; now: Date }): Promise<boolean>;
  fail(input: {
    id: number;
    leaseId: string;
    leaseOwner: string;
    now: Date;
    status: "pending" | "failed";
    nextRunAt: Date;
    lastError: string;
  }): Promise<boolean>;
};

export function createDbRunnerJobStore(): RunnerJobStore {
  return {
    async enqueue(input) {
      const messageId = input.messageId ?? null;
      const result = await getDb().execute(sql`
        INSERT INTO agent_session_run_jobs (
          idempotency_key,
          session_id,
          message_id,
          kind,
          status,
          attempts,
          next_run_at,
          lease_id,
          lease_owner,
          lease_expires_at,
          last_error,
          updated_at
        )
        VALUES (
          ${input.idempotencyKey},
          ${input.sessionId},
          ${messageId},
          ${input.kind},
          'pending',
          0,
          ${input.now},
          NULL,
          NULL,
          NULL,
          NULL,
          ${input.now}
        )
        ON CONFLICT (idempotency_key) DO UPDATE
        SET status = 'pending',
            attempts = CASE
              WHEN agent_session_run_jobs.status = 'failed' THEN 0
              ELSE agent_session_run_jobs.attempts
            END,
            next_run_at = ${input.now},
            lease_id = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL,
            last_error = NULL,
            updated_at = ${input.now}
        WHERE agent_session_run_jobs.status IN ('pending', 'failed')
        RETURNING ${runnerJobColumnsSql}
      `);

      const changed = rowsFromExecute<RunnerJobRow>(result)[0];
      if (changed) return runnerJobFromRow(changed);

      const existing = await getDb().execute(sql`
        SELECT ${runnerJobColumnsSql}
        FROM agent_session_run_jobs
        WHERE idempotency_key = ${input.idempotencyKey}
        LIMIT 1
      `);
      const row = rowsFromExecute<RunnerJobRow>(existing)[0];
      if (!row) {
        throw new Error(`Runner job enqueue failed: ${input.idempotencyKey}`);
      }
      return runnerJobFromRow(row);
    },

    async claimNext(input) {
      const result = await getDb().execute(sql`
        WITH candidate AS (
          SELECT id
          FROM agent_session_run_jobs
          WHERE
            (status = 'pending' AND next_run_at <= ${input.now})
            OR (status = 'running' AND lease_expires_at < ${input.now})
          ORDER BY next_run_at ASC, id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE agent_session_run_jobs AS job
        SET status = 'running',
            attempts = job.attempts + 1,
            lease_id = ${input.leaseId},
            lease_owner = ${input.leaseOwner},
            lease_expires_at = ${input.leaseExpiresAt},
            updated_at = ${input.now}
        FROM candidate
        WHERE job.id = candidate.id
        RETURNING
          job.id,
          job.idempotency_key AS "idempotencyKey",
          job.session_id AS "sessionId",
          job.message_id AS "messageId",
          job.kind,
          job.status,
          job.attempts,
          job.next_run_at AS "nextRunAt",
          job.lease_id AS "leaseId",
          job.lease_owner AS "leaseOwner",
          job.lease_expires_at AS "leaseExpiresAt",
          job.last_error AS "lastError",
          job.created_at AS "createdAt",
          job.updated_at AS "updatedAt"
      `);

      const row = rowsFromExecute<RunnerJobRow>(result)[0];
      return row ? runnerJobFromRow(row) : null;
    },

    async heartbeat(input) {
      const result = await getDb().execute(sql`
        UPDATE agent_session_run_jobs
        SET lease_expires_at = ${input.leaseExpiresAt},
            updated_at = ${input.now}
        WHERE id = ${input.id}
          AND lease_id = ${input.leaseId}
          AND lease_owner = ${input.leaseOwner}
          AND status = 'running'
        RETURNING id
      `);
      return rowsFromExecute<{ id: number }>(result).length > 0;
    },

    async complete(input) {
      const result = await getDb().execute(sql`
        UPDATE agent_session_run_jobs
        SET status = 'completed',
            lease_id = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL,
            last_error = NULL,
            updated_at = ${input.now}
        WHERE id = ${input.id}
          AND lease_id = ${input.leaseId}
          AND lease_owner = ${input.leaseOwner}
          AND status = 'running'
        RETURNING id
      `);
      return rowsFromExecute<{ id: number }>(result).length > 0;
    },

    async fail(input) {
      const result = await getDb().execute(sql`
        UPDATE agent_session_run_jobs
        SET status = ${input.status},
            next_run_at = ${input.nextRunAt},
            lease_id = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL,
            last_error = ${input.lastError},
            updated_at = ${input.now}
        WHERE id = ${input.id}
          AND lease_id = ${input.leaseId}
          AND lease_owner = ${input.leaseOwner}
          AND status = 'running'
        RETURNING id
      `);
      return rowsFromExecute<{ id: number }>(result).length > 0;
    },
  };
}

export async function enqueueRunnerJob(
  input: EnqueueRunnerJobInput,
  store: RunnerJobStore = createDbRunnerJobStore(),
) {
  const idempotencyKey = runnerJobIdempotencyKey(input);
  return store.enqueue({ ...input, idempotencyKey, now: new Date() });
}

export async function claimNextRunnerJob(input: {
  leaseOwner: string;
  store?: RunnerJobStore;
  leaseTtlMs?: number;
}) {
  const now = new Date();
  const leaseId = newRunnerJobLeaseId();
  return (input.store ?? createDbRunnerJobStore()).claimNext({
    leaseId,
    leaseOwner: input.leaseOwner,
    now,
    leaseExpiresAt: runnerJobLeaseExpiresAt(now, input.leaseTtlMs),
  });
}

export async function runClaimedRunnerJob(input: {
  job: RunnerJob;
  env: RunnerEnv;
  store?: RunnerJobStore;
  handlers?: RunnerJobHandlers;
}) {
  const store = input.store ?? createDbRunnerJobStore();
  const handlers = input.handlers ?? defaultRunnerJobHandlers;
  const leaseId = requireJobLease(input.job, "leaseId");
  const leaseOwner = requireJobLease(input.job, "leaseOwner");
  // Aborts when the job lease is lost so inflight model/tool work stops promptly
  // instead of running until the next persisted-write checkpoint.
  const abortController = new AbortController();
  let leaseActive = true;

  const handleLeaseLost = () => {
    if (!leaseActive) return;
    leaseActive = false;
    abortController.abort();
    logger.warn("Runner job lease lost", {
      event: "opencompany.runner_job_lease_lost",
      runner_job_id: input.job.id,
      runner_job_kind: input.job.kind,
      session_id: input.job.sessionId,
      message_id: input.job.messageId,
    });
  };

  const heartbeat = async () => {
    const now = new Date();
    const active = await store.heartbeat({
      id: input.job.id,
      leaseId,
      leaseOwner,
      now,
      leaseExpiresAt: runnerJobLeaseExpiresAt(now, input.env.jobLeaseTtlMs),
    });
    if (!active) handleLeaseLost();
  };

  const heartbeatTimer = setInterval(() => {
    void heartbeat().catch((error) => {
      captureException(error, {
        event: "opencompany.runner_job_heartbeat_failed",
        runner_job_id: input.job.id,
        runner_job_kind: input.job.kind,
        session_id: input.job.sessionId,
        message_id: input.job.messageId ?? undefined,
      });
      logger.warn("Runner job heartbeat failed", {
        event: "opencompany.runner_job_heartbeat_failed",
        runner_job_id: input.job.id,
        runner_job_kind: input.job.kind,
        session_id: input.job.sessionId,
        message_id: input.job.messageId,
        error,
      });
      handleLeaseLost();
    });
  }, RUNNER_JOB_HEARTBEAT_INTERVAL_MS);

  try {
    await dispatchRunnerJob(input.job, input.env, handlers, abortController.signal);
    if (!leaseActive) return;
    await store.complete({ id: input.job.id, leaseId, leaseOwner, now: new Date() });
  } catch (error) {
    if (leaseActive) {
      await failRunnerJob({
        job: input.job,
        leaseId,
        leaseOwner,
        error,
        store,
        maxLeaseBusyAttempts: input.env.jobMaxLeaseBusyAttempts,
      });
    }
    throw error;
  } finally {
    clearInterval(heartbeatTimer);
  }
}

export function startRunnerJobWorker(
  env: RunnerEnv,
  options: {
    store?: RunnerJobStore;
    handlers?: RunnerJobHandlers;
    concurrency?: number;
    pollIntervalMs?: number;
    staleRunSweep?: () => Promise<number>;
    staleRunSweepIntervalMs?: number;
  } = {},
) {
  const store = options.store ?? createDbRunnerJobStore();
  const handlers = options.handlers ?? defaultRunnerJobHandlers;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_WORKER_CONCURRENCY);
  const pollIntervalMs = Math.max(50, options.pollIntervalMs ?? DEFAULT_WORKER_POLL_INTERVAL_MS);
  const staleRunSweep = options.staleRunSweep;
  const staleRunSweepIntervalMs = Math.max(
    RUNNER_JOB_HEARTBEAT_INTERVAL_MS,
    options.staleRunSweepIntervalMs ?? 60_000,
  );
  const active = new Set<Promise<void>>();
  let stopped = false;
  let lastStaleRunSweepAt = 0;

  // `notify()` lets the in-process server nudge the loop the moment a job is enqueued
  // instead of waiting out the poll interval, which is the dominant source of dead time
  // between accepting a message and claiming its run job. A wake that arrives while the
  // loop is busy (not currently waiting) is coalesced into `pendingWake` so it is never
  // lost. Polling still backstops retries, `nextRunAt`, and any future second instance.
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
        if (staleRunSweep && nowMs - lastStaleRunSweepAt >= staleRunSweepIntervalMs) {
          lastStaleRunSweepAt = nowMs;
          void staleRunSweep().catch((error) => {
            captureException(error, { event: "opencompany.runner_stale_sweep_failed" });
            logger.warn("Runner stale sweep failed", {
              event: "opencompany.runner_stale_sweep_failed",
              error,
            });
          });
        }

        while (!stopped && active.size < concurrency) {
          const job = await claimNextRunnerJob({
            leaseOwner: env.instanceId,
            store,
            leaseTtlMs: env.jobLeaseTtlMs,
          });
          if (!job) break;
          const running = runClaimedRunnerJob({ job, env, store, handlers })
            .catch((error) => {
              if (error instanceof RunLeaseBusyError) {
                logger.info("Runner job deferred because run lease is busy", {
                  event: "opencompany.runner_job_lease_busy",
                  runner_job_id: job.id,
                  runner_job_kind: job.kind,
                  session_id: job.sessionId,
                  message_id: job.messageId,
                });
                return;
              }
              captureException(error, {
                event: "opencompany.runner_job_failed",
                runner_job_id: job.id,
                runner_job_kind: job.kind,
                session_id: job.sessionId,
                message_id: job.messageId ?? undefined,
              });
              logger.error("Runner job failed", {
                event: "opencompany.runner_job_failed",
                runner_job_id: job.id,
                runner_job_kind: job.kind,
                session_id: job.sessionId,
                message_id: job.messageId,
                error,
              });
            })
            .finally(() => active.delete(running));
          active.add(running);
        }
      } catch (error) {
        captureException(error, { event: "opencompany.runner_job_worker_failed" });
        logger.error("Runner job worker failed", {
          event: "opencompany.runner_job_worker_failed",
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
      interruptAfterMs?: number;
      onInterrupt?: () => Promise<void> | void;
      postInterruptWaitMs?: number;
    }) => {
      stopped = true;
      // Break out of any in-progress wait so shutdown does not stall a poll interval.
      notify();
      await loop;
      if (active.size === 0) return;

      if (options?.interruptAfterMs === undefined) {
        await Promise.allSettled(Array.from(active));
        return;
      }

      const drained = await Promise.race([
        Promise.allSettled(Array.from(active)).then(() => true),
        sleep(options.interruptAfterMs).then(() => false),
      ]);

      if (!drained) {
        await options.onInterrupt?.();
        // The interrupt only *requests* aborts; the aborted jobs still need to unwind
        // (job fail writes, final stream events). Give them a bounded window so the
        // caller does not close the DB pool behind writes that are still in flight —
        // bounded, so one hung abort cannot eat the rest of the shutdown grace.
        if (options.postInterruptWaitMs !== undefined) {
          await Promise.race([
            Promise.allSettled(Array.from(active)),
            sleep(options.postInterruptWaitMs),
          ]);
        }
      }
    },
  };
}

export type RunnerJobHandlers = {
  startSession: typeof startSession;
  runMessage: typeof runMessage;
  generateSessionTitleForMessage: typeof generateSessionTitleForMessage;
  runAfterSession: typeof runAfterSession;
  resumeApproval: typeof resumeApproval;
  resumeQuestionResponse: typeof resumeQuestionResponse;
};

const defaultRunnerJobHandlers: RunnerJobHandlers = {
  startSession,
  runMessage,
  generateSessionTitleForMessage,
  runAfterSession,
  resumeApproval,
  resumeQuestionResponse,
};

async function dispatchRunnerJob(
  job: RunnerJob,
  env: RunnerEnv,
  handlers: RunnerJobHandlers,
  externalSignal: AbortSignal,
) {
  if (job.kind === "start") {
    await handlers.startSession(job.sessionId, env);
    return;
  }

  const messageId = requireJobMessageId(job);
  if (job.kind === "message") {
    await handlers.runMessage({ sessionId: job.sessionId, messageId, env, externalSignal });
    return;
  }
  if (job.kind === "title") {
    await handlers.generateSessionTitleForMessage({ sessionId: job.sessionId, messageId, env });
    return;
  }
  if (job.kind === "resume_approval") {
    // The toolCallId rides in the message_id column for this job kind.
    await handlers.resumeApproval({
      sessionId: job.sessionId,
      toolCallId: messageId,
      env,
      externalSignal,
    });
    return;
  }
  if (job.kind === "resume_question") {
    // The toolCallId rides in the message_id column for this job kind.
    await handlers.resumeQuestionResponse({
      sessionId: job.sessionId,
      toolCallId: messageId,
      env,
      externalSignal,
    });
    return;
  }
  await handlers.runAfterSession({ sessionId: job.sessionId, messageId, env, externalSignal });
}

async function failRunnerJob(input: {
  job: RunnerJob;
  leaseId: string;
  leaseOwner: string;
  error: unknown;
  store: RunnerJobStore;
  maxLeaseBusyAttempts?: number;
}) {
  const now = new Date();
  // A lease-busy failure means the execution (run) lease is held elsewhere — normally we defer and
  // let that in-flight run finish the message. But deferring forever lets a stale job-lease re-claim
  // loop run away (one job reached 17 attempts). Cap it: past the ceiling, give up so the owning run
  // is the single source of truth instead of a perpetually re-queued duplicate. Other failures keep
  // the existing attempt/non-retryable terminal rules.
  const leaseBusyCeiling = input.maxLeaseBusyAttempts ?? RUNNER_JOB_MAX_LEASE_BUSY_ATTEMPTS;
  const terminal =
    input.error instanceof RunLeaseBusyError
      ? input.job.attempts >= leaseBusyCeiling
      : input.job.attempts >= RUNNER_JOB_MAX_ATTEMPTS || isNonRetryableRunnerError(input.error);
  await input.store.fail({
    id: input.job.id,
    leaseId: input.leaseId,
    leaseOwner: input.leaseOwner,
    now,
    status: terminal ? "failed" : "pending",
    nextRunAt: terminal ? now : retryAfter(now, input.job.attempts),
    lastError: errorMessage(input.error),
  });
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function runnerJobIdempotencyKey(input: EnqueueRunnerJobInput) {
  if (input.kind === "start") return `start:${input.sessionId}`;

  const messageId = input.messageId?.trim();
  if (!messageId) {
    throw new Error(`${input.kind} runner jobs require messageId.`);
  }
  return `${input.kind}:${input.sessionId}:${messageId}`;
}

function requireJobMessageId(job: RunnerJob) {
  if (!job.messageId) {
    throw new Error(`${job.kind} runner job ${job.id} is missing messageId.`);
  }
  return job.messageId;
}

function requireJobLease(job: RunnerJob, field: "leaseId" | "leaseOwner") {
  const value = job[field];
  if (!value) {
    throw new Error(`Claimed runner job ${job.id} is missing ${field}.`);
  }
  return value;
}

function newRunnerJobLeaseId() {
  return `runner_job_${randomUUID()}`;
}

function runnerJobLeaseExpiresAt(now: Date, ttlMs: number = RUNNER_JOB_LEASE_TTL_MS) {
  return new Date(now.getTime() + ttlMs);
}

function retryAfter(now: Date, attempts: number) {
  const delaySeconds = Math.min(60, 5 * 2 ** Math.max(0, attempts - 1));
  return new Date(now.getTime() + delaySeconds * 1000);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown runner job error.";
}

const runnerJobColumnsSql = sql`
  id,
  idempotency_key AS "idempotencyKey",
  session_id AS "sessionId",
  message_id AS "messageId",
  kind,
  status,
  attempts,
  next_run_at AS "nextRunAt",
  lease_id AS "leaseId",
  lease_owner AS "leaseOwner",
  lease_expires_at AS "leaseExpiresAt",
  last_error AS "lastError",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

type RunnerJobRow = Omit<RunnerJob, "nextRunAt" | "leaseExpiresAt" | "createdAt" | "updatedAt"> & {
  nextRunAt: Date | string;
  leaseExpiresAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

function runnerJobFromRow(row: RunnerJobRow): RunnerJob {
  return {
    ...row,
    nextRunAt: toDate(row.nextRunAt),
    leaseExpiresAt: row.leaseExpiresAt ? toDate(row.leaseExpiresAt) : null,
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
  };
}

function toDate(value: Date | string) {
  return value instanceof Date ? value : new Date(value);
}
