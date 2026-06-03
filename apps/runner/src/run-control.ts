import { agentSessions } from "@opencompany/db/schema";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { getDb } from "./db";

export const RUN_LEASE_TTL_MS = 15 * 60 * 1000;
export const RUN_HEARTBEAT_INTERVAL_MS = 5_000;
export const STALE_RUN_HEARTBEAT_MS = 5 * 60 * 1000;

export class RunAbortError extends Error {
  constructor(message = "Run aborted.") {
    super(message);
    this.name = "RunAbortError";
  }
}

export class RunLeaseLostError extends Error {
  constructor(message = "Run lease lost.") {
    super(message);
    this.name = "RunLeaseLostError";
  }
}

export type RunLeaseIdentity = {
  sessionId: string;
  leaseId: string;
  leaseOwner: string;
};

export type RunLeaseState = {
  status: string;
  runLeaseId: string | null;
  runLeaseOwner: string | null;
  runLeaseExpiresAt: Date | null;
  runHeartbeatAt: Date | null;
  abortRequestedAt: Date | null;
  archivedAt: Date | null;
};

export type ClaimRunLeaseInput = RunLeaseIdentity & {
  messageId: string;
  sandboxId?: string;
  modelProvider: string;
  modelName: string;
};

export type FinishRunLeaseInput = RunLeaseIdentity & {
  status: "completed" | "aborting" | "failed" | "awaiting_approval" | "awaiting_input";
  lastError?: string | null;
};

/**
 * A run-control check. Cheap, synchronous local-abort detection happens on every
 * call; the throttled DB-backed reconciliation only runs when the cadence interval
 * has elapsed, or when `force` is set at a step/tool/completion boundary.
 */
export type RunControlCheck = (options?: { force?: boolean }) => Promise<void>;

export type RunControlStore = {
  claimLease(input: ClaimRunLeaseInput, now: Date, expiresAt: Date): Promise<boolean>;
  /**
   * Refresh the lease heartbeat and read run-control state in a single round-trip.
   * Returns the post-update state, or `null` when the lease is no longer ours
   * (reclaimed elsewhere or the session was archived).
   */
  heartbeatAndLoadState(
    input: RunLeaseIdentity,
    now: Date,
    expiresAt: Date,
  ): Promise<RunLeaseState | null>;
  finishLease(input: FinishRunLeaseInput, now: Date): Promise<boolean>;
  releaseLease(input: RunLeaseIdentity, now: Date): Promise<boolean>;
};

export function createDbRunControlStore(): RunControlStore {
  return {
    async claimLease(input, now, expiresAt) {
      const [updated] = await getDb()
        .update(agentSessions)
        .set({
          status: "running",
          runLeaseId: input.leaseId,
          runLeaseOwner: input.leaseOwner,
          runLeaseMessageId: input.messageId,
          runLeaseExpiresAt: expiresAt,
          runHeartbeatAt: now,
          ...(input.sandboxId ? { e2bSandboxId: input.sandboxId } : {}),
          modelProvider: input.modelProvider,
          modelName: input.modelName,
          abortRequestedAt: null,
          lastError: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(agentSessions.id, input.sessionId),
            isNull(agentSessions.archivedAt),
            or(
              isNull(agentSessions.runLeaseId),
              isNull(agentSessions.runLeaseExpiresAt),
              lt(agentSessions.runLeaseExpiresAt, now),
              eq(agentSessions.runLeaseId, input.leaseId),
            ),
          ),
        )
        .returning({ id: agentSessions.id });

      return Boolean(updated);
    },

    async heartbeatAndLoadState(input, now, expiresAt) {
      const [updated] = await getDb()
        .update(agentSessions)
        .set({
          runHeartbeatAt: now,
          runLeaseExpiresAt: expiresAt,
          updatedAt: now,
        })
        .where(
          and(
            eq(agentSessions.id, input.sessionId),
            eq(agentSessions.runLeaseId, input.leaseId),
            eq(agentSessions.runLeaseOwner, input.leaseOwner),
            isNull(agentSessions.archivedAt),
          ),
        )
        .returning({
          status: agentSessions.status,
          runLeaseId: agentSessions.runLeaseId,
          runLeaseOwner: agentSessions.runLeaseOwner,
          runLeaseExpiresAt: agentSessions.runLeaseExpiresAt,
          runHeartbeatAt: agentSessions.runHeartbeatAt,
          abortRequestedAt: agentSessions.abortRequestedAt,
          archivedAt: agentSessions.archivedAt,
        });

      return updated ?? null;
    },

    async finishLease(input, now) {
      const [updated] = await getDb()
        .update(agentSessions)
        .set({
          status: input.status,
          runLeaseId: null,
          runLeaseOwner: null,
          runLeaseMessageId: null,
          runLeaseExpiresAt: null,
          runHeartbeatAt: null,
          lastError: input.lastError ?? null,
          updatedAt: now,
        })
        .where(
          and(
            eq(agentSessions.id, input.sessionId),
            eq(agentSessions.runLeaseId, input.leaseId),
            eq(agentSessions.runLeaseOwner, input.leaseOwner),
            isNull(agentSessions.archivedAt),
          ),
        )
        .returning({ id: agentSessions.id });

      return Boolean(updated);
    },

    async releaseLease(input, now) {
      const [updated] = await getDb()
        .update(agentSessions)
        .set({
          runLeaseId: null,
          runLeaseOwner: null,
          runLeaseMessageId: null,
          runLeaseExpiresAt: null,
          runHeartbeatAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(agentSessions.id, input.sessionId),
            eq(agentSessions.runLeaseId, input.leaseId),
            eq(agentSessions.runLeaseOwner, input.leaseOwner),
            isNull(agentSessions.archivedAt),
          ),
        )
        .returning({ id: agentSessions.id });

      return Boolean(updated);
    },
  };
}

