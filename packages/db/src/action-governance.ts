import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "./client";
import { actionTurns } from "./schema";

type DbLike = any;

export type ActionTurnPolicy = "foregroundInteractive" | "cloudReadOnly" | "headless";

export type ActionTurnRef = {
  sessionId: string;
  turnId: string;
  userWorkosId: string;
  workspaceId: string;
  policy: ActionTurnPolicy;
};

export type ActionCapabilityQuoteRecord = {
  inputHash: string;
  quoteProviderCostUsdMicros: number;
  quotePlatformFeeUsdMicros: number;
  quoteTotalCostUsdMicros: number;
  decision: "auto" | "approval_required";
  runId?: string;
};

const GOAT_ACTION_TURN_TTL_MS = 6 * 60 * 60 * 1000;

export async function recordActionSourceDiscovery(input: {
  turn: ActionTurnRef;
  sourceId: string;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  await ensureActionTurn(input.turn, db);
  const sourceIds = JSON.stringify([input.sourceId]);
  await db
    .update(actionTurns)
    .set({
      listedSourceIds: sql`CASE
        WHEN ${actionTurns.listedSourceIds} @> ${sourceIds}::jsonb
          THEN ${actionTurns.listedSourceIds}
        ELSE ${actionTurns.listedSourceIds} || ${sourceIds}::jsonb
      END`,
      updatedAt: new Date(),
      expiresAt: actionTurnExpiresAt(),
    })
    .where(actionTurnMatches(input.turn));
}

export async function claimActionInvocation(input: {
  turn: ActionTurnRef;
  sourceId: string;
  invocationId: string;
  maxCalls: number;
  db?: DbLike;
}): Promise<
  | { ok: true; callCount: number; duplicate: boolean }
  | { ok: false; reason: "list_required" | "call_budget" }
> {
  const db = input.db ?? getDb();
  await ensureActionTurn(input.turn, db);
  const sourceIds = JSON.stringify([input.sourceId]);
  const invocationIds = JSON.stringify([input.invocationId]);
  const [claimed] = await db
    .update(actionTurns)
    .set({
      actionCallCount: sql`CASE
        WHEN ${actionTurns.invocationIds} @> ${invocationIds}::jsonb
          THEN ${actionTurns.actionCallCount}
        ELSE ${actionTurns.actionCallCount} + 1
      END`,
      invocationIds: sql`CASE
        WHEN ${actionTurns.invocationIds} @> ${invocationIds}::jsonb
          THEN ${actionTurns.invocationIds}
        ELSE ${actionTurns.invocationIds} || ${invocationIds}::jsonb
      END`,
      updatedAt: new Date(),
      expiresAt: actionTurnExpiresAt(),
    })
    .where(
      and(
        actionTurnMatches(input.turn),
        sql`${actionTurns.listedSourceIds} @> ${sourceIds}::jsonb`,
        sql`NOT (${actionTurns.invocationIds} @> ${invocationIds}::jsonb)`,
        sql`${actionTurns.actionCallCount} < ${input.maxCalls}`,
      ),
    )
    .returning({ callCount: actionTurns.actionCallCount });
  if (claimed) return { ok: true, callCount: claimed.callCount, duplicate: false };

  const [state] = await db
    .select({
      actionCallCount: actionTurns.actionCallCount,
      invocationIds: actionTurns.invocationIds,
      listedSourceIds: actionTurns.listedSourceIds,
    })
    .from(actionTurns)
    .where(actionTurnMatches(input.turn))
    .limit(1);
  if (state?.invocationIds.includes(input.invocationId)) {
    return { ok: true, callCount: state.actionCallCount, duplicate: true };
  }
  return state?.listedSourceIds.includes(input.sourceId)
    ? { ok: false, reason: "call_budget" }
    : { ok: false, reason: "list_required" };
}

export async function getActionCapabilityTurnState(input: { turn: ActionTurnRef; db?: DbLike }) {
  const db = input.db ?? getDb();
  await ensureActionTurn(input.turn, db);
  const [row] = await db
    .select({
      quotedTotalUsdMicros: actionTurns.quotedTotalUsdMicros,
      admittedInvocationIds: actionTurns.admittedInvocationIds,
      capabilityQuotes: actionTurns.capabilityQuotes,
      asyncRunsStarted: actionTurns.asyncRunsStarted,
    })
    .from(actionTurns)
    .where(actionTurnMatches(input.turn))
    .limit(1);
  return {
    quotedTotalUsdMicros: Number(row?.quotedTotalUsdMicros ?? 0),
    admittedInvocationIds: row?.admittedInvocationIds ?? [],
    capabilityQuotes: (row?.capabilityQuotes ?? {}) as Record<string, ActionCapabilityQuoteRecord>,
    asyncRunsStarted: row?.asyncRunsStarted ?? 0,
  };
}

export async function storeActionCapabilityQuote(input: {
  turn: ActionTurnRef;
  invocationId: string;
  quote: ActionCapabilityQuoteRecord;
  admitted: boolean;
  maxQuotedTotalUsdMicros?: number;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  await ensureActionTurn(input.turn, db);
  const quoteJson = JSON.stringify({ [input.invocationId]: input.quote });
  const invocationIds = JSON.stringify([input.invocationId]);
  const [stored] = await db
    .update(actionTurns)
    .set({
      capabilityQuotes: sql`CASE
        WHEN ${actionTurns.capabilityQuotes} ? ${input.invocationId}
          THEN ${actionTurns.capabilityQuotes}
        ELSE ${actionTurns.capabilityQuotes} || ${quoteJson}::jsonb
      END`,
      ...(input.admitted
        ? {
            quotedTotalUsdMicros: sql`CASE
              WHEN ${actionTurns.admittedInvocationIds} @> ${invocationIds}::jsonb
                THEN ${actionTurns.quotedTotalUsdMicros}
              ELSE ${actionTurns.quotedTotalUsdMicros} + ${input.quote.quoteTotalCostUsdMicros}
            END`,
            admittedInvocationIds: sql`CASE
              WHEN ${actionTurns.admittedInvocationIds} @> ${invocationIds}::jsonb
                THEN ${actionTurns.admittedInvocationIds}
              ELSE ${actionTurns.admittedInvocationIds} || ${invocationIds}::jsonb
            END`,
          }
        : {}),
      updatedAt: new Date(),
      expiresAt: actionTurnExpiresAt(),
    })
    .where(
      and(
        actionTurnMatches(input.turn),
        input.admitted && input.maxQuotedTotalUsdMicros !== undefined
          ? sql`(
              ${actionTurns.admittedInvocationIds} @> ${invocationIds}::jsonb
              OR ${actionTurns.quotedTotalUsdMicros} + ${input.quote.quoteTotalCostUsdMicros}
                <= ${input.maxQuotedTotalUsdMicros}
            )`
          : undefined,
      ),
    )
    .returning({ id: actionTurns.id });
  return Boolean(stored);
}

export async function releaseActionCapabilityQuote(input: {
  turn: ActionTurnRef;
  invocationId: string;
  quoteTotalCostUsdMicros: number;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  const invocationIds = JSON.stringify([input.invocationId]);
  await db
    .update(actionTurns)
    .set({
      capabilityQuotes: sql`${actionTurns.capabilityQuotes} - ${input.invocationId}`,
      admittedInvocationIds: sql`coalesce((
        SELECT jsonb_agg(value)
        FROM jsonb_array_elements(${actionTurns.admittedInvocationIds}) value
        WHERE value <> to_jsonb(${input.invocationId}::text)
      ), '[]'::jsonb)`,
      quotedTotalUsdMicros: sql`CASE
        WHEN ${actionTurns.admittedInvocationIds} @> ${invocationIds}::jsonb
          THEN greatest(0, ${actionTurns.quotedTotalUsdMicros} - ${input.quoteTotalCostUsdMicros})
        ELSE ${actionTurns.quotedTotalUsdMicros}
      END`,
      updatedAt: new Date(),
      expiresAt: actionTurnExpiresAt(),
    })
    .where(actionTurnMatches(input.turn));
}

export async function claimActionAsyncRun(input: {
  turn: ActionTurnRef;
  invocationId: string;
  maxRuns: number;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  await ensureActionTurn(input.turn, db);
  const invocationIds = JSON.stringify([input.invocationId]);
  const [claimed] = await db
    .update(actionTurns)
    .set({
      asyncRunsStarted: sql`CASE
        WHEN ${actionTurns.asyncInvocationIds} @> ${invocationIds}::jsonb
          THEN ${actionTurns.asyncRunsStarted}
        ELSE ${actionTurns.asyncRunsStarted} + 1
      END`,
      asyncInvocationIds: sql`CASE
        WHEN ${actionTurns.asyncInvocationIds} @> ${invocationIds}::jsonb
          THEN ${actionTurns.asyncInvocationIds}
        ELSE ${actionTurns.asyncInvocationIds} || ${invocationIds}::jsonb
      END`,
      updatedAt: new Date(),
      expiresAt: actionTurnExpiresAt(),
    })
    .where(
      and(
        actionTurnMatches(input.turn),
        sql`(
          ${actionTurns.asyncInvocationIds} @> ${invocationIds}::jsonb
          OR ${actionTurns.asyncRunsStarted} < ${input.maxRuns}
        )`,
      ),
    )
    .returning({ count: actionTurns.asyncRunsStarted });
  return Boolean(claimed);
}

export async function releaseActionAsyncRun(input: {
  turn: ActionTurnRef;
  invocationId: string;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  const invocationIds = JSON.stringify([input.invocationId]);
  await db
    .update(actionTurns)
    .set({
      asyncRunsStarted: sql`CASE
        WHEN ${actionTurns.asyncInvocationIds} @> ${invocationIds}::jsonb
          THEN greatest(0, ${actionTurns.asyncRunsStarted} - 1)
        ELSE ${actionTurns.asyncRunsStarted}
      END`,
      asyncInvocationIds: sql`coalesce((
        SELECT jsonb_agg(value)
        FROM jsonb_array_elements(${actionTurns.asyncInvocationIds}) value
        WHERE value <> to_jsonb(${input.invocationId}::text)
      ), '[]'::jsonb)`,
      updatedAt: new Date(),
      expiresAt: actionTurnExpiresAt(),
    })
    .where(actionTurnMatches(input.turn));
}

async function ensureActionTurn(turn: ActionTurnRef, db: DbLike) {
  const now = new Date();
  await db
    .insert(actionTurns)
    .values({
      id: actionTurnId(turn.sessionId, turn.turnId),
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      userWorkosId: turn.userWorkosId,
      workspaceId: turn.workspaceId,
      policy: turn.policy,
      expiresAt: new Date(now.getTime() + GOAT_ACTION_TURN_TTL_MS),
      createdAt: now,
      updatedAt: now,
    })
    // Identity and policy are bound on first admission. A later request may
    // refresh turn state through the guarded update that follows, but it must
    // never be able to rewrite the principal attached to an existing turn.
    .onConflictDoNothing({
      target: [actionTurns.sessionId, actionTurns.turnId],
    });
}

function actionTurnId(sessionId: string, turnId: string) {
  return `gat_${createHash("sha256").update(sessionId).update("\0").update(turnId).digest("hex")}`;
}

function actionTurnMatches(turn: ActionTurnRef) {
  return and(
    eq(actionTurns.sessionId, turn.sessionId),
    eq(actionTurns.turnId, turn.turnId),
    eq(actionTurns.userWorkosId, turn.userWorkosId),
    eq(actionTurns.workspaceId, turn.workspaceId),
    eq(actionTurns.policy, turn.policy),
  );
}

function actionTurnExpiresAt() {
  return new Date(Date.now() + GOAT_ACTION_TURN_TTL_MS);
}
