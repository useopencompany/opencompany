import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "./client";
import { actionTurns } from "./product-schema";

type DbLike = any;

export type ActionTurnPolicy = "foregroundInteractive" | "headless";

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

export type ActionApprovalRecord = {
  actionId: string;
  sourceId: string;
  capabilityId: string;
  inputHash: string;
  status: "pending" | "approved" | "denied";
  requestedAt: string;
  resolvedAt?: string;
};

const ACTION_TURN_TTL_MS = 6 * 60 * 60 * 1000;

export async function registerActionApproval(input: {
  turn: ActionTurnRef;
  invocationId: string;
  actionId: string;
  sourceId: string;
  capabilityId: string;
  params: Record<string, unknown>;
  decision?: "pending" | "denied";
  now?: Date;
  db?: DbLike;
}): Promise<ActionApprovalRecord | null> {
  const db = input.db ?? getDb();
  await ensureActionTurn(input.turn, db);
  const now = input.now ?? new Date();
  const record: ActionApprovalRecord = {
    actionId: input.actionId,
    sourceId: input.sourceId,
    capabilityId: input.capabilityId,
    inputHash: actionApprovalInputHash(input.params),
    status: input.decision ?? "pending",
    requestedAt: now.toISOString(),
    ...(input.decision === "denied" ? { resolvedAt: now.toISOString() } : {}),
  };
  const recordJson = JSON.stringify(record);
  const [stored] = await db
    .update(actionTurns)
    .set({
      approvalRecords: sql`CASE
        WHEN NOT (${actionTurns.approvalRecords} ? ${input.invocationId})
          THEN ${actionTurns.approvalRecords}
            || jsonb_build_object(${input.invocationId}, ${recordJson}::jsonb)
        WHEN ${input.decision === "denied"}::boolean
          AND ${actionTurns.approvalRecords} -> ${input.invocationId} ->> 'status' = 'pending'
          THEN jsonb_set(
            ${actionTurns.approvalRecords},
            ARRAY[${input.invocationId}]::text[],
            (${actionTurns.approvalRecords} -> ${input.invocationId}) || jsonb_build_object(
              'status', 'denied'::text,
              'resolvedAt', ${now.toISOString()}::text
            )
          )
        ELSE ${actionTurns.approvalRecords}
      END`,
      updatedAt: now,
      expiresAt: actionTurnExpiresAt(now),
    })
    .where(
      and(
        actionTurnMatches(input.turn),
        sql`(
          NOT (${actionTurns.approvalRecords} ? ${input.invocationId})
          OR (
            ${actionTurns.approvalRecords} -> ${input.invocationId} ->> 'actionId'
              = ${record.actionId}
            AND ${actionTurns.approvalRecords} -> ${input.invocationId} ->> 'sourceId'
              = ${record.sourceId}
            AND ${actionTurns.approvalRecords} -> ${input.invocationId} ->> 'capabilityId'
              = ${record.capabilityId}
            AND ${actionTurns.approvalRecords} -> ${input.invocationId} ->> 'inputHash'
              = ${record.inputHash}
          )
        )`,
      ),
    )
    .returning({ approvalRecords: actionTurns.approvalRecords });
  return actionApprovalRecord(stored?.approvalRecords?.[input.invocationId]);
}

export async function getActionApproval(input: {
  turn: ActionTurnRef;
  invocationId: string;
  db?: DbLike;
}): Promise<ActionApprovalRecord | null> {
  const db = input.db ?? getDb();
  const [row] = await db
    .select({ approvalRecords: actionTurns.approvalRecords })
    .from(actionTurns)
    .where(actionTurnMatches(input.turn))
    .limit(1);
  return actionApprovalRecord(row?.approvalRecords?.[input.invocationId]);
}

export async function resolveActionApproval(input: {
  turn: ActionTurnRef;
  invocationId: string;
  decision: "approved" | "denied";
  now?: Date;
  db?: DbLike;
}): Promise<
  | { ok: true; record: ActionApprovalRecord; duplicate: boolean }
  | { ok: false; reason: "not_found" | "conflict" }
> {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const [resolved] = await db
    .update(actionTurns)
    .set({
      approvalRecords: sql`jsonb_set(
        ${actionTurns.approvalRecords},
        ARRAY[${input.invocationId}]::text[],
        (${actionTurns.approvalRecords} -> ${input.invocationId}) || jsonb_build_object(
          'status', ${input.decision}::text,
          'resolvedAt', ${now.toISOString()}::text
        )
      )`,
      updatedAt: now,
      expiresAt: actionTurnExpiresAt(now),
    })
    .where(
      and(
        actionTurnMatches(input.turn),
        sql`${actionTurns.approvalRecords} -> ${input.invocationId} ->> 'status' = 'pending'`,
      ),
    )
    .returning({ approvalRecords: actionTurns.approvalRecords });
  const resolvedRecord = actionApprovalRecord(resolved?.approvalRecords?.[input.invocationId]);
  if (resolvedRecord) return { ok: true, record: resolvedRecord, duplicate: false };

  const existing = await getActionApproval({
    turn: input.turn,
    invocationId: input.invocationId,
    db,
  });
  if (!existing) return { ok: false, reason: "not_found" };
  return existing.status === input.decision
    ? { ok: true, record: existing, duplicate: true }
    : { ok: false, reason: "conflict" };
}

export function actionApprovalInputHash(params: Record<string, unknown>) {
  return createHash("sha256").update(stableJson(params)).digest("hex");
}

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
      expiresAt: new Date(now.getTime() + ACTION_TURN_TTL_MS),
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

function actionTurnExpiresAt(now = new Date()) {
  return new Date(now.getTime() + ACTION_TURN_TTL_MS);
}

function actionApprovalRecord(value: unknown): ActionApprovalRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.actionId !== "string" ||
    typeof record.sourceId !== "string" ||
    typeof record.capabilityId !== "string" ||
    typeof record.inputHash !== "string" ||
    (record.status !== "pending" && record.status !== "approved" && record.status !== "denied") ||
    typeof record.requestedAt !== "string" ||
    !(record.resolvedAt === undefined || typeof record.resolvedAt === "string")
  ) {
    return null;
  }
  return {
    actionId: record.actionId,
    sourceId: record.sourceId,
    capabilityId: record.capabilityId,
    inputHash: record.inputHash,
    status: record.status,
    requestedAt: record.requestedAt,
    ...(typeof record.resolvedAt === "string" ? { resolvedAt: record.resolvedAt } : {}),
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}
