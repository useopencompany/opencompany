import { recallSessions } from "@opencompany/db/recall";
import { agentSessions } from "@opencompany/db/schema";
import { eq, sql } from "drizzle-orm";
import { getDb } from "./db";

// Recall runs inside a live agent turn, so it must never hang it. The FTS/trigram search is
// index-backed (see recall.ts) but the neighbor-window scan is bounded only by the user's chunk
// count, so we cap each search with a transaction-local statement_timeout. SET LOCAL resets when the
// transaction ends, so it never leaks to other queries on the pooled connection.
const RECALL_STATEMENT_TIMEOUT_MS = 5000;

// The `recall` tool runs in the runner process (kind: "internal"), not the sandbox: it queries
// Postgres directly (the sandbox has no DB access) and needs no AI Gateway key — v1 recall is pure
// Postgres FTS + pg_trgm with no embeddings. It searches THIS agent's past sessions with THIS user
// (scope derived from the current session row) and excludes the live session, whose transcript is
// already in the model's context.
export async function runRecallTool(input: { sessionId: string; args: unknown }): Promise<unknown> {
  const { query, limit } = parseRecallArgs(input.args);
  if (!query) {
    return {
      ok: false,
      error: {
        message: "recall requires a non-empty `query` string describing what to look for.",
        code: "invalid_tool_input",
        recoverable: true,
      },
    };
  }

  const db = getDb();
  const sessionRows = await db
    .select({ agentId: agentSessions.agentId, userId: agentSessions.userId })
    .from(agentSessions)
    .where(eq(agentSessions.id, input.sessionId))
    .limit(1);
  const session = sessionRows[0];
  if (!session) {
    return {
      ok: false,
      error: {
        message: "Could not resolve the current session to scope recall.",
        code: "session_not_found",
        recoverable: false,
      },
    };
  }

  let results: Awaited<ReturnType<typeof recallSessions>>;
  try {
    results = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = ${RECALL_STATEMENT_TIMEOUT_MS}`);
      return recallSessions(tx, {
        agentId: session.agentId,
        userId: session.userId,
        excludeSessionId: input.sessionId,
        query,
        ...(limit !== undefined ? { limit } : {}),
      });
    });
  } catch (error) {
    return {
      ok: false,
      error: {
        message: `Recall search failed: ${error instanceof Error ? error.message : String(error)}`,
        code: "recall_failed",
        recoverable: true,
      },
    };
  }

  return {
    ok: true,
    query,
    resultCount: results.length,
    results,
  };
}

function parseRecallArgs(args: unknown): { query: string; limit?: number } {
  if (!args || typeof args !== "object") return { query: "" };
  const record = args as Record<string, unknown>;
  const query = typeof record.query === "string" ? record.query.trim() : "";
  const rawLimit = record.limit;
  const limit =
    typeof rawLimit === "number" && Number.isFinite(rawLimit) ? Math.floor(rawLimit) : undefined;
  return limit !== undefined ? { query, limit } : { query };
}