export async function claimRunLease(
  input: ClaimRunLeaseInput,
  store: RunControlStore = createDbRunControlStore(),
) {
  const now = new Date();
  return store.claimLease(input, now, leaseExpiresAt(now));
}

/**
 * Refresh the lease heartbeat and reconcile run-control state in one DB round-trip,
 * then enforce the result locally (abort the controller on abort/lease-loss/archive).
 *
 * This is the only DB-backed step in the streaming hot path, so callers throttle it
 * to {@link RUN_HEARTBEAT_INTERVAL_MS} and force it at step/tool/completion
 * boundaries. Local abort detection is separate and free — see
 * {@link createRunControlGate}.
 */
export async function heartbeatAndCheckRunControl(
  input: RunLeaseIdentity & { controller: AbortController },
  store: RunControlStore = createDbRunControlStore(),
) {
  const now = new Date();
  const state = await store.heartbeatAndLoadState(input, now, leaseExpiresAt(now));
  assertRunControlState(input, state);
}

/**
 * The run-control cadence primitive threaded through a run as its `checkAbort`.
 *
 * It cleanly separates the two concerns the streaming hot path used to conflate:
 *
 *   - **Local abort** (stop button / external signal / a lease loss that already
 *     aborted the controller) is checked synchronously on every call. This is free
 *     — no `await`, no DB — so it stays instant for per-token and per-command-output
 *     checks.
 *   - **Remote reconciliation** (abort requested elsewhere, lease reclaimed, session
 *     archived) requires a DB read, which does not need per-token freshness. It is
 *     folded with the lease heartbeat into a single round-trip and throttled to
 *     `intervalMs`. Step/tool/completion boundaries pass `{ force: true }` to
 *     reconcile immediately regardless of the throttle.
 *
 * A streaming turn therefore performs O(turn-duration / interval) DB reads instead
 * of one per stream token.
 */
export function createRunControlGate(input: {
  runLease: RunLeaseIdentity;
  controller: AbortController;
  store?: RunControlStore;
  intervalMs?: number;
  now?: () => number;
}): RunControlCheck {
  const store = input.store ?? createDbRunControlStore();
  const intervalMs = input.intervalMs ?? RUN_HEARTBEAT_INTERVAL_MS;
  const now = input.now ?? (() => Date.now());
  let lastReconcileAtMs = Number.NEGATIVE_INFINITY;

  return async (options) => {
    if (input.controller.signal.aborted) {
      throw new RunAbortError();
    }

    const nowMs = now();
    if (!options?.force && nowMs - lastReconcileAtMs < intervalMs) {
      return;
    }

    lastReconcileAtMs = nowMs;
    await heartbeatAndCheckRunControl({ ...input.runLease, controller: input.controller }, store);
  };
}

export async function finishRunLease(
  input: FinishRunLeaseInput,
  store: RunControlStore = createDbRunControlStore(),
) {
  return store.finishLease(input, new Date());
}

export async function releaseRunLease(
  input: RunLeaseIdentity,
  store: RunControlStore = createDbRunControlStore(),
) {
  return store.releaseLease(input, new Date());
}

/**
 * Tool execution is a natural run-control boundary, so both guard checks force a
 * fresh DB reconciliation rather than relying on the throttled cadence.
 */
export async function withRunControlChecks<T>(checkAbort: RunControlCheck, run: () => Promise<T>) {
  await checkAbort({ force: true });
  const result = await run();
  await checkAbort({ force: true });
  return result;
}

export function assertRunControlState(
  input: RunLeaseIdentity & { controller: AbortController },
  state: RunLeaseState | null,
) {
  if (!state || state.archivedAt) {
    input.controller.abort();
    throw new RunLeaseLostError("Run session is no longer active.");
  }

  if (state.runLeaseId !== input.leaseId || state.runLeaseOwner !== input.leaseOwner) {
    input.controller.abort();
    throw new RunLeaseLostError();
  }

  if (state.abortRequestedAt) {
    input.controller.abort();
    throw new RunAbortError();
  }
}

export function isStaleActiveRun(
  state: Pick<RunLeaseState, "status" | "runHeartbeatAt" | "archivedAt">,
  now: Date = new Date(),
  staleAfterMs = STALE_RUN_HEARTBEAT_MS,
) {
  if (state.archivedAt || state.status !== "running" || !state.runHeartbeatAt) return false;
  return now.getTime() - state.runHeartbeatAt.getTime() > staleAfterMs;
}

function leaseExpiresAt(now: Date) {
  return new Date(now.getTime() + RUN_LEASE_TTL_MS);
}
