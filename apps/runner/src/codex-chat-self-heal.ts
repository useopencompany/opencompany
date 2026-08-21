import { captureException, createLogger } from "@opencompany/observability";
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import { createPollingWorker } from "./polling-worker";
import { rowsFromExecute } from "./sql-exec";

const logger = createLogger({ service: "opencompany-runner", runtime: "codex-chat-self-heal" });

const DEFAULT_POLL_INTERVAL_MS = 5 * 60_000;
// A session is "stuck" once its last K turns all failed pre-engine — same signature as the #1371
// brick. Small enough that one genuine failure plus a legitimate retry never trips it.
const DEFAULT_LOOKBACK_TURNS = 3;
// Pre-engine failures settle in seconds; a real turn that produced engine events takes far longer.
const DEFAULT_MAX_FAST_FAIL_MS = 30_000;
// Only heal a settled session, never one mid-retry: require a short quiet period since last touch.
const DEFAULT_QUIET_PERIOD_MS = 60_000;
// Ignore long-dormant sessions; only sessions active in this window can be looping right now.
const DEFAULT_ACTIVITY_WINDOW_MS = 6 * 60 * 60_000;
const MAX_SESSIONS_PER_SWEEP = 50;

export type FastFailingCodexChatSession = {
  id: string;
  sandboxId: string | null;
  codexThreadId: string | null;
};

export type SelfHealTier = "thread" | "sandbox";

type ListInput = {
  now?: Date;
  lookbackTurns?: number;
  maxFastFailMs?: number;
  quietPeriodMs?: number;
  activityWindowMs?: number;
  limit?: number;
};

/**
 * Sessions whose last K turns every one fast-failed *before the engine started* (status `failed`,
 * no `codex_turn_id`, i.e. zero engine events, settled in under `maxFastFailMs`) — the #1371 brick
 * signature. Restricted to settled sessions that still hold engine runtime state, have been quiet
 * briefly, were active recently, and have no queued/running turn (so a heal can never race one).
 */
export async function listFastFailingCodexChatSessions(input: ListInput = {}) {
  const now = input.now ?? new Date();
  const lookbackTurns = input.lookbackTurns ?? DEFAULT_LOOKBACK_TURNS;
  const maxFastFailSeconds = (input.maxFastFailMs ?? DEFAULT_MAX_FAST_FAIL_MS) / 1_000;
  const quietCutoff = new Date(now.getTime() - (input.quietPeriodMs ?? DEFAULT_QUIET_PERIOD_MS));
  const activityCutoff = new Date(
    now.getTime() - (input.activityWindowMs ?? DEFAULT_ACTIVITY_WINDOW_MS),
  );
  const limit = input.limit ?? MAX_SESSIONS_PER_SWEEP;
  const result = await getDb().execute(sql`
    WITH candidate AS (
      SELECT session.id, session.sandbox_id, session.codex_thread_id
      FROM goat.codex_chat_sessions AS session
      WHERE session.status IN ('idle', 'failed', 'interrupted')
        AND (session.sandbox_id IS NOT NULL OR session.codex_thread_id IS NOT NULL)
        AND session.updated_at <= ${quietCutoff}
        AND session.updated_at >= ${activityCutoff}
        AND NOT EXISTS (
          SELECT 1
          FROM goat.codex_chat_turns AS active
          WHERE active.codex_chat_session_id = session.id
            AND active.status IN ('queued', 'running')
        )
    )
    SELECT candidate.id AS "id",
           candidate.sandbox_id AS "sandboxId",
           candidate.codex_thread_id AS "codexThreadId"
    FROM candidate
    JOIN LATERAL (
      SELECT
        COUNT(*) AS turn_count,
        COUNT(*) FILTER (
          WHERE recent.status = 'failed'
            AND recent.codex_turn_id IS NULL
            AND recent.completed_at IS NOT NULL
            AND recent.completed_at - recent.created_at
                < make_interval(secs => ${maxFastFailSeconds})
        ) AS fast_fail_count
      FROM (
        SELECT turn.status, turn.codex_turn_id, turn.created_at, turn.completed_at
        FROM goat.codex_chat_turns AS turn
        WHERE turn.codex_chat_session_id = candidate.id
        ORDER BY turn.created_at DESC
        LIMIT ${lookbackTurns}
      ) AS recent
    ) AS stats ON true
    WHERE stats.turn_count = ${lookbackTurns}
      AND stats.fast_fail_count = ${lookbackTurns}
    ORDER BY candidate.id
    LIMIT ${limit}
  `);
  return rowsFromExecute<FastFailingCodexChatSession>(result);
}

