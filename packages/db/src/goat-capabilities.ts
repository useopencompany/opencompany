import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { getDb } from "./client";
import {
  type GoatCapabilityRunStatus,
  type GoatManagedCapabilitySource,
  goatCapabilityRuns,
  goatWorkspaceCapabilities,
} from "./goat-schema";

type DbLike = any;

export const GOAT_MANAGED_CAPABILITY_SOURCES = [
  "x",
  "linkedin",
  "youtube",
  "instagram",
  "tiktok",
  "lead",
  "seo",
] as const satisfies readonly GoatManagedCapabilitySource[];

export type GoatWorkspaceCapabilityState = {
  source: GoatManagedCapabilitySource;
  enabled: boolean;
};

export async function listGoatWorkspaceCapabilities(
  workspaceId: string,
  db: DbLike = getDb(),
): Promise<GoatWorkspaceCapabilityState[]> {
  const rows = await db
    .select({
      source: goatWorkspaceCapabilities.source,
      enabled: goatWorkspaceCapabilities.enabled,
    })
    .from(goatWorkspaceCapabilities)
    .where(eq(goatWorkspaceCapabilities.workspaceId, workspaceId));
  const overrides = new Map<GoatManagedCapabilitySource, boolean>(
    rows.map((row: { source: GoatManagedCapabilitySource; enabled: boolean }) => [
      row.source,
      Boolean(row.enabled),
    ]),
  );
  return GOAT_MANAGED_CAPABILITY_SOURCES.map((source) => ({
    source,
    enabled: overrides.get(source) ?? true,
  }));
}

