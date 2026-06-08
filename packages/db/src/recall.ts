import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";
import { agentSessionMessageChunks, agentSessionMessages, agentSessions } from "./schema";

// Cross-session recall. The transcript (agent_sessions + agent_session_messages) is the source of
// truth; agent_session_message_chunks is a derived, rebuildable projection. This module owns both
// sides of it:
//   1. indexPendingMessageChunks — an idempotent sweep that chunks completed user/assistant
//      messages into searchable rows (one per message; oversized messages split by char budget).
//   2. recallSessions — the scoped Postgres FTS + pg_trgm search the runner-side `recall` tool runs.
// It lives in @opencompany/db so the web indexer (neon-http) and the runner search (pooled
// node-postgres) share identical SQL with no client coupling — depending only on the schema, like
// sync-outbox.ts.

// Only user/assistant text is recallable; tool output and internal/system messages are excluded.
const RECALL_ROLES = ["user", "assistant"];

// Oversized messages are sliced so one giant assistant message does not become a multi-KB "blob"
// that degrades ts_rank and trigram similarity. ~2000 chars ≈ a few hundred words.
export const MAX_CHUNK_CHARS = 2000;
// Avoid tiny tail slices: prefer a boundary no earlier than the midpoint before hard-cutting.
const MIN_CHUNK_CHARS = Math.floor(MAX_CHUNK_CHARS / 2);

// Per-sweep cap on messages processed. The sweep is re-entrant: a busy backlog drains over
// successive runs (and the same path backfills history) without one run doing unbounded work.
export const RECALL_INDEX_SWEEP_LIMIT = 200;

// Default / max recall results returned to the agent.
export const RECALL_DEFAULT_LIMIT = 5;
export const RECALL_MAX_LIMIT = 20;
// Each returned chunk is truncated so a recall result set stays token-bounded.
export const RECALL_SNIPPET_MAX_CHARS = 1000;

