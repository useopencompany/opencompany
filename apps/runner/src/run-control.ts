import { getDb } from "@opencompany/db/client";
import { agentSessions } from "@opencompany/db/schema";
import { and, eq, isNull, lt, or } from "drizzle-orm";

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
  status: "completed" | "aborting" | "failed";
  lastError?: string | null;
};

export type RunControlStore = {
  claimLease(input: ClaimRunLeaseInput, now: Date, expiresAt: Date): Promise<boolean>;
  heartbeat(input: RunLeaseIdentity, now: Date, expiresAt: Date): Promise<boolean>;
  loadState(sessionId: string): Promise<RunLeaseState | null>;
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

    async heartbeat(input, now, expiresAt) {
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
        .returning({ id: agentSessions.id });

      return Boolean(updated);
    },

    async loadState(sessionId) {
      const [session] = await getDb()
        .select({
          status: agentSessions.status,
          runLeaseId: agentSessions.runLeaseId,
          runLeaseOwner: agentSessions.runLeaseOwner,
          runLeaseExpiresAt: agentSessions.runLeaseExpiresAt,
          runHeartbeatAt: agentSessions.runHeartbeatAt,
          abortRequestedAt: agentSessions.abortRequestedAt,
          archivedAt: agentSessions.archivedAt,
        })
        .from(agentSessions)
        .where(eq(agentSessions.id, sessionId))
        .limit(1);

      return session ?? null;
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

export async function maybeHeartbeatRunLease(
  input: RunLeaseIdentity & { lastHeartbeatAt: number },
  store: RunControlStore = createDbRunControlStore(),
) {
  const nowMs = Date.now();
  if (nowMs - input.lastHeartbeatAt < RUN_HEARTBEAT_INTERVAL_MS) {
    return { heartbeatAt: input.lastHeartbeatAt, leaseActive: true };
  }

  const now = new Date(nowMs);
  const leaseActive = await store.heartbeat(input, now, leaseExpiresAt(now));
  return { heartbeatAt: nowMs, leaseActive };
}

export async function checkRunControl(
  input: RunLeaseIdentity & { controller: AbortController },
  store: RunControlStore = createDbRunControlStore(),
) {
  const state = await store.loadState(input.sessionId);
  assertRunControlState(input, state);
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

export async function withRunControlChecks<T>(
  checkAbort: () => Promise<void>,
  run: () => Promise<T>,
) {
  await checkAbort();
  const result = await run();
  await checkAbort();
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
