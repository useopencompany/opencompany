import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import { NeonHttpDatabase } from "drizzle-orm/neon-http";
import type { NormalizedBrainSourceItem } from "../../goat-brain/src/index";
import { getDb } from "./client";
import { reserveGoatWorkspaceIngestion } from "./goat-billing";
import {
  type GoatBrainIngestJobKind,
  type GoatBrainIngestJobStatus,
  goatBrainIngestJobs,
  goatBrainSourceItems,
  goatBrains,
} from "./goat-schema";

type DbLike = any;
type PersistedGoatBrainIngestJob = {
  id: string;
  brainRef: string | null;
  status: GoatBrainIngestJobStatus;
  completedAt: Date | null;
  lastError: string | null;
};

export const GOAT_BRAIN_SOURCE_ITEM_INGEST_JOB_KIND: GoatBrainIngestJobKind =
  "brain_source_item_ingest";
export const GOAT_BRAIN_AGENT_INGEST_JOB_KIND: GoatBrainIngestJobKind = "brain_agent_ingest";

export type UpsertGoatBrainSourceItemResult = {
  sourceItemId: string;
  jobId: string | null;
  jobIds: string[];
  enqueued: boolean;
  skipped: boolean;
  paused?: boolean;
  pausedWorkspaceIds?: string[];
  quotaUpdates?: GoatIngestionQuotaUpdate[];
};

export type GoatIngestionQuotaUpdate = {
  workspaceId: string;
  plan: "free" | "pro";
  usedBefore: number;
  usedAfter: number;
  limit: number;
  pendingUnits: number;
  paused: boolean;
};

