import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import { NeonHttpDatabase } from "drizzle-orm/neon-http";
import {
  type BrainHydratablePointerProvider,
  isNormalizedBrainPointerSourceItem,
  isNormalizedChatCaptureSourceItem,
  type NormalizedBrainSourceItem,
} from "../../brain/src/index";
import { reserveWorkspaceIngestion } from "./billing";
import { getDb } from "./client";
import {
  type BrainIngestJobKind,
  type BrainIngestJobStatus,
  brainIngestJobs,
  brainSourceItems,
  brains,
} from "./schema";

type DbLike = any;
type PersistedBrainIngestJob = {
  id: string;
  brainRef: string | null;
  status: BrainIngestJobStatus;
  completedAt: Date | null;
  lastError: string | null;
};

export const GOAT_BRAIN_SOURCE_ITEM_INGEST_JOB_KIND: BrainIngestJobKind =
  "brain_source_item_ingest";
export const GOAT_BRAIN_AGENT_INGEST_JOB_KIND: BrainIngestJobKind = "brain_agent_ingest";
export const GOAT_BRAIN_POINTER_HYDRATE_JOB_KIND: BrainIngestJobKind = "brain_pointer_hydrate";

export type UpsertBrainSourceItemResult = {
  sourceItemId: string;
  jobId: string | null;
  jobIds: string[];
  enqueued: boolean;
  skipped: boolean;
  paused?: boolean;
  pausedWorkspaceIds?: string[];
  quotaUpdates?: IngestionQuotaUpdate[];
};

export type IngestionQuotaUpdate = {
  workspaceId: string;
  pendingUnits: number;
  paused: boolean;
};

export type ExistingBrainPointerIngest = {
  jobId: string;
  status: BrainIngestJobStatus;
  planPaused: boolean;
  draftBrainId: string;
  draftFolder: string;
  title: string;
};

export type ExistingBrainChatCaptureIngest = {
  jobId: string;
  status: BrainIngestJobStatus;
  planPaused: boolean;
  draftBrainId: string;
  draftFolder: string;
  title: string;
};

export async function findExistingBrainChatCaptureIngest(input: {
  userWorkosId: string;
  sourceConnectionId: string;
  externalId: string;
  brainRef: string;
  db?: DbLike;
}): Promise<ExistingBrainChatCaptureIngest | null> {
  const db = input.db ?? getDb();
  const [row] = await db
    .select({
      normalizedPayload: brainSourceItems.normalizedPayload,
      jobId: brainIngestJobs.id,
      status: brainIngestJobs.status,
      planPaused: brainIngestJobs.planPaused,
    })
    .from(brainSourceItems)
    .innerJoin(
      brainIngestJobs,
      and(
        eq(brainIngestJobs.sourceItemId, brainSourceItems.id),
        eq(brainIngestJobs.kind, GOAT_BRAIN_AGENT_INGEST_JOB_KIND),
        eq(brainIngestJobs.brainRef, input.brainRef),
      ),
    )
    .where(
      and(
        eq(brainSourceItems.userWorkosId, input.userWorkosId),
        eq(brainSourceItems.sourceProvider, "goat-chat"),
        eq(brainSourceItems.sourceConnectionId, input.sourceConnectionId),
        eq(brainSourceItems.sourceType, "capture"),
        eq(brainSourceItems.externalId, input.externalId),
      ),
    )
    .orderBy(desc(brainIngestJobs.createdAt))
    .limit(1);
  if (!row || !isNormalizedChatCaptureSourceItem(row.normalizedPayload)) return null;
  const capture = row.normalizedPayload.content.capture;
  return {
    jobId: row.jobId,
    status: row.status,
    planPaused: row.planPaused,
    draftBrainId: capture.draftBrainId,
    draftFolder: capture.draftFolder,
    title: row.normalizedPayload.title,
  };
}

