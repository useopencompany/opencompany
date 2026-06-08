import { recallSessions } from "@opencompany/db/recall";
import { agentSessions } from "@opencompany/db/schema";
import { eq } from "drizzle-orm";
import { getDb } from "./db";

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

  const results = await recallSessions(db, {
    agentId: session.agentId,
    userId: session.userId,
    excludeSessionId: input.sessionId,
    query,
    ...(limit !== undefined ? { limit } : {}),
  });

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
