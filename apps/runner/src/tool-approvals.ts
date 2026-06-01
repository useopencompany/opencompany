import { agentToolApprovals } from "@opencompany/db/schema";
import { and, eq } from "drizzle-orm";
import { getDb } from "./db";
import type { RunControlCheck } from "./run-control";

// How often the gate re-checks the approval row while paused. Kept tighter than the
// run-control heartbeat throttle (5s) so every poll also refreshes the lease — see
// awaitToolApproval. Also bounds how quickly an in-chat decision is observed.
export const APPROVAL_POLL_INTERVAL_MS = 2_000;

// How long a tool call waits for a human decision before auto-denying. Must stay
// comfortably below RUN_LEASE_TTL_MS (15m) so the lease never expires mid-wait, and
// short enough not to outlast the model stream / gateway idle window.
export const APPROVAL_TIMEOUT_MS = 3 * 60 * 1000;

export type ApprovalResolution = {
  decision: "approved" | "denied";
  source: "user" | "timeout";
};

// Block until the workspace user approves/denies this tool call (in chat), the wait
// times out, or the run aborts. The loop reuses `checkAbort({ force: true })` on every
// iteration: that single call heartbeats the lease (keeping it alive across a long
// human wait) AND throws RunAbortError / RunLeaseLostError if the run was stopped or
// reclaimed — so an aborted run never hangs here.
export async function awaitToolApproval(input: {
  sessionId: string;
  toolCallId: string;
  requestedAtMs: number;
  checkAbort: RunControlCheck;
  signal: AbortSignal;
  now?: () => number;
  pollIntervalMs?: number;
  timeoutMs?: number;
}): Promise<ApprovalResolution> {
  const now = input.now ?? (() => Date.now());
  const pollIntervalMs = input.pollIntervalMs ?? APPROVAL_POLL_INTERVAL_MS;
  const timeoutMs = input.timeoutMs ?? APPROVAL_TIMEOUT_MS;

  for (;;) {
    await input.checkAbort({ force: true });

    const current = await readApprovalStatus(input.sessionId, input.toolCallId);
    if (current && current.status !== "pending") {
      return {
        decision: current.status,
        source: current.decisionSource === "timeout" ? "timeout" : "user",
      };
    }

    if (now() - input.requestedAtMs >= timeoutMs) {
      return expireApproval(input.sessionId, input.toolCallId);
    }

    await sleep(pollIntervalMs, input.signal);
  }
}

async function readApprovalStatus(sessionId: string, toolCallId: string) {
  const [row] = await getDb()
    .select({
      status: agentToolApprovals.status,
      decisionSource: agentToolApprovals.decisionSource,
    })
    .from(agentToolApprovals)
    .where(
      and(
        eq(agentToolApprovals.sessionId, sessionId),
        eq(agentToolApprovals.toolCallId, toolCallId),
      ),
    )
    .limit(1);
  return row ?? null;
}

// Auto-deny a still-pending approval on timeout. The `status = 'pending'` guard means
// a user decision that landed concurrently wins; in that case we re-read and return
// the real decision instead of forcing a timeout denial.
async function expireApproval(sessionId: string, toolCallId: string): Promise<ApprovalResolution> {
  const updated = await getDb()
    .update(agentToolApprovals)
    .set({
      status: "denied",
      decisionSource: "timeout",
      decidedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agentToolApprovals.sessionId, sessionId),
        eq(agentToolApprovals.toolCallId, toolCallId),
        eq(agentToolApprovals.status, "pending"),
      ),
    )
    .returning({ id: agentToolApprovals.id });

  if (updated.length > 0) {
    return { decision: "denied", source: "timeout" };
  }

  const current = await readApprovalStatus(sessionId, toolCallId);
  if (current && current.status !== "pending") {
    return {
      decision: current.status,
      source: current.decisionSource === "timeout" ? "timeout" : "user",
    };
  }
  return { decision: "denied", source: "timeout" };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Run aborted."));
      return;
    }
    const onAbort = () => {
      cleanup();
      reject(new Error("Run aborted."));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