export async function findExistingBrainPointerIngest(input: {
  userWorkosId: string;
  integrationId: string;
  provider: BrainHydratablePointerProvider;
  sourceRef: string;
  brainRef: string;
  db?: DbLike;
}): Promise<ExistingBrainPointerIngest | null> {
  const db = input.db ?? getDb();
  const [row] = await db
    .select({
      normalizedPayload: brainSourceItems.normalizedPayload,
      jobId: brainIngestJobs.id,
      status: brainIngestJobs.status,
      planPaused: brainIngestJobs.planPaused,
    })
    .from(brainSourceItems)
    .innerJoin(
      brainIngestJobs,
      and(
        eq(brainIngestJobs.sourceItemId, brainSourceItems.id),
        eq(brainIngestJobs.kind, GOAT_BRAIN_POINTER_HYDRATE_JOB_KIND),
        eq(brainIngestJobs.brainRef, input.brainRef),
      ),
    )
    .where(
      and(
        eq(brainSourceItems.userWorkosId, input.userWorkosId),
        eq(brainSourceItems.integrationId, input.integrationId),
        eq(brainSourceItems.sourceProvider, input.provider),
        eq(brainSourceItems.sourceType, "pointer"),
        eq(brainSourceItems.sourceRef, input.sourceRef),
      ),
    )
    .orderBy(desc(brainIngestJobs.createdAt))
    .limit(1);
  if (!row || !isNormalizedBrainPointerSourceItem(row.normalizedPayload)) return null;
  const pointer = row.normalizedPayload.content.pointer;
  return {
    jobId: row.jobId,
    status: row.status,
    planPaused: row.planPaused,
    draftBrainId: pointer.draftBrainId,
    draftFolder: pointer.draftFolder,
    title: row.normalizedPayload.title,
  };
}

