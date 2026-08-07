import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { getDb } from "./client";
import {
  type CapabilityRunStatus,
  capabilityRuns,
  type ManagedCapabilitySource,
  workspaceCapabilities,
  workspaces,
} from "./schema";

type DbLike = any;

export const GOAT_MANAGED_CAPABILITY_SOURCES = [
  "x",
  "linkedin",
  "youtube",
  "instagram",
  "tiktok",
  "lead",
  "seo",
] as const satisfies readonly ManagedCapabilitySource[];

export const GOAT_CAPABILITY_SESSION_BUDGET_DEFAULT_USD_MICROS = 5_000_000;

export type WorkspaceCapabilityState = {
  source: ManagedCapabilitySource;
  enabled: boolean;
};

export async function getCapabilitySessionBudgetUsdMicros(
  workspaceId: string,
  db: DbLike = getDb(),
) {
  const [row] = await db
    .select({ budgetUsdMicros: workspaces.capabilitySessionBudgetUsdMicros })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return row?.budgetUsdMicros ?? GOAT_CAPABILITY_SESSION_BUDGET_DEFAULT_USD_MICROS;
}

export async function setCapabilitySessionBudget(input: {
  workspaceId: string;
  budgetUsdMicros: number | null;
  db?: DbLike;
}) {
  if (
    input.budgetUsdMicros !== null &&
    (!Number.isSafeInteger(input.budgetUsdMicros) || input.budgetUsdMicros <= 0)
  ) {
    throw new Error("Capability session budget must be a positive whole number of USD micros.");
  }
  const db = input.db ?? getDb();
  const [row] = await db
    .update(workspaces)
    .set({
      capabilitySessionBudgetUsdMicros: input.budgetUsdMicros,
      updatedAt: new Date(),
    })
    .where(eq(workspaces.id, input.workspaceId))
    .returning({
      budgetUsdMicros: workspaces.capabilitySessionBudgetUsdMicros,
    });
  if (!row) throw new Error("Could not update the capability session budget.");
  return row.budgetUsdMicros ?? GOAT_CAPABILITY_SESSION_BUDGET_DEFAULT_USD_MICROS;
}

