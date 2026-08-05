import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "./client";
import { goatActionTurns } from "./goat-schema";

type DbLike = any;

export type GoatActionTurnPolicy = "foregroundInteractive" | "cloudReadOnly" | "headless";

export type GoatActionTurnRef = {
  sessionId: string;
  turnId: string;
  userWorkosId: string;
  workspaceId: string;
  policy: GoatActionTurnPolicy;
};

export type GoatActionCapabilityQuoteRecord = {
  inputHash: string;
  quoteProviderCostUsdMicros: number;
  quotePlatformFeeUsdMicros: number;
  quoteTotalCostUsdMicros: number;
  decision: "auto" | "approval_required";
  runId?: string;
};

const GOAT_ACTION_TURN_TTL_MS = 6 * 60 * 60 * 1000;

export async function recordGoatActionSourceDiscovery(input: {
  turn: GoatActionTurnRef;
  sourceId: string;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  await ensureGoatActionTurn(input.turn, db);
  const sourceIds = JSON.stringify([input.sourceId]);
  await db
    .update(goatActionTurns)
    .set({
      listedSourceIds: sql`CASE
        WHEN ${goatActionTurns.listedSourceIds} @> ${sourceIds}::jsonb
          THEN ${goatActionTurns.listedSourceIds}
        ELSE ${goatActionTurns.listedSourceIds} || ${sourceIds}::jsonb
      END`,
      updatedAt: new Date(),
      expiresAt: actionTurnExpiresAt(),
    })
    .where(actionTurnMatches(input.turn));
}

export async function claimGoatActionInvocation(input: {
  turn: GoatActionTurnRef;
  sourceId: string;
  invocationId: string;
  maxCalls: number;
  db?: DbLike;
}): Promise<
  | { ok: true; callCount: number; duplicate: boolean }
  | { ok: false; reason: "list_required" | "call_budget" }
> {
  const db = input.db ?? getDb();
  await ensureGoatActionTurn(input.turn, db);
  const sourceIds = JSON.stringify([input.sourceId]);
  const invocationIds = JSON.stringify([input.invocationId]);
  const [claimed] = await db
    .update(goatActionTurns)
    .set({
      actionCallCount: sql`CASE
        WHEN ${goatActionTurns.invocationIds} @> ${invocationIds}::jsonb
          THEN ${goatActionTurns.actionCallCount}
        ELSE ${goatActionTurns.actionCallCount} + 1
      END`,
      invocationIds: sql`CASE
        WHEN ${goatActionTurns.invocationIds} @> ${invocationIds}::jsonb
          THEN ${goatActionTurns.invocationIds}
        ELSE ${goatActionTurns.invocationIds} || ${invocationIds}::jsonb
      END`,
      updatedAt: new Date(),
      expiresAt: actionTurnExpiresAt(),
    })
    .where(
      and(
        actionTurnMatches(input.turn),
        sql`${goatActionTurns.listedSourceIds} @> ${sourceIds}::jsonb`,
        sql`NOT (${goatActionTurns.invocationIds} @> ${invocationIds}::jsonb)`,
        sql`${goatActionTurns.actionCallCount} < ${input.maxCalls}`,
      ),
    )
    .returning({ callCount: goatActionTurns.actionCallCount });
  if (claimed) return { ok: true, callCount: claimed.callCount, duplicate: false };

  const [state] = await db
    .select({
      actionCallCount: goatActionTurns.actionCallCount,
      invocationIds: goatActionTurns.invocationIds,
      listedSourceIds: goatActionTurns.listedSourceIds,
    })
    .from(goatActionTurns)
    .where(actionTurnMatches(input.turn))
    .limit(1);
  if (state?.invocationIds.includes(input.invocationId)) {
    return { ok: true, callCount: state.actionCallCount, duplicate: true };
  }
  return state?.listedSourceIds.includes(input.sourceId)
    ? { ok: false, reason: "call_budget" }
    : { ok: false, reason: "list_required" };
}

export async function getGoatActionCapabilityTurnState(input: {
  turn: GoatActionTurnRef;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  await ensureGoatActionTurn(input.turn, db);
  const [row] = await db
    .select({
      quotedTotalUsdMicros: goatActionTurns.quotedTotalUsdMicros,
      admittedInvocationIds: goatActionTurns.admittedInvocationIds,
      capabilityQuotes: goatActionTurns.capabilityQuotes,
      asyncRunsStarted: goatActionTurns.asyncRunsStarted,
    })
    .from(goatActionTurns)
    .where(actionTurnMatches(input.turn))
    .limit(1);
  return {
    quotedTotalUsdMicros: Number(row?.quotedTotalUsdMicros ?? 0),
    admittedInvocationIds: row?.admittedInvocationIds ?? [],
    capabilityQuotes: (row?.capabilityQuotes ?? {}) as Record<
      string,
      GoatActionCapabilityQuoteRecord
    >,
    asyncRunsStarted: row?.asyncRunsStarted ?? 0,
  };
}

export async function storeGoatActionCapabilityQuote(input: {
  turn: GoatActionTurnRef;
  invocationId: string;
  quote: GoatActionCapabilityQuoteRecord;
  admitted: boolean;
  maxQuotedTotalUsdMicros?: number;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  await ensureGoatActionTurn(input.turn, db);
  const quoteJson = JSON.stringify({ [input.invocationId]: input.quote });
  const invocationIds = JSON.stringify([input.invocationId]);
  const [stored] = await db
    .update(goatActionTurns)
    .set({
      capabilityQuotes: sql`CASE
        WHEN ${goatActionTurns.capabilityQuotes} ? ${input.invocationId}
          THEN ${goatActionTurns.capabilityQuotes}
        ELSE ${goatActionTurns.capabilityQuotes} || ${quoteJson}::jsonb
      END`,
      ...(input.admitted
        ? {
            quotedTotalUsdMicros: sql`CASE
              WHEN ${goatActionTurns.admittedInvocationIds} @> ${invocationIds}::jsonb
                THEN ${goatActionTurns.quotedTotalUsdMicros}
              ELSE ${goatActionTurns.quotedTotalUsdMicros} + ${input.quote.quoteTotalCostUsdMicros}
            END`,
            admittedInvocationIds: sql`CASE
              WHEN ${goatActionTurns.admittedInvocationIds} @> ${invocationIds}::jsonb
                THEN ${goatActionTurns.admittedInvocationIds}
              ELSE ${goatActionTurns.admittedInvocationIds} || ${invocationIds}::jsonb
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
              ${goatActionTurns.admittedInvocationIds} @> ${invocationIds}::jsonb
              OR ${goatActionTurns.quotedTotalUsdMicros} + ${input.quote.quoteTotalCostUsdMicros}
                <= ${input.maxQuotedTotalUsdMicros}
            )`
          : undefined,
      ),
    )
    .returning({ id: goatActionTurns.id });
  return Boolean(stored);
}

export async function releaseGoatActionCapabilityQuote(input: {
  turn: GoatActionTurnRef;
  invocationId: string;
  quoteTotalCostUsdMicros: number;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  const invocationIds = JSON.stringify([input.invocationId]);
  await db
    .update(goatActionTurns)
    .set({
      capabilityQuotes: sql`${goatActionTurns.capabilityQuotes} - ${input.invocationId}`,
      admittedInvocationIds: sql`coalesce((
        SELECT jsonb_agg(value)
        FROM jsonb_array_elements(${goatActionTurns.admittedInvocationIds}) value
        WHERE value <> to_jsonb(${input.invocationId}::text)
      ), '[]'::jsonb)`,
      quotedTotalUsdMicros: sql`CASE
        WHEN ${goatActionTurns.admittedInvocationIds} @> ${invocationIds}::jsonb
          THEN greatest(0, ${goatActionTurns.quotedTotalUsdMicros} - ${input.quoteTotalCostUsdMicros})
        ELSE ${goatActionTurns.quotedTotalUsdMicros}
      END`,
      updatedAt: new Date(),
      expiresAt: actionTurnExpiresAt(),
    })
    .where(actionTurnMatches(input.turn));
}

export async function claimGoatActionAsyncRun(input: {
  turn: GoatActionTurnRef;
  invocationId: string;
  maxRuns: number;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  await ensureGoatActionTurn(input.turn, db);
  const invocationIds = JSON.stringify([input.invocationId]);
  const [claimed] = await db
    .update(goatActionTurns)
    .set({
      asyncRunsStarted: sql`CASE
        WHEN ${goatActionTurns.asyncInvocationIds} @> ${invocationIds}::jsonb
          THEN ${goatActionTurns.asyncRunsStarted}
        ELSE ${goatActionTurns.asyncRunsStarted} + 1
      END`,
      asyncInvocationIds: sql`CASE
        WHEN ${goatActionTurns.asyncInvocationIds} @> ${invocationIds}::jsonb
          THEN ${goatActionTurns.asyncInvocationIds}
        ELSE ${goatActionTurns.asyncInvocationIds} || ${invocationIds}::jsonb
      END`,
      updatedAt: new Date(),
      expiresAt: actionTurnExpiresAt(),
    })
    .where(
      and(
        actionTurnMatches(input.turn),
        sql`(
          ${goatActionTurns.asyncInvocationIds} @> ${invocationIds}::jsonb
          OR ${goatActionTurns.asyncRunsStarted} < ${input.maxRuns}
        )`,
      ),
    )
    .returning({ count: goatActionTurns.asyncRunsStarted });
  return Boolean(claimed);
}

export async function releaseGoatActionAsyncRun(input: {
  turn: GoatActionTurnRef;
  invocationId: string;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  const invocationIds = JSON.stringify([input.invocationId]);
  await db
    .update(goatActionTurns)
    .set({
      asyncRunsStarted: sql`CASE
        WHEN ${goatActionTurns.asyncInvocationIds} @> ${invocationIds}::jsonb
          THEN greatest(0, ${goatActionTurns.asyncRunsStarted} - 1)
        ELSE ${goatActionTurns.asyncRunsStarted}
      END`,
      asyncInvocationIds: sql`coalesce((
        SELECT jsonb_agg(value)
        FROM jsonb_array_elements(${goatActionTurns.asyncInvocationIds}) value
        WHERE value <> to_jsonb(${input.invocationId}::text)
      ), '[]'::jsonb)`,
      updatedAt: new Date(),
      expiresAt: actionTurnExpiresAt(),
    })
    .where(actionTurnMatches(input.turn));
}

async function ensureGoatActionTurn(turn: GoatActionTurnRef, db: DbLike) {
  const now = new Date();
  await db
    .insert(goatActionTurns)
    .values({
      id: goatActionTurnId(turn.sessionId, turn.turnId),
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
      target: [goatActionTurns.sessionId, goatActionTurns.turnId],
    });
}

function goatActionTurnId(sessionId: string, turnId: string) {
  return `gat_${createHash("sha256").update(sessionId).update("\0").update(turnId).digest("hex")}`;
}

function actionTurnMatches(turn: GoatActionTurnRef) {
  return and(
    eq(goatActionTurns.sessionId, turn.sessionId),
    eq(goatActionTurns.turnId, turn.turnId),
    eq(goatActionTurns.userWorkosId, turn.userWorkosId),
    eq(goatActionTurns.workspaceId, turn.workspaceId),
    eq(goatActionTurns.policy, turn.policy),
  );
}

function actionTurnExpiresAt() {
  return new Date(Date.now() + GOAT_ACTION_TURN_TTL_MS);
}