export async function upsertBrainSourceItemAndEnqueue(input: {
  userWorkosId: string;
  sourceConnectionId: string;
  integrationId?: string | null;
  item: NormalizedBrainSourceItem;
  rawPayload: unknown;
  kind?: BrainIngestJobKind;
  importRunId?: string | null;
  brainRef?: string | null;
  // Target brains for fan-out; one ingest job per entry. Takes precedence over
  // `brainRef`. An empty array persists the source item without enqueuing.
  brainRefs?: (string | null)[];
  // Persist a terminal no-op decision without enqueueing runnable work. When
  // target brains are known, terminal skipped job rows are still created so
  // brain-scoped activity and audit trails can show the decision.
  skipReason?: string | null;
  rawEventCount?: number;
  // Optional provider-native event identities newly claimed per target brain.
  // Billing unions these keys per workspace so partially overlapping windows
  // consume only genuinely new events, while preserving one source item for
  // multi-brain fan-out.
  rawEventKeysByBrainRef?: ReadonlyMap<string, readonly string[]>;
  now?: Date;
  db?: DbLike;
}): Promise<UpsertBrainSourceItemResult> {
  if (!input.db) {
    const db: DbLike = getDb();
    // The web app's getDb() is the neon-http driver, which has no interactive
    // transactions (one HTTPS request per query) and throws on db.transaction().
    // Run the mutation steps sequentially there; pooled callers (the runner) get
    // a real transaction. Mirrors runAtomically() in ./brain-files.
    if (db instanceof NeonHttpDatabase) {
      return upsertBrainSourceItemAndEnqueue({ ...input, db });
    }
    return db.transaction((tx: DbLike) =>
      upsertBrainSourceItemAndEnqueue({
        ...input,
        db: tx,
      }),
    );
  }

  const db = input.db;
  const now = input.now ?? new Date();
  const kind = input.kind ?? GOAT_BRAIN_SOURCE_ITEM_INGEST_JOB_KIND;
  const occurredAt = new Date(input.item.occurredAt);
  const capturedAt = new Date(input.item.capturedAt);
  const integrationId = input.integrationId ?? null;
  const skipReason = input.skipReason?.trim() || null;
  const rawEventCount = input.rawEventCount ?? 1;
  if (!Number.isInteger(rawEventCount) || rawEventCount < 1 || rawEventCount > 200) {
    throw new Error("Goat ingestion raw event count must be between 1 and 200.");
  }
  const brainRefs = uniqueBrainRefs(input.brainRefs ?? [input.brainRef ?? null]);

  const [sourceItem] = await db
    .insert(brainSourceItems)
    .values({
      id: newBrainSourceItemId(),
      userWorkosId: input.userWorkosId,
      sourceProvider: input.item.sourceProvider,
      sourceConnectionId: input.sourceConnectionId,
      integrationId,
      sourceType: input.item.sourceType,
      externalId: input.item.externalId,
      sourceRef: input.item.sourceRef,
      title: input.item.title,
      occurredAt,
      capturedAt,
      contentHash: input.item.contentHash,
      rawPayload: input.rawPayload,
      normalizedPayload: input.item,
      rawEventCount,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        brainSourceItems.userWorkosId,
        brainSourceItems.sourceProvider,
        brainSourceItems.sourceConnectionId,
        brainSourceItems.sourceType,
        brainSourceItems.externalId,
        brainSourceItems.contentHash,
      ],
      set: {
        integrationId,
        sourceRef: input.item.sourceRef,
        title: input.item.title,
        occurredAt,
        capturedAt,
        contentHash: input.item.contentHash,
        rawPayload: input.rawPayload,
        normalizedPayload: input.item,
        rawEventCount,
        updatedAt: now,
      },
    })
    .returning({
      id: brainSourceItems.id,
    });

  if (!sourceItem) throw new Error("Could not persist Goat Brain source item.");

  const explicitBrainRefs = brainRefs.filter((brainRef): brainRef is string => brainRef !== null);
  const brainRows: Array<{ id: string; workspaceId: string }> =
    explicitBrainRefs.length === 0
      ? []
      : await db
          .select({ id: brains.id, workspaceId: brains.workspaceId })
          .from(brains)
          .where(inArray(brains.id, explicitBrainRefs));
  const workspaceByBrain = new Map(brainRows.map((row) => [row.id, row.workspaceId]));
  for (const brainRef of explicitBrainRefs) {
    if (!workspaceByBrain.has(brainRef)) {
      throw new Error(`Cannot enqueue Goat ingestion for missing brain ${brainRef}.`);
    }
  }

  // Dedup is enforced by partial unique indexes on (source_item_id, content_hash,
  // kind[, brain_ref]); the conflict target must stay unspecified so both apply.
  const jobs: PersistedBrainIngestJob[] =
    brainRefs.length === 0
      ? []
      : await db
          .insert(brainIngestJobs)
          .values(
            brainRefs.map((brainRef) => ({
              id: newBrainIngestJobId(),
              sourceItemId: sourceItem.id,
              userWorkosId: input.userWorkosId,
              sourceProvider: input.item.sourceProvider,
              sourceConnectionId: input.sourceConnectionId,
              integrationId,
              workspaceId: brainRef ? (workspaceByBrain.get(brainRef) ?? null) : null,
              importRunId: input.importRunId ?? null,
              brainRef,
              kind,
              contentHash: input.item.contentHash,
              status: skipReason ? ("skipped" as const) : ("queued" as const),
              nextRunAt: now,
              ...(skipReason
                ? {
                    result: {
                      skipped: true,
                      reason: skipReason,
                      summary: skipReason,
                    },
                    completedAt: now,
                  }
                : {}),
              updatedAt: now,
            })),
          )
          .onConflictDoNothing()
          .returning({
            id: brainIngestJobs.id,
            brainRef: brainIngestJobs.brainRef,
            status: brainIngestJobs.status,
            completedAt: brainIngestJobs.completedAt,
            lastError: brainIngestJobs.lastError,
          });

  const workspaceIds = Array.from(new Set(brainRows.map((row) => row.workspaceId)));
  const reservations: Awaited<ReturnType<typeof reserveWorkspaceIngestion>>[] = [];
  if (!skipReason) {
    // A caller-provided db is often a live transaction. Keep its statements
    // sequential; Neon transactions do not support concurrent queries on the
    // same connection.
    for (const workspaceId of workspaceIds) {
      const workspaceRawEventCount = input.rawEventKeysByBrainRef
        ? rawEventCountForWorkspace({
            workspaceId,
            brainRows,
            rawEventKeysByBrainRef: input.rawEventKeysByBrainRef,
          })
        : rawEventCount;
      reservations.push(
        await reserveWorkspaceIngestion({
          workspaceId,
          sourceItemId: sourceItem.id,
          sourceProvider: input.item.sourceProvider,
          rawEventCount: workspaceRawEventCount,
          now,
          db,
        }),
      );
    }
  }
  const pausedWorkspaceIds = reservations
    .filter((reservation) => reservation.paused)
    .map((reservation) => reservation.reservation.workspaceId);
  for (const workspaceId of pausedWorkspaceIds) {
    await db
      .update(brainIngestJobs)
      .set({ planPaused: true, updatedAt: now })
      .where(
        and(
          eq(brainIngestJobs.workspaceId, workspaceId),
          eq(brainIngestJobs.sourceItemId, sourceItem.id),
          eq(brainIngestJobs.status, "queued"),
        ),
      );
  }
  const quotaUpdates = reservations
    .filter((reservation) => reservation.created)
    .map((reservation) => ({
      workspaceId: reservation.reservation.workspaceId,
      pendingUnits: reservation.pendingUnits,
      paused: reservation.paused,
    }));

  const persistedJobs = skipReason
    ? await transitionQueuedBrainIngestJobsToSkipped({
        db,
        sourceItemId: sourceItem.id,
        contentHash: input.item.contentHash,
        kind,
        brainRefs,
        reason: skipReason,
        now,
      })
    : jobs;

  const lastJob = persistedJobs.at(-1) ?? null;
  if (lastJob) {
    await db
      .update(brainSourceItems)
      .set({
        lastIngestJobId: lastJob.id,
        lastIngestStatus: sourceItemStatusForJob(lastJob.status),
        lastIngestedAt: sourceItemIngestedAtForJob(lastJob, now),
        lastIngestError: sourceItemErrorForJob(lastJob, skipReason),
        updatedAt: now,
      })
      .where(eq(brainSourceItems.id, sourceItem.id));
  } else if (skipReason) {
    await db
      .update(brainSourceItems)
      .set({
        lastIngestJobId: null,
        lastIngestStatus: "skipped",
        lastIngestedAt: now,
        lastIngestError: skipReason,
        updatedAt: now,
      })
      .where(eq(brainSourceItems.id, sourceItem.id));
  }

  return {
    sourceItemId: sourceItem.id,
    jobId: lastJob?.id ?? null,
    jobIds: persistedJobs.map((job) => job.id),
    enqueued: jobs.length > 0 && !skipReason,
    skipped:
      Boolean(skipReason) &&
      (persistedJobs.length === 0 || persistedJobs.every((job) => job.status === "skipped")),
    ...(pausedWorkspaceIds.length > 0 ? { paused: true, pausedWorkspaceIds } : {}),
    ...(quotaUpdates.length > 0 ? { quotaUpdates } : {}),
  };
}