export async function sumCapabilitySessionSpendUsdMicros(input: {
  workspaceId: string;
  chatSessionId: string;
  excludeToolCallIds?: readonly string[];
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  const excludeToolCallIds = [...new Set(input.excludeToolCallIds?.filter(Boolean) ?? [])];
  const [row] = await db
    .select({
      totalUsdMicros: sql<number>`coalesce(sum(coalesce(${capabilityRuns.totalCostUsdMicros}, ${capabilityRuns.quoteTotalCostUsdMicros})), 0)::bigint`,
    })
    .from(capabilityRuns)
    .where(
      and(
        eq(capabilityRuns.workspaceId, input.workspaceId),
        eq(capabilityRuns.chatSessionId, input.chatSessionId),
        sql`${capabilityRuns.status} NOT IN ('awaiting_approval', 'canceled', 'expired')`,
        excludeToolCallIds.length > 0
          ? or(
              isNull(capabilityRuns.toolCallId),
              notInArray(capabilityRuns.toolCallId, excludeToolCallIds),
            )
          : undefined,
      ),
    );
  return Number(row?.totalUsdMicros ?? 0);
}

export async function listWorkspaceCapabilities(
  workspaceId: string,
  db: DbLike = getDb(),
): Promise<WorkspaceCapabilityState[]> {
  const rows = await db
    .select({
      source: workspaceCapabilities.source,
      enabled: workspaceCapabilities.enabled,
    })
    .from(workspaceCapabilities)
    .where(eq(workspaceCapabilities.workspaceId, workspaceId));
  const overrides = new Map<ManagedCapabilitySource, boolean>(
    rows.map((row: { source: ManagedCapabilitySource; enabled: boolean }) => [
      row.source,
      Boolean(row.enabled),
    ]),
  );
  return GOAT_MANAGED_CAPABILITY_SOURCES.map((source) => ({
    source,
    enabled: overrides.get(source) ?? true,
  }));
}

export async function isWorkspaceCapabilityEnabled(input: {
  workspaceId: string;
  source: ManagedCapabilitySource;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  const [row] = await db
    .select({ enabled: workspaceCapabilities.enabled })
    .from(workspaceCapabilities)
    .where(
      and(
        eq(workspaceCapabilities.workspaceId, input.workspaceId),
        eq(workspaceCapabilities.source, input.source),
      ),
    )
    .limit(1);
  return row ? Boolean(row.enabled) : true;
}

export async function setWorkspaceCapability(input: {
  workspaceId: string;
  source: ManagedCapabilitySource;
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
    .insert(workspaceCapabilities)
    .values({
      workspaceId: input.workspaceId,
      source: input.source,
      enabled: input.enabled,
      updatedByWorkosId: input.updatedByWorkosId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [workspaceCapabilities.workspaceId, workspaceCapabilities.source],
      set: {
        enabled: input.enabled,
        updatedByWorkosId: input.updatedByWorkosId,
        updatedAt: now,
      },
    })
    .returning({
      source: workspaceCapabilities.source,
      enabled: workspaceCapabilities.enabled,
    });
  if (!row) throw new Error("Could not update the workspace capability.");
  return row;
}

export type CreateCapabilityRunInput = {
  workspaceId: string;
  userWorkosId: string;
  chatSessionId: string;
  toolCallId?: string | null;
  source: ManagedCapabilitySource;
  action: string;
  inputHash: string;
  provider: string;
  endpoint: string;
  status: Extract<CapabilityRunStatus, "awaiting_approval" | "executing">;
  quoteProviderCostUsdMicros: number;
  quotePlatformFeeUsdMicros: number;
  quoteTotalCostUsdMicros: number;
  approvalExpiresAt?: Date | null;
  now?: Date;
  db?: DbLike;
};

export async function createCapabilityRun(input: CreateCapabilityRunInput) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const [row] = await db
    .insert(capabilityRuns)
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

async function expireCapabilityApproval(
  input: {
    id: string;
    userWorkosId: string;
    workspaceId: string;
    now: Date;
  },
  db: DbLike,
) {
  await db
    .update(capabilityRuns)
    .set({ status: "expired", updatedAt: input.now })
    .where(
      and(
        eq(capabilityRuns.id, input.id),
        eq(capabilityRuns.userWorkosId, input.userWorkosId),
        eq(capabilityRuns.workspaceId, input.workspaceId),
        inArray(capabilityRuns.status, ["awaiting_approval", "approved"]),
        lt(capabilityRuns.approvalExpiresAt, input.now),
      ),
    );
}

async function expireCapabilityApprovalsByToolCall(
  input: {
    toolCallId: string;
    chatSessionId?: string;
    userWorkosId: string;
    workspaceId: string;
    now: Date;
  },
  db: DbLike,
) {
  await db
    .update(capabilityRuns)
    .set({ status: "expired", updatedAt: input.now })
    .where(
      and(
        eq(capabilityRuns.toolCallId, input.toolCallId),
        input.chatSessionId ? eq(capabilityRuns.chatSessionId, input.chatSessionId) : undefined,
        eq(capabilityRuns.userWorkosId, input.userWorkosId),
        eq(capabilityRuns.workspaceId, input.workspaceId),
        inArray(capabilityRuns.status, ["awaiting_approval", "approved"]),
        lt(capabilityRuns.approvalExpiresAt, input.now),
      ),
    );
}

export async function getCapabilityApproval(input: {
  id: string;
  userWorkosId: string;
  workspaceId: string;
  now?: Date;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  await expireCapabilityApproval({ ...input, now }, db);
  const [row] = await db
    .select()
    .from(capabilityRuns)
    .where(
      and(
        eq(capabilityRuns.id, input.id),
        eq(capabilityRuns.userWorkosId, input.userWorkosId),
        eq(capabilityRuns.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function getCapabilityApprovalByToolCall(input: {
  toolCallId: string;
  chatSessionId?: string;
  userWorkosId: string;
  workspaceId: string;
  now?: Date;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  await expireCapabilityApprovalsByToolCall({ ...input, now }, db);
  const [row] = await db
    .select()
    .from(capabilityRuns)
    .where(
      and(
        eq(capabilityRuns.toolCallId, input.toolCallId),
        input.chatSessionId ? eq(capabilityRuns.chatSessionId, input.chatSessionId) : undefined,
        eq(capabilityRuns.userWorkosId, input.userWorkosId),
        eq(capabilityRuns.workspaceId, input.workspaceId),
      ),
    )
    .orderBy(desc(capabilityRuns.createdAt), desc(capabilityRuns.id))
    .limit(1);
  return row ?? null;
}

export async function approveCapabilityRunByToolCall(input: {
  toolCallId: string;
  chatSessionId: string;
  userWorkosId: string;
  workspaceId: string;
  now?: Date;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const current = await getCapabilityApprovalByToolCall({ ...input, now, db });
  if (!current) return null;
  const [approved] = await db
    .update(capabilityRuns)
    .set({ status: "approved", approvedAt: now, updatedAt: now })
    .where(
      and(
        eq(capabilityRuns.id, current.id),
        eq(capabilityRuns.status, "awaiting_approval"),
        sql`${capabilityRuns.approvalExpiresAt} > ${now.toISOString()}`,
      ),
    )
    .returning();
  return approved ?? getCapabilityApprovalByToolCall({ ...input, now, db });
}

export async function cancelCapabilityRunByToolCall(input: {
  toolCallId: string;
  chatSessionId: string;
  userWorkosId: string;
  workspaceId: string;
  now?: Date;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const current = await getCapabilityApprovalByToolCall({ ...input, now, db });
  if (!current) return null;
  const [canceled] = await db
    .update(capabilityRuns)
    .set({ status: "canceled", updatedAt: now })
    .where(
      and(
        eq(capabilityRuns.id, current.id),
        inArray(capabilityRuns.status, ["awaiting_approval", "approved"]),
      ),
    )
    .returning();
  return canceled ?? getCapabilityApprovalByToolCall({ ...input, now, db });
}

export async function consumeCapabilityApprovalByToolCall(input: {
  toolCallId: string;
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
  const current = await getCapabilityApprovalByToolCall({ ...input, now, db });
  if (!current) return null;
  const [row] = await db
    .update(capabilityRuns)
    .set({ status: "executing", consumedAt: now, updatedAt: now })
    .where(
      and(
        eq(capabilityRuns.id, current.id),
        eq(capabilityRuns.action, input.action),
        eq(capabilityRuns.inputHash, input.inputHash),
        eq(capabilityRuns.status, "approved"),
        sql`${capabilityRuns.approvalExpiresAt} > ${now.toISOString()}`,
        sql`${capabilityRuns.quoteTotalCostUsdMicros} >= ${input.quoteTotalCostUsdMicros}`,
      ),
    )
    .returning();
  return row ?? null;
}

export async function markCapabilityRunStarted(input: {
  id: string;
  monidRunId: string;
  async: boolean;
  now?: Date;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const [row] = await db
    .update(capabilityRuns)
    .set({
      monidRunId: input.monidRunId,
      status: input.async ? "running" : "executing",
      updatedAt: now,
    })
    .where(
      and(
        eq(capabilityRuns.id, input.id),
        inArray(capabilityRuns.status, ["executing", "running"]),
      ),
    )
    .returning();
  return row ?? null;
}

export async function markCapabilityRunStopping(input: { id: string; now?: Date; db?: DbLike }) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  await db
    .update(capabilityRuns)
    .set({ status: "stopping", updatedAt: now })
    .where(
      and(
        eq(capabilityRuns.id, input.id),
        inArray(capabilityRuns.status, ["executing", "running"]),
      ),
    );
}

export async function markCapabilityRunSettlementFailure(input: {
  id: string;
  errorCode: string;
  errorMessage: string;
  now?: Date;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  await db
    .update(capabilityRuns)
    .set({
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      updatedAt: now,
    })
    .where(
      and(
        eq(capabilityRuns.id, input.id),
        inArray(capabilityRuns.status, ["executing", "running", "stopping"]),
        sql`${capabilityRuns.settledAt} IS NULL`,
      ),
    );
}

export async function settleCapabilityRun(input: {
  id: string;
  status: Extract<CapabilityRunStatus, "succeeded" | "failed" | "stopped" | "timed_out">;
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
    .update(capabilityRuns)
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
    .where(and(eq(capabilityRuns.id, input.id), sql`${capabilityRuns.settledAt} IS NULL`))
    .returning();
  return row ?? null;
}

export async function listUnsettledCapabilityRuns(input: { limit?: number; db?: DbLike }) {
  const db = input.db ?? getDb();
  return db
    .select()
    .from(capabilityRuns)
    .where(
      and(
        inArray(capabilityRuns.status, ["executing", "running", "stopping"]),
        sql`${capabilityRuns.settledAt} IS NULL`,
        sql`${capabilityRuns.monidRunId} IS NOT NULL`,
      ),
    )
    .orderBy(asc(capabilityRuns.updatedAt), asc(capabilityRuns.id))
    .limit(Math.max(1, Math.min(input.limit ?? 100, 500)));
}

export async function expirePendingCapabilityApprovals(input: { now?: Date; db?: DbLike }) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const result = await db
    .update(capabilityRuns)
    .set({ status: "expired", updatedAt: now })
    .where(
      and(
        inArray(capabilityRuns.status, ["awaiting_approval", "approved"]),
        lt(capabilityRuns.approvalExpiresAt, now),
      ),
    )
    .returning({ id: capabilityRuns.id });
  return result.length;
}