/**
 * Two-tier remediation, escalating across sweeps: clear the thread id first (cheap — the next turn
 * bootstraps a fresh engine session on the warm sandbox); if the thread is already null and the
 * loop persists, clear the sandbox id too so the next turn provisions a fresh sandbox. The guarded
 * WHERE (settled status + no active turn) makes it impossible to clobber an in-flight turn's state.
 * Returns the tier applied, or null if nothing needed clearing / a turn started in the meantime.
 */
export async function selfHealCodexChatSession(
  session: FastFailingCodexChatSession,
  now = new Date(),
): Promise<SelfHealTier | null> {
  const tier: SelfHealTier = session.codexThreadId !== null ? "thread" : "sandbox";
  const setSql =
    tier === "thread"
      ? sql`codex_thread_id = NULL, updated_at = ${now}`
      : sql`sandbox_id = NULL, codex_thread_id = NULL, updated_at = ${now}`;
  const guard =
    tier === "thread"
      ? sql`codex_thread_id IS NOT NULL`
      : sql`codex_thread_id IS NULL AND sandbox_id IS NOT NULL`;
  const result = await getDb().execute(sql`
    UPDATE goat.codex_chat_sessions AS session
    SET ${setSql}
    WHERE session.id = ${session.id}
      AND session.status IN ('idle', 'failed', 'interrupted')
      AND ${guard}
      AND NOT EXISTS (
        SELECT 1
        FROM goat.codex_chat_turns AS active
        WHERE active.codex_chat_session_id = session.id
          AND active.status IN ('queued', 'running')
      )
    RETURNING session.id
  `);
  if (rowsFromExecute(result).length === 0) return null;
  logger.warn("Reset a bricked opencompany codex chat session", {
    event: "opencompany.goat_codex_chat_self_heal_reset",
    codex_chat_session_id: session.id,
    tier,
    cleared_thread: true,
    cleared_sandbox: tier === "sandbox",
  });
  return tier;
}

export async function sweepFastFailingCodexChatSessions(input: ListInput = {}) {
  const sessions = await listFastFailingCodexChatSessions(input);
  const now = input.now ?? new Date();
  let threadResets = 0;
  let sandboxResets = 0;
  for (const session of sessions) {
    const tier = await selfHealCodexChatSession(session, now);
    if (tier === "thread") threadResets += 1;
    else if (tier === "sandbox") sandboxResets += 1;
  }
  return { detected: sessions.length, threadResets, sandboxResets };
}

export function startCodexChatSelfHealSweeper(options: { pollIntervalMs?: number } = {}) {
  return createPollingWorker({
    pollIntervalMs: Math.max(1_000, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS),
    poll: async ({ signal }) => {
      signal.throwIfAborted();
      const result = await sweepFastFailingCodexChatSessions();
      if (result.threadResets > 0 || result.sandboxResets > 0) {
        logger.info("Self-healed stuck opencompany codex chat sessions", {
          event: "opencompany.goat_codex_chat_self_heal_finished",
          detected_count: result.detected,
          thread_reset_count: result.threadResets,
          sandbox_reset_count: result.sandboxResets,
        });
      }
    },
    onError: (error) => {
      captureException(error, { event: "opencompany.goat_codex_chat_self_heal_failed" });
      logger.error("opencompany codex chat self-heal sweep failed", {
        event: "opencompany.goat_codex_chat_self_heal_failed",
        error,
      });
    },
  });
}
