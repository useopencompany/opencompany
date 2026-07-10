import { randomUUID } from "node:crypto";
import {
  type GoatCodexChatSession,
  type GoatCodexChatTurn,
  type GoatCodexChatTurnSettings,
  goatCodexChatSessions,
} from "@opencompany/db/goat-schema";
import { captureException, createLogger } from "@opencompany/observability";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "./db";
import type { RunnerEnv } from "./env";
import { runGoatCodexChatTurn } from "./goat-codex-chat";
import { GoatCodexChatLeaseLostError } from "./goat-codex-chat-errors";
import {
  createGoatCodexChatProjector,
  loadCodexChatAssistantMessageParts,
} from "./goat-codex-chat-events";
import { rowsFromExecute } from "./sql-exec";

const logger = createLogger({ service: "opencompany-runner", runtime: "goat-codex-chat-worker" });
const GOAT_CODEX_CHAT_RECOVERY_ATTEMPT = 2;

let registeredWakeup: (() => void) | null = null;

export function setGoatCodexChatWakeup(wake: (() => void) | null) {
  registeredWakeup = wake;
}

export function wakeGoatCodexChatWorker() {
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
  status: GoatCodexChatTurn["status"];
  prompt: string;
  settings: GoatCodexChatTurnSettings;
  error: string | null;
  interrupt_requested_at: Date | string | null;
  attempts: number;
  lease_id: string | null;
  lease_owner: string | null;
  lease_expires_at: Date | string | null;
  completed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

// Claims the next runnable codex chat turn. Three predicates shape the queue:
//  - claimable: freshly queued, or a running turn whose lease expired (worker crash);
//  - one active turn per session: skip while a sibling holds a live running lease;
//  - per-session FIFO: an earlier queued sibling always goes first.
export async function claimNextGoatCodexChatTurn(input: {
  leaseOwner: string;
  leaseTtlMs: number;
}): Promise<GoatCodexChatTurn | null> {
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
            AND (
              earlier.created_at < turn.created_at
              OR (earlier.created_at = turn.created_at AND earlier.id < turn.id)
            )
        )
      ORDER BY turn.created_at ASC, turn.id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
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
  `);
  const row = rowsFromExecute<ClaimedTurnRow>(result)[0];
  return row ? turnFromRow(row) : null;
}

export async function heartbeatGoatCodexChatTurn(input: {
  turnId: string;
  leaseId: string;
  leaseOwner: string;
  leaseTtlMs: number;
}) {
  const now = new Date();
  const result = await getDb().execute(sql`
    UPDATE goat.codex_chat_turns
    SET lease_expires_at = ${new Date(now.getTime() + input.leaseTtlMs)},
        updated_at = ${now}
    WHERE id = ${input.turnId}
      AND lease_id = ${input.leaseId}
      AND lease_owner = ${input.leaseOwner}
      AND status = 'running'
    RETURNING id
  `);
  return rowsFromExecute<{ id: string }>(result).length > 0;
}

export async function runClaimedTurn(turn: GoatCodexChatTurn, env: RunnerEnv) {
  const leaseId = turn.leaseId;
  const leaseOwner = turn.leaseOwner;
  if (!leaseId || !leaseOwner) throw new Error(`Claimed turn ${turn.id} is missing its lease.`);

  const [session] = await getDb()
    .select()
    .from(goatCodexChatSessions)
    .where(
      and(
        eq(goatCodexChatSessions.id, turn.codexChatSessionId),
        eq(goatCodexChatSessions.userWorkosId, turn.userWorkosId),
      ),
    )
    .limit(1);
  if (!session) throw new Error(`Codex chat session ${turn.codexChatSessionId} not found.`);

  // Reclaimed attempt 2 gets one durable continuation pass. The continuation reuses the warm
  // sandbox/thread when available and asks Codex to inspect current state before side effects.
  // If recovery is reclaimed again, surface a terminal failure instead of looping forever.
  if (turn.attempts > GOAT_CODEX_CHAT_RECOVERY_ATTEMPT) {
    await failReclaimedTurn({ turn, session, leaseId, leaseOwner });
    return;
  }
  if (turn.attempts === GOAT_CODEX_CHAT_RECOVERY_ATTEMPT) {
    logger.info("Recovering reclaimed Goat Codex chat turn", {
      event: "opencompany.goat_codex_chat_turn_recovery_started",
      turn_id: turn.id,
      codex_chat_session_id: session.id,
      has_sandbox: Boolean(session.sandboxId),
      has_codex_thread: Boolean(session.codexThreadId),
    });
  }

  let heartbeatAbort: GoatCodexChatLeaseLostError | null = null;
  const markHeartbeatLost = (error: unknown) => {
    if (heartbeatAbort) return;
    heartbeatAbort = new GoatCodexChatLeaseLostError();
    captureException(error, {
      event: "opencompany.goat_codex_chat_heartbeat_failed",
      turn_id: turn.id,
    });
    logger.warn("Goat codex chat heartbeat failed", {
      event: "opencompany.goat_codex_chat_heartbeat_failed",
      turn_id: turn.id,
      error,
    });
  };
  const heartbeat = setInterval(
    () => {
      void heartbeatGoatCodexChatTurn({
        turnId: turn.id,
        leaseId,
        leaseOwner,
        leaseTtlMs: env.jobLeaseTtlMs,
      })
        .then((owned) => {
          if (!owned) markHeartbeatLost(new GoatCodexChatLeaseLostError());
        })
        .catch(markHeartbeatLost);
    },
    Math.max(5_000, Math.floor(env.jobLeaseTtlMs / 3)),
  );
  try {
    await runGoatCodexChatTurn({
      turn,
      session,
      env,
      ...(turn.attempts === GOAT_CODEX_CHAT_RECOVERY_ATTEMPT
        ? { recovery: { reason: "lease_reclaimed" as const } }
        : {}),
      shouldAbort: () => heartbeatAbort,
    });
  } finally {
    clearInterval(heartbeat);
  }
}

async function failReclaimedTurn(input: {
  turn: GoatCodexChatTurn;
  session: GoatCodexChatSession;
  leaseId: string;
  leaseOwner: string;
}) {
  const projector = createGoatCodexChatProjector({
    target: {
      userWorkosId: input.turn.userWorkosId,
      codexChatSessionId: input.session.id,
      chatSessionId: input.session.chatSessionId,
      turnId: input.turn.id,
      assistantMessageId: input.turn.assistantMessageId,
      model: input.session.model,
      leaseId: input.leaseId,
      leaseOwner: input.leaseOwner,
    },
    redact: (value) => value,
    // Keep whatever partial parts the dead worker already streamed; only finalize them.
    initialParts: await loadCodexChatAssistantMessageParts(input.turn.assistantMessageId),
  });
  await projector.fail(
    "Codex was interrupted by a runner restart. Send your message again to continue.",
  );
}

export function startGoatCodexChatWorker(
  env: RunnerEnv,
  options: { concurrency?: number; pollIntervalMs?: number } = {},
) {
  const concurrency = Math.max(1, options.concurrency ?? Math.min(2, env.workerConcurrency));
  const pollIntervalMs = Math.max(50, options.pollIntervalMs ?? 1_000);
  const active = new Set<Promise<void>>();
  let stopped = false;
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
        while (!stopped && active.size < concurrency) {
          const turn = await claimNextGoatCodexChatTurn({
            leaseOwner: env.instanceId,
            leaseTtlMs: env.jobLeaseTtlMs,
          });
          if (!turn) break;
          const running = runClaimedTurn(turn, env)
            .catch((error) => {
              if (error instanceof GoatCodexChatLeaseLostError) return;
              captureException(error, {
                event: "opencompany.goat_codex_chat_turn_failed",
                turn_id: turn.id,
              });
              logger.error("Goat codex chat turn failed", {
                event: "opencompany.goat_codex_chat_turn_failed",
                turn_id: turn.id,
                error,
              });
            })
            .finally(() => active.delete(running));
          active.add(running);
        }
      } catch (error) {
        captureException(error, { event: "opencompany.goat_codex_chat_worker_failed" });
        logger.error("Goat codex chat worker failed", {
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
    stop: async () => {
      stopped = true;
      notify();
      await loop;
      await Promise.allSettled(Array.from(active));
    },
  };
}

function turnFromRow(row: ClaimedTurnRow): GoatCodexChatTurn {
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
    leaseId: row.lease_id,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: dateFromRow(row.lease_expires_at),
    completedAt: dateFromRow(row.completed_at),
    createdAt: dateFromRow(row.created_at) ?? new Date(),
    updatedAt: dateFromRow(row.updated_at) ?? new Date(),
  };
}

function dateFromRow(value: Date | string | null): Date | null {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value);
}
