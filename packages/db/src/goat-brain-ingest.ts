import { randomUUID } from "node:crypto";
import { and, eq, isNull, or, type SQL } from "drizzle-orm";
import type { NormalizedBrainSourceItem } from "../../goat-brain/src/index";
import { getDb } from "./client";
import {
  type GoatBrainIngestJobKind,
  type GoatBrainIngestJobStatus,
  goatBrainIngestJobs,
  goatBrainSourceItems,
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
};

export async function upsertGoatBrainSourceItemAndEnqueue(input: {
  userWorkosId: string;
  sourceConnectionId: string;
  integrationId?: string | null;
  item: NormalizedBrainSourceItem;
  rawPayload: unknown;
  kind?: GoatBrainIngestJobKind;
  brainRef?: string | null;
  // Target brains for fan-out; one ingest job per entry. Takes precedence over
  // `brainRef`. An empty array persists the source item without enqueuing.
  brainRefs?: (string | null)[];
  // Persist a terminal no-op decision without enqueueing runnable work. When
  // target brains are known, terminal skipped job rows are still created so
  // brain-scoped activity and audit trails can show the decision.
  skipReason?: string | null;
  now?: Date;
  db?: DbLike;
}): Promise<UpsertGoatBrainSourceItemResult> {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const kind = input.kind ?? GOAT_BRAIN_SOURCE_ITEM_INGEST_JOB_KIND;
  const occurredAt = new Date(input.item.occurredAt);
  const capturedAt = new Date(input.item.capturedAt);
  const integrationId = input.integrationId ?? null;
  const skipReason = input.skipReason?.trim() || null;
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
        updatedAt: now,
      },
    })
    .returning({
      id: goatBrainSourceItems.id,
    });

  if (!sourceItem) throw new Error("Could not persist Goat Brain source item.");

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
              brainRef,
              kind,
              contentHash: input.item.contentHash,
              status: skipReason ? ("skipped" as const) : ("queued" as const),
              nextRunAt: now,
              ...(skipReason
                ? {
                    result: { skipped: true, reason: skipReason, summary: skipReason },
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
