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
  const parsed = parseRecallArgs(input.args);
  if (parsed.error) {
    return invalidToolInput(parsed.error);
  }
  const { query, limit, timeWindow } = parsed;

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
      await tx.execute(
        sql`SELECT set_config('statement_timeout', ${`${RECALL_STATEMENT_TIMEOUT_MS}ms`}, true)`,
      );
      return recallSessions(tx, {
        agentId: session.agentId,
        userId: session.userId,
        excludeSessionId: input.sessionId,
        query,
        ...(limit !== undefined ? { limit } : {}),
        ...(timeWindow ? { createdAfter: timeWindow.createdAfter } : {}),
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
    ...(timeWindow
      ? {
          timeWindow: {
            amount: timeWindow.amount,
            unit: timeWindow.unit,
            createdAfter: timeWindow.createdAfter.toISOString(),
          },
        }
      : {}),
    resultCount: results.length,
    results,
  };
}

type RecallTimeWindowUnit = "hours" | "days";
const RECALL_MAX_TIME_WINDOW_DAYS = 30;
const RECALL_MAX_TIME_WINDOW_HOURS = RECALL_MAX_TIME_WINDOW_DAYS * 24;
type NormalizedRecallTimeWindow = {
  amount: number;
  unit: RecallTimeWindowUnit;
  createdAfter: Date;
};
type ParsedRecallArgs = {
  query: string;
  limit?: number;
  timeWindow?: NormalizedRecallTimeWindow;
  error?: string;
};

function invalidToolInput(message: string) {
  return {
    ok: false,
    error: {
      message,
      code: "invalid_tool_input",
      recoverable: true,
    },
  };
}

function parseRecallArgs(args: unknown): ParsedRecallArgs {
  if (!args || typeof args !== "object") {
    return { query: "", error: "recall requires either a non-empty `query` or `time_window`." };
  }
  const record = args as Record<string, unknown>;
  const query = typeof record.query === "string" ? record.query.trim() : "";
  const rawLimit = record.limit;
  const limit =
    typeof rawLimit === "number" && Number.isFinite(rawLimit) ? Math.floor(rawLimit) : undefined;
  const timeWindow = parseTimeWindow(record.time_window);
  if (timeWindow.error) {
    return { query, ...(limit !== undefined ? { limit } : {}), error: timeWindow.error };
  }
  if (!query && !timeWindow.value) {
    return {
      query,
      ...(limit !== undefined ? { limit } : {}),
      error: "recall requires either a non-empty `query` or `time_window`.",
    };
  }
  return {
    query,
    ...(limit !== undefined ? { limit } : {}),
    ...(timeWindow.value ? { timeWindow: timeWindow.value } : {}),
  };
}

function parseTimeWindow(value: unknown): { value?: NormalizedRecallTimeWindow; error?: string } {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "`time_window` must be an object with positive integer `amount` and unit." };
  }
  const record = value as Record<string, unknown>;
  const amount = record.amount;
  if (typeof amount !== "number" || !Number.isFinite(amount) || !Number.isInteger(amount)) {
    return { error: "`time_window.amount` must be a positive integer." };
  }
  if (amount <= 0) {
    return { error: "`time_window.amount` must be greater than 0." };
  }
  const unit = record.unit;
  if (unit !== "hours" && unit !== "days") {
    return { error: '`time_window.unit` must be either "hours" or "days".' };
  }
  const maxAmount = unit === "hours" ? RECALL_MAX_TIME_WINDOW_HOURS : RECALL_MAX_TIME_WINDOW_DAYS;
  if (amount > maxAmount) {
    return { error: `\`time_window.amount\` must be at most ${maxAmount} ${unit}.` };
  }
  const millisecondsPerUnit = unit === "hours" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const createdAfter = new Date(Date.now() - amount * millisecondsPerUnit);
  if (Number.isNaN(createdAfter.getTime())) {
    return { error: "`time_window.amount` produced an invalid time window." };
  }
  return {
    value: {
      amount,
      unit,
      createdAfter,
    },
  };
}
