import { and, eq, isNull, lt, or } from "drizzle-orm";
import { workspacePluginData } from "./product-schema";

type DbClient = any;

export type WorkspacePluginDataLease = {
  workspaceId: string;
  pluginName: string;
  blobPathname: string;
  checksum: string;
  sizeBytes: number;
  generation: number;
  leaseId: string;
  leaseOwner: string;
  leaseExpiresAt: Date;
};

const leaseSelection = {
  workspaceId: workspacePluginData.workspaceId,
  pluginName: workspacePluginData.pluginName,
  blobPathname: workspacePluginData.blobPathname,
  checksum: workspacePluginData.checksum,
  sizeBytes: workspacePluginData.sizeBytes,
  generation: workspacePluginData.generation,
  leaseId: workspacePluginData.leaseId,
  leaseOwner: workspacePluginData.leaseOwner,
  leaseExpiresAt: workspacePluginData.leaseExpiresAt,
} as const;

export async function getWorkspacePluginDataRecord(
  db: DbClient,
  input: { workspaceId: string; pluginName: string },
) {
  const [row] = await db
    .select(leaseSelection)
    .from(workspacePluginData)
    .where(
      and(
        eq(workspacePluginData.workspaceId, input.workspaceId),
        eq(workspacePluginData.pluginName, input.pluginName),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function acquireWorkspacePluginDataLease(
  db: DbClient,
  input: {
    workspaceId: string;
    pluginName: string;
    leaseId: string;
    leaseOwner: string;
    leaseTtlMs: number;
    now?: Date;
  },
): Promise<WorkspacePluginDataLease | null> {
  const now = input.now ?? new Date();
  const leaseExpiresAt = new Date(now.getTime() + input.leaseTtlMs);
  const [row] = await db
    .update(workspacePluginData)
    .set({
      leaseId: input.leaseId,
      leaseOwner: input.leaseOwner,
      leaseExpiresAt,
      updatedAt: now,
    })
    .where(
      and(
        eq(workspacePluginData.workspaceId, input.workspaceId),
        eq(workspacePluginData.pluginName, input.pluginName),
        or(
          isNull(workspacePluginData.leaseId),
          lt(workspacePluginData.leaseExpiresAt, now),
          eq(workspacePluginData.leaseOwner, input.leaseOwner),
        ),
      ),
    )
    .returning(leaseSelection);
  return asLease(row);
}

export async function initializeWorkspacePluginDataLease(
  db: DbClient,
  input: {
    workspaceId: string;
    pluginName: string;
    blobPathname: string;
    checksum: string;
    sizeBytes: number;
    leaseId: string;
    leaseOwner: string;
    leaseTtlMs: number;
    now?: Date;
  },
): Promise<WorkspacePluginDataLease | null> {
  const now = input.now ?? new Date();
  const leaseExpiresAt = new Date(now.getTime() + input.leaseTtlMs);
  const [row] = await db
    .insert(workspacePluginData)
    .values({
      workspaceId: input.workspaceId,
      pluginName: input.pluginName,
      blobPathname: input.blobPathname,
      checksum: input.checksum,
      sizeBytes: input.sizeBytes,
      generation: 0,
      leaseId: input.leaseId,
      leaseOwner: input.leaseOwner,
      leaseExpiresAt,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning(leaseSelection);
  return asLease(row);
}

export async function renewWorkspacePluginDataLease(
  db: DbClient,
  input: Pick<WorkspacePluginDataLease, "workspaceId" | "pluginName" | "leaseId" | "leaseOwner"> & {
    leaseTtlMs: number;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const [row] = await db
    .update(workspacePluginData)
    .set({ leaseExpiresAt: new Date(now.getTime() + input.leaseTtlMs), updatedAt: now })
    .where(leaseFence(input))
    .returning({ leaseId: workspacePluginData.leaseId });
  return Boolean(row);
}

export async function checkpointWorkspacePluginData(
  db: DbClient,
  input: Pick<WorkspacePluginDataLease, "workspaceId" | "pluginName" | "leaseId" | "leaseOwner"> & {
    expectedGeneration: number;
    blobPathname: string;
    checksum: string;
    sizeBytes: number;
    releaseLease: boolean;
    leaseTtlMs: number;
    now?: Date;
  },
): Promise<WorkspacePluginDataLease | null> {
  const now = input.now ?? new Date();
  const nextLeaseExpiry = new Date(now.getTime() + input.leaseTtlMs);
  const [row] = await db
    .update(workspacePluginData)
    .set({
      blobPathname: input.blobPathname,
      checksum: input.checksum,
      sizeBytes: input.sizeBytes,
      generation: input.expectedGeneration + 1,
      leaseId: input.releaseLease ? null : input.leaseId,
      leaseOwner: input.releaseLease ? null : input.leaseOwner,
      leaseExpiresAt: input.releaseLease ? null : nextLeaseExpiry,
      updatedAt: now,
    })
    .where(and(leaseFence(input), eq(workspacePluginData.generation, input.expectedGeneration)))
    .returning(leaseSelection);
  if (!row) return null;
  return {
    ...row,
    leaseId: input.releaseLease ? input.leaseId : row.leaseId!,
    leaseOwner: input.releaseLease ? input.leaseOwner : row.leaseOwner!,
    leaseExpiresAt: input.releaseLease ? now : row.leaseExpiresAt!,
  };
}

export async function releaseWorkspacePluginDataLease(
  db: DbClient,
  input: Pick<WorkspacePluginDataLease, "workspaceId" | "pluginName" | "leaseId" | "leaseOwner">,
) {
  const [row] = await db
    .update(workspacePluginData)
    .set({ leaseId: null, leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date() })
    .where(leaseFence(input))
    .returning({ pluginName: workspacePluginData.pluginName });
  return Boolean(row);
}

function leaseFence(
  input: Pick<WorkspacePluginDataLease, "workspaceId" | "pluginName" | "leaseId" | "leaseOwner">,
) {
  return and(
    eq(workspacePluginData.workspaceId, input.workspaceId),
    eq(workspacePluginData.pluginName, input.pluginName),
    eq(workspacePluginData.leaseId, input.leaseId),
    eq(workspacePluginData.leaseOwner, input.leaseOwner),
  );
}

function asLease(row: Record<string, unknown> | undefined): WorkspacePluginDataLease | null {
  if (!row || !row.leaseId || !row.leaseOwner || !row.leaseExpiresAt) return null;
  return row as WorkspacePluginDataLease;
}