// Split a message into <= MAX_CHUNK_CHARS slices, preferring paragraph → sentence → line →
// whitespace boundaries so a slice rarely cuts mid-word. Pure and deterministic (unit-tested).
// Returns [] for whitespace-only content (nothing worth recalling).
export function chunkMessageContent(content: string): string[] {
  const normalized = content.trim();
  if (normalized.length === 0) return [];
  if (normalized.length <= MAX_CHUNK_CHARS) return [normalized];

  const chunks: string[] = [];
  let rest = normalized;
  while (rest.length > MAX_CHUNK_CHARS) {
    const window = rest.slice(0, MAX_CHUNK_CHARS);
    const cut = findBreakpoint(window);
    const slice = rest.slice(0, cut).trim();
    if (slice.length > 0) chunks.push(slice);
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

// Index of where to cut a full window, preferring the latest "natural" boundary at or past the
// midpoint; falls back to a hard cut at the window end.
function findBreakpoint(window: string): number {
  for (const sep of ["\n\n", ". ", ".\n", "\n", " "]) {
    const idx = window.lastIndexOf(sep);
    if (idx >= MIN_CHUNK_CHARS) return idx + sep.length;
  }
  return window.length;
}

export type IndexPendingChunksResult = { scanned: number; indexed: number };

// Chunk completed, non-empty user/assistant messages that have no chunk row yet. Idempotent: the
// unique (message_id, sub_index) index + ON CONFLICT DO NOTHING makes re-runs and overlapping
// sweeps safe, and empty-content messages (e.g. an assistant turn that only made tool calls) are
// filtered out so they never become permanently-"pending" rows that block progress.
export async function indexPendingMessageChunks<TQuery extends PgQueryResultHKT>(
  db: Pick<PgDatabase<TQuery, typeof schema>, "select" | "insert">,
  options: { limit?: number } = {},
): Promise<IndexPendingChunksResult> {
  const limit = options.limit ?? RECALL_INDEX_SWEEP_LIMIT;

  const pending = await db
    .select({
      messageId: agentSessionMessages.id,
      sessionId: agentSessionMessages.sessionId,
      role: agentSessionMessages.role,
      content: agentSessionMessages.content,
      messageCreatedAt: agentSessionMessages.createdAt,
      agentId: agentSessions.agentId,
      userId: agentSessions.userId,
    })
    .from(agentSessionMessages)
    .innerJoin(agentSessions, eq(agentSessions.id, agentSessionMessages.sessionId))
    .leftJoin(
      agentSessionMessageChunks,
      eq(agentSessionMessageChunks.messageId, agentSessionMessages.id),
    )
    .where(
      and(
        eq(agentSessionMessages.status, "completed"),
        eq(agentSessionMessages.internal, false),
        inArray(agentSessionMessages.role, RECALL_ROLES),
        sql`length(btrim(${agentSessionMessages.content})) > 0`,
        isNull(agentSessionMessageChunks.id),
      ),
    )
    .orderBy(agentSessionMessages.createdAt)
    .limit(limit);

  if (pending.length === 0) return { scanned: 0, indexed: 0 };

  const rows = pending.flatMap((message) =>
    chunkMessageContent(message.content).map((content, subIndex) => ({
      messageId: message.messageId,
      sessionId: message.sessionId,
      agentId: message.agentId,
      userId: message.userId,
      role: message.role,
      subIndex,
      content,
      messageCreatedAt: message.messageCreatedAt,
    })),
  );

  if (rows.length === 0) return { scanned: pending.length, indexed: 0 };

  await db
    .insert(agentSessionMessageChunks)
    .values(rows)
    .onConflictDoNothing({
      target: [agentSessionMessageChunks.messageId, agentSessionMessageChunks.subIndex],
    });

  return { scanned: pending.length, indexed: rows.length };
}

export type RecallWindowMessage = { role: string; content: string; isMatch: boolean };
export type RecallResult = {
  sessionId: string;
  sessionTitle: string;
  when: string;
  score: number;
  window: RecallWindowMessage[];
};

type RecallRow = {
  match_id: number;
  score: number;
  session_id: string;
  session_title: string;
  match_created_at: string;
  role: string;
  content: string;
  is_match: boolean;
};

// Search this agent's past sessions with this user. Blends Postgres FTS (keyword relevance via
// ts_rank_cd) with pg_trgm word-similarity (typo/fuzzy) over the scoped chunk set, takes the best
// `limit` chunks, and returns each as a window of the matched message ± its nearest neighbors so an
// isolated short turn ("yes, do that") is readable in context. `excludeSessionId` drops the live
// session (already in the agent's context); pass "" to exclude nothing.
export async function recallSessions<TQuery extends PgQueryResultHKT>(
  db: Pick<PgDatabase<TQuery, typeof schema>, "execute">,
  input: {
    agentId: string;
    userId: string;
    excludeSessionId?: string;
    query: string;
    limit?: number;
  },
): Promise<RecallResult[]> {
  const query = input.query.trim();
  if (query.length === 0) return [];
  const limit = Math.min(Math.max(input.limit ?? RECALL_DEFAULT_LIMIT, 1), RECALL_MAX_LIMIT);
  const excludeSessionId = input.excludeSessionId ?? "";

  const result = await db.execute(sql`
    WITH scoped AS (
      SELECT c.id, c.session_id, c.content, c.role, c.message_created_at, c.sub_index, c.tsv
      FROM agent_session_message_chunks c
      WHERE c.agent_id = ${input.agentId}
        AND c.user_id = ${input.userId}
        AND c.session_id <> ${excludeSessionId}
    ),
    tsq AS (SELECT websearch_to_tsquery('english', ${query}) AS query),
    fts AS (
      SELECT s.id, ts_rank_cd(s.tsv, tsq.query) AS rank
      FROM scoped s, tsq
      WHERE tsq.query @@ s.tsv
    ),
    trgm AS (
      SELECT s.id, word_similarity(${query}, s.content) AS sim
      FROM scoped s
      WHERE ${query} <% s.content
    ),
    matches AS (
      SELECT cand.id, COALESCE(fts.rank, 0) + COALESCE(trgm.sim, 0) AS score
      FROM (SELECT id FROM fts UNION SELECT id FROM trgm) cand
      LEFT JOIN fts ON fts.id = cand.id
      LEFT JOIN trgm ON trgm.id = cand.id
    ),
    ordered AS (
      SELECT s.id, s.session_id, s.content, s.role, s.message_created_at,
             row_number() OVER (
               PARTITION BY s.session_id ORDER BY s.message_created_at, s.sub_index
             ) AS ord
      FROM scoped s
      WHERE s.content <> ''
    ),
    top AS (
      SELECT m.id, m.score, o.session_id, o.ord, o.message_created_at
      FROM matches m
      JOIN ordered o ON o.id = m.id
      ORDER BY m.score DESC, o.message_created_at DESC
      LIMIT ${limit}
    )
    SELECT t.id AS match_id, t.score, t.session_id,
           sess.title AS session_title,
           t.message_created_at AS match_created_at,
           w.role, w.content, (w.ord = t.ord) AS is_match
    FROM top t
    JOIN agent_sessions sess ON sess.id = t.session_id
    JOIN ordered w ON w.session_id = t.session_id AND w.ord BETWEEN t.ord - 1 AND t.ord + 1
    ORDER BY t.score DESC, t.message_created_at DESC, t.id, w.ord
  `);

  const rows = rowsFrom<RecallRow>(result);

  // Rows arrive grouped per match (contiguous, in score order) thanks to the ORDER BY; fold each
  // group's window into one result.
  const byMatch = new Map<number, RecallResult>();
  for (const row of rows) {
    let entry = byMatch.get(row.match_id);
    if (!entry) {
      entry = {
        sessionId: row.session_id,
        sessionTitle: row.session_title,
        when: row.match_created_at,
        score: Number(row.score),
        window: [],
      };
      byMatch.set(row.match_id, entry);
    }
    entry.window.push({
      role: row.role,
      content: truncate(row.content, RECALL_SNIPPET_MAX_CHARS),
      isMatch: row.is_match === true,
    });
  }

  return Array.from(byMatch.values());
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max).trimEnd()}…`;
}

// Normalize db.execute results across drivers: pooled node-postgres returns `{ rows }`, neon-http
// returns the array directly.
function rowsFrom<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as T[];
  }
  return [];
}