export async function isGoatWorkspaceCapabilityEnabled(input: {
  workspaceId: string;
  source: GoatManagedCapabilitySource;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  const [row] = await db
    .select({ enabled: goatWorkspaceCapabilities.enabled })
    .from(goatWorkspaceCapabilities)
    .where(
      and(
        eq(goatWorkspaceCapabilities.workspaceId, input.workspaceId),
        eq(goatWorkspaceCapabilities.source, input.source),
      ),
    )
    .limit(1);
  return row ? Boolean(row.enabled) : true;
}

export async function setGoatWorkspaceCapability(input: {
  workspaceId: string;
  source: GoatManagedCapabilitySource;
  enabled: boolean;
  updatedByWorkosId: string;
  db?: DbLike;
}) {
  if (!GOAT_MANAGED_CAPABILITY_SOURCES.includes(input.source)) {
    throw new Error("Unknown managed capability source.");
  }
  const db = input.db ?? getDb();
  const now = new Date();
  const [row] = await db
    .insert(goatWorkspaceCapabilities)
    .values({
      workspaceId: input.workspaceId,
      source: input.source,
      enabled: input.enabled,
      updatedByWorkosId: input.updatedByWorkosId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [goatWorkspaceCapabilities.workspaceId, goatWorkspaceCapabilities.source],
      set: {
        enabled: input.enabled,
        updatedByWorkosId: input.updatedByWorkosId,
        updatedAt: now,
      },
    })
    .returning({
      source: goatWorkspaceCapabilities.source,
      enabled: goatWorkspaceCapabilities.enabled,
    });
  if (!row) throw new Error("Could not update the workspace capability.");
  return row;
}

export type CreateGoatCapabilityRunInput = {
  workspaceId: string;
  userWorkosId: string;
  chatSessionId: string;
  toolCallId?: string | null;
  source: GoatManagedCapabilitySource;
  action: string;
  inputHash: string;
  provider: string;
  endpoint: string;
  status: Extract<GoatCapabilityRunStatus, "awaiting_approval" | "executing">;
  quoteProviderCostUsdMicros: number;
  quotePlatformFeeUsdMicros: number;
  quoteTotalCostUsdMicros: number;
  approvalExpiresAt?: Date | null;
  now?: Date;
  db?: DbLike;
};

export async function createGoatCapabilityRun(input: CreateGoatCapabilityRunInput) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const [row] = await db
    .insert(goatCapabilityRuns)
    .values({
      id: `gcr_${randomUUID().replaceAll("-", "")}`,
      workspaceId: input.workspaceId,
      userWorkosId: input.userWorkosId,
      chatSessionId: input.chatSessionId,
      toolCallId: input.toolCallId ?? null,
      source: input.source,
      action: input.action,
      inputHash: input.inputHash,
      provider: input.provider,
      endpoint: input.endpoint,
      status: input.status,
      quoteProviderCostUsdMicros: input.quoteProviderCostUsdMicros,
      quotePlatformFeeUsdMicros: input.quotePlatformFeeUsdMicros,
      quoteTotalCostUsdMicros: input.quoteTotalCostUsdMicros,
      approvalExpiresAt: input.approvalExpiresAt ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!row) throw new Error("Could not create the capability run.");
  return row;
}

async function expireGoatCapabilityApproval(
  input: {
    id: string;
    userWorkosId: string;
    workspaceId: string;
    now: Date;
  },
  db: DbLike,
) {
  await db
    .update(goatCapabilityRuns)
    .set({ status: "expired", updatedAt: input.now })
    .where(
      and(
        eq(goatCapabilityRuns.id, input.id),
        eq(goatCapabilityRuns.userWorkosId, input.userWorkosId),
        eq(goatCapabilityRuns.workspaceId, input.workspaceId),
        inArray(goatCapabilityRuns.status, ["awaiting_approval", "approved"]),
        lt(goatCapabilityRuns.approvalExpiresAt, input.now),
      ),
    );
}

export async function getGoatCapabilityApproval(input: {
  id: string;
  userWorkosId: string;
  workspaceId: string;
  now?: Date;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  await expireGoatCapabilityApproval({ ...input, now }, db);
  const [row] = await db
    .select()
    .from(goatCapabilityRuns)
    .where(
      and(
        eq(goatCapabilityRuns.id, input.id),
        eq(goatCapabilityRuns.userWorkosId, input.userWorkosId),
        eq(goatCapabilityRuns.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function approveGoatCapabilityRun(input: {
  id: string;
  userWorkosId: string;
  workspaceId: string;
  now?: Date;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  await expireGoatCapabilityApproval({ ...input, now }, db);
  const [approved] = await db
    .update(goatCapabilityRuns)
    .set({ status: "approved", approvedAt: now, updatedAt: now })
    .where(
      and(
        eq(goatCapabilityRuns.id, input.id),
        eq(goatCapabilityRuns.userWorkosId, input.userWorkosId),
        eq(goatCapabilityRuns.workspaceId, input.workspaceId),
        eq(goatCapabilityRuns.status, "awaiting_approval"),
        sql`${goatCapabilityRuns.approvalExpiresAt} > ${now.toISOString()}`,
      ),
    )
    .returning();
  if (approved) return approved;
  return getGoatCapabilityApproval({ ...input, now, db });
}

export async function cancelGoatCapabilityRun(input: {
  id: string;
  userWorkosId: string;
  workspaceId: string;
  now?: Date;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const [canceled] = await db
    .update(goatCapabilityRuns)
    .set({ status: "canceled", updatedAt: now })
    .where(
      and(
        eq(goatCapabilityRuns.id, input.id),
        eq(goatCapabilityRuns.userWorkosId, input.userWorkosId),
        eq(goatCapabilityRuns.workspaceId, input.workspaceId),
        inArray(goatCapabilityRuns.status, ["awaiting_approval", "approved"]),
      ),
    )
    .returning();
  if (canceled) return canceled;
  return getGoatCapabilityApproval({ ...input, now, db });
}

export async function consumeGoatCapabilityApproval(input: {
  id: string;
  userWorkosId: string;
  workspaceId: string;
  chatSessionId: string;
  action: string;
  inputHash: string;
  quoteTotalCostUsdMicros: number;
  now?: Date;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  await expireGoatCapabilityApproval({ ...input, now }, db);
  const [row] = await db
    .update(goatCapabilityRuns)
    .set({ status: "executing", consumedAt: now, updatedAt: now })
    .where(
      and(
        eq(goatCapabilityRuns.id, input.id),
        eq(goatCapabilityRuns.userWorkosId, input.userWorkosId),
        eq(goatCapabilityRuns.workspaceId, input.workspaceId),
        eq(goatCapabilityRuns.chatSessionId, input.chatSessionId),
        eq(goatCapabilityRuns.action, input.action),
        eq(goatCapabilityRuns.inputHash, input.inputHash),
        eq(goatCapabilityRuns.status, "approved"),
        sql`${goatCapabilityRuns.approvalExpiresAt} > ${now.toISOString()}`,
        sql`${goatCapabilityRuns.quoteTotalCostUsdMicros} >= ${input.quoteTotalCostUsdMicros}`,
      ),
    )
    .returning();
  return row ?? null;
}

export async function markGoatCapabilityRunStarted(input: {
  id: string;
  monidRunId: string;
  async: boolean;
  now?: Date;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const [row] = await db
    .update(goatCapabilityRuns)
    .set({
      monidRunId: input.monidRunId,
      status: input.async ? "running" : "executing",
      updatedAt: now,
    })
    .where(
      and(
        eq(goatCapabilityRuns.id, input.id),
        inArray(goatCapabilityRuns.status, ["executing", "running"]),
      ),
    )
    .returning();
  return row ?? null;
}

export async function markGoatCapabilityRunStopping(input: {
  id: string;
  now?: Date;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  await db
    .update(goatCapabilityRuns)
    .set({ status: "stopping", updatedAt: now })
    .where(
      and(
        eq(goatCapabilityRuns.id, input.id),
        inArray(goatCapabilityRuns.status, ["executing", "running"]),
      ),
    );
}

export async function markGoatCapabilityRunSettlementFailure(input: {
  id: string;
  errorCode: string;
  errorMessage: string;
  now?: Date;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  await db
    .update(goatCapabilityRuns)
    .set({
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      updatedAt: now,
    })
    .where(
      and(
        eq(goatCapabilityRuns.id, input.id),
        inArray(goatCapabilityRuns.status, ["executing", "running", "stopping"]),
        sql`${goatCapabilityRuns.settledAt} IS NULL`,
      ),
    );
}

export async function settleGoatCapabilityRun(input: {
  id: string;
  status: Extract<GoatCapabilityRunStatus, "succeeded" | "failed" | "stopped" | "timed_out">;
  providerHttpStatus?: number | null;
  resultCount?: number | null;
  providerCostUsdMicros: number;
  platformFeeUsdMicros: number;
  totalCostUsdMicros: number;
  errorCode?: string | null;
  errorMessage?: string | null;
  now?: Date;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const [row] = await db
    .update(goatCapabilityRuns)
    .set({
      status: input.status,
      providerHttpStatus: input.providerHttpStatus ?? null,
      resultCount: input.resultCount ?? null,
      providerCostUsdMicros: input.providerCostUsdMicros,
      platformFeeUsdMicros: input.platformFeeUsdMicros,
      totalCostUsdMicros: input.totalCostUsdMicros,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ?? null,
      settledAt: now,
      updatedAt: now,
    })
    .where(and(eq(goatCapabilityRuns.id, input.id), sql`${goatCapabilityRuns.settledAt} IS NULL`))
    .returning();
  return row ?? null;
}

export async function listUnsettledGoatCapabilityRuns(input: { limit?: number; db?: DbLike }) {
  const db = input.db ?? getDb();
  return db
    .select()
    .from(goatCapabilityRuns)
    .where(
      and(
        inArray(goatCapabilityRuns.status, ["executing", "running", "stopping"]),
        sql`${goatCapabilityRuns.settledAt} IS NULL`,
        sql`${goatCapabilityRuns.monidRunId} IS NOT NULL`,
      ),
    )
    .orderBy(asc(goatCapabilityRuns.updatedAt), asc(goatCapabilityRuns.id))
    .limit(Math.max(1, Math.min(input.limit ?? 100, 500)));
}

export async function expirePendingGoatCapabilityApprovals(input: { now?: Date; db?: DbLike }) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const result = await db
    .update(goatCapabilityRuns)
    .set({ status: "expired", updatedAt: now })
    .where(
      and(
        inArray(goatCapabilityRuns.status, ["awaiting_approval", "approved"]),
        lt(goatCapabilityRuns.approvalExpiresAt, now),
      ),
    )
    .returning({ id: goatCapabilityRuns.id });
  return result.length;
}