export async function upsertGoatBrainSourceItemAndEnqueue(input: {
  userWorkosId: string;
  sourceConnectionId: string;
  integrationId?: string | null;
  item: NormalizedBrainSourceItem;
  rawPayload: unknown;
  kind?: GoatBrainIngestJobKind;
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
}): Promise<UpsertGoatBrainSourceItemResult> {
  if (!input.db) {
    const db: DbLike = getDb();
    // The web app's getDb() is the neon-http driver, which has no interactive
    // transactions (one HTTPS request per query) and throws on db.transaction().
    // Run the mutation steps sequentially there; pooled callers (the runner) get
    // a real transaction. Mirrors runAtomically() in ./goat-brain-files.
    if (db instanceof NeonHttpDatabase) {
      return upsertGoatBrainSourceItemAndEnqueue({ ...input, db });
    }
    return db.transaction((tx: DbLike) =>
      upsertGoatBrainSourceItemAndEnqueue({
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
    .insert(goatBrainSourceItems)
    .values({
      id: newGoatBrainSourceItemId(),
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
        goatBrainSourceItems.userWorkosId,
        goatBrainSourceItems.sourceProvider,
        goatBrainSourceItems.sourceConnectionId,
        goatBrainSourceItems.sourceType,
        goatBrainSourceItems.externalId,
        goatBrainSourceItems.contentHash,
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
      id: goatBrainSourceItems.id,
    });

  if (!sourceItem) throw new Error("Could not persist Goat Brain source item.");

  const explicitBrainRefs = brainRefs.filter((brainRef): brainRef is string => brainRef !== null);
  const brainRows: Array<{ id: string; workspaceId: string }> =
    explicitBrainRefs.length === 0
      ? []
      : await db
          .select({ id: goatBrains.id, workspaceId: goatBrains.workspaceId })
          .from(goatBrains)
          .where(inArray(goatBrains.id, explicitBrainRefs));
  const workspaceByBrain = new Map(brainRows.map((row) => [row.id, row.workspaceId]));
  for (const brainRef of explicitBrainRefs) {
    if (!workspaceByBrain.has(brainRef)) {
      throw new Error(`Cannot enqueue Goat ingestion for missing brain ${brainRef}.`);
    }
  }

  // Dedup is enforced by partial unique indexes on (source_item_id, content_hash,
  // kind[, brain_ref]); the conflict target must stay unspecified so both apply.
  const jobs: PersistedGoatBrainIngestJob[] =
    brainRefs.length === 0
      ? []
      : await db
          .insert(goatBrainIngestJobs)
          .values(
            brainRefs.map((brainRef) => ({
              id: newGoatBrainIngestJobId(),
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
            id: goatBrainIngestJobs.id,
            brainRef: goatBrainIngestJobs.brainRef,
            status: goatBrainIngestJobs.status,
            completedAt: goatBrainIngestJobs.completedAt,
            lastError: goatBrainIngestJobs.lastError,
          });

  const workspaceIds = Array.from(new Set(brainRows.map((row) => row.workspaceId)));
  const reservations: Awaited<ReturnType<typeof reserveGoatWorkspaceIngestion>>[] = [];
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
        await reserveGoatWorkspaceIngestion({
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
      .update(goatBrainIngestJobs)
      .set({ planPaused: true, updatedAt: now })
      .where(
        and(
          eq(goatBrainIngestJobs.workspaceId, workspaceId),
          eq(goatBrainIngestJobs.sourceItemId, sourceItem.id),
          eq(goatBrainIngestJobs.status, "queued"),
        ),
      );
  }
  const quotaUpdates = reservations
    .filter((reservation) => reservation.created)
    .map((reservation) => ({
      workspaceId: reservation.reservation.workspaceId,
      plan: reservation.window.plan,
      usedBefore: reservation.consumedBefore,
      usedAfter: reservation.usedAfter,
      limit: reservation.window.limit,
      pendingUnits: reservation.pendingUnits,
      paused: reservation.paused,
    }));

  const persistedJobs = skipReason
    ? await transitionQueuedGoatBrainIngestJobsToSkipped({
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
      .update(goatBrainSourceItems)
      .set({
        lastIngestJobId: lastJob.id,
        lastIngestStatus: sourceItemStatusForJob(lastJob.status),
        lastIngestedAt: sourceItemIngestedAtForJob(lastJob, now),
        lastIngestError: sourceItemErrorForJob(lastJob, skipReason),
        updatedAt: now,
      })
      .where(eq(goatBrainSourceItems.id, sourceItem.id));
  } else if (skipReason) {
    await db
      .update(goatBrainSourceItems)
      .set({
        lastIngestJobId: null,
        lastIngestStatus: "skipped",
        lastIngestedAt: now,
        lastIngestError: skipReason,
        updatedAt: now,
      })
      .where(eq(goatBrainSourceItems.id, sourceItem.id));
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

async function transitionQueuedGoatBrainIngestJobsToSkipped(input: {
  db: DbLike;
  sourceItemId: string;
  contentHash: string;
  kind: GoatBrainIngestJobKind;
  brainRefs: (string | null)[];
  reason: string;
  now: Date;
}): Promise<PersistedGoatBrainIngestJob[]> {
  if (input.brainRefs.length === 0) return [];

  const targetWhere = goatBrainIngestJobTargetWhere({
    sourceItemId: input.sourceItemId,
    contentHash: input.contentHash,
    kind: input.kind,
    brainRefs: input.brainRefs,
  });
  const result = { skipped: true, reason: input.reason, summary: input.reason };

  await input.db
    .update(goatBrainIngestJobs)
    .set({
      status: "skipped",
      lastError: null,
      result,
      completedAt: input.now,
      updatedAt: input.now,
    })
    .where(and(targetWhere, eq(goatBrainIngestJobs.status, "queued")));

  const rows: PersistedGoatBrainIngestJob[] = await input.db
    .select({
      id: goatBrainIngestJobs.id,
      brainRef: goatBrainIngestJobs.brainRef,
      status: goatBrainIngestJobs.status,
      completedAt: goatBrainIngestJobs.completedAt,
      lastError: goatBrainIngestJobs.lastError,
    })
    .from(goatBrainIngestJobs)
    .where(targetWhere);

  return orderJobsByBrainRefs(rows, input.brainRefs);
}

function goatBrainIngestJobTargetWhere(input: {
  sourceItemId: string;
  contentHash: string;
  kind: GoatBrainIngestJobKind;
  brainRefs: (string | null)[];
}): SQL {
  const brainRefWhere = or(
    ...input.brainRefs.map((brainRef) =>
      brainRef === null
        ? isNull(goatBrainIngestJobs.brainRef)
        : eq(goatBrainIngestJobs.brainRef, brainRef),
    ),
  );
  if (!brainRefWhere) throw new Error("Cannot build Goat Brain ingest job target without brains.");

  const targetWhere = and(
    eq(goatBrainIngestJobs.sourceItemId, input.sourceItemId),
    eq(goatBrainIngestJobs.contentHash, input.contentHash),
    eq(goatBrainIngestJobs.kind, input.kind),
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

function orderJobsByBrainRefs(rows: PersistedGoatBrainIngestJob[], brainRefs: (string | null)[]) {
  return brainRefs
    .map((brainRef) => rows.find((row) => row.brainRef === brainRef))
    .filter((row): row is PersistedGoatBrainIngestJob => Boolean(row));
}

function sourceItemStatusForJob(status: GoatBrainIngestJobStatus) {
  if (status === "queued" || status === "running") return "pending";
  return status;
}

function sourceItemIngestedAtForJob(job: PersistedGoatBrainIngestJob, now: Date) {
  if (job.status === "queued" || job.status === "running") return null;
  return job.completedAt ?? now;
}

function sourceItemErrorForJob(job: PersistedGoatBrainIngestJob, skipReason: string | null) {
  if (job.status === "failed") return job.lastError;
  if (job.status === "skipped") return job.lastError ?? skipReason;
  return null;
}

export function newGoatBrainSourceItemId() {
  return `gbsrc_${randomUUID().replace(/-/g, "")}`;
}

export function newGoatBrainIngestJobId() {
  return `gbjob_${randomUUID().replace(/-/g, "")}`;
}