async function transitionQueuedBrainIngestJobsToSkipped(input: {
  db: DbLike;
  sourceItemId: string;
  contentHash: string;
  kind: BrainIngestJobKind;
  brainRefs: (string | null)[];
  reason: string;
  now: Date;
}): Promise<PersistedBrainIngestJob[]> {
  if (input.brainRefs.length === 0) return [];

  const targetWhere = brainIngestJobTargetWhere({
    sourceItemId: input.sourceItemId,
    contentHash: input.contentHash,
    kind: input.kind,
    brainRefs: input.brainRefs,
  });
  const result = { skipped: true, reason: input.reason, summary: input.reason };

  await input.db
    .update(brainIngestJobs)
    .set({
      status: "skipped",
      lastError: null,
      result,
      completedAt: input.now,
      updatedAt: input.now,
    })
    .where(and(targetWhere, eq(brainIngestJobs.status, "queued")));

  const rows: PersistedBrainIngestJob[] = await input.db
    .select({
      id: brainIngestJobs.id,
      brainRef: brainIngestJobs.brainRef,
      status: brainIngestJobs.status,
      completedAt: brainIngestJobs.completedAt,
      lastError: brainIngestJobs.lastError,
    })
    .from(brainIngestJobs)
    .where(targetWhere);

  return orderJobsByBrainRefs(rows, input.brainRefs);
}

function brainIngestJobTargetWhere(input: {
  sourceItemId: string;
  contentHash: string;
  kind: BrainIngestJobKind;
  brainRefs: (string | null)[];
}): SQL {
  const brainRefWhere = or(
    ...input.brainRefs.map((brainRef) =>
      brainRef === null ? isNull(brainIngestJobs.brainRef) : eq(brainIngestJobs.brainRef, brainRef),
    ),
  );
  if (!brainRefWhere) throw new Error("Cannot build Goat Brain ingest job target without brains.");

  const targetWhere = and(
    eq(brainIngestJobs.sourceItemId, input.sourceItemId),
    eq(brainIngestJobs.contentHash, input.contentHash),
    eq(brainIngestJobs.kind, input.kind),
    brainRefWhere,
  );
  if (!targetWhere) throw new Error("Cannot build Goat Brain ingest job target.");
  return targetWhere;
}

function uniqueBrainRefs(brainRefs: (string | null)[]) {
  const seen = new Set<string>();
  const unique: (string | null)[] = [];
  for (const brainRef of brainRefs) {
    const key = brainRef ?? "<default>";
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(brainRef);
  }
  return unique;
}

function rawEventCountForWorkspace(input: {
  workspaceId: string;
  brainRows: Array<{ id: string; workspaceId: string }>;
  rawEventKeysByBrainRef: ReadonlyMap<string, readonly string[]>;
}) {
  const keys = new Set<string>();
  for (const brain of input.brainRows) {
    if (brain.workspaceId !== input.workspaceId) continue;
    const brainKeys = input.rawEventKeysByBrainRef.get(brain.id);
    if (!brainKeys) {
      throw new Error(`Missing claimed event keys for Goat Brain ${brain.id}.`);
    }
    for (const key of brainKeys) {
      const normalized = key.trim();
      if (normalized) keys.add(normalized);
    }
  }
  if (keys.size < 1 || keys.size > 200) {
    throw new Error("Goat ingestion workspace event count must be between 1 and 200.");
  }
  return keys.size;
}

function orderJobsByBrainRefs(rows: PersistedBrainIngestJob[], brainRefs: (string | null)[]) {
  return brainRefs
    .map((brainRef) => rows.find((row) => row.brainRef === brainRef))
    .filter((row): row is PersistedBrainIngestJob => Boolean(row));
}

function sourceItemStatusForJob(status: BrainIngestJobStatus) {
  if (status === "queued" || status === "running") return "pending";
  return status;
}

function sourceItemIngestedAtForJob(job: PersistedBrainIngestJob, now: Date) {
  if (job.status === "queued" || job.status === "running") return null;
  return job.completedAt ?? now;
}

function sourceItemErrorForJob(job: PersistedBrainIngestJob, skipReason: string | null) {
  if (job.status === "failed") return job.lastError;
  if (job.status === "skipped") return job.lastError ?? skipReason;
  return null;
}

export function newBrainSourceItemId() {
  return `gbsrc_${randomUUID().replace(/-/g, "")}`;
}

export function newBrainIngestJobId() {
  return `gbjob_${randomUUID().replace(/-/g, "")}`;
}
