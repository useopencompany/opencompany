import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { NormalizedBrainSourceItem } from "../../goat-brain/src/index";
import { getDb } from "./client";
import {
  type GoatBrainIngestJobKind,
  goatBrainIngestJobs,
  goatBrainSourceItems,
} from "./goat-schema";

type DbLike = any;

export const GOAT_BRAIN_SOURCE_ITEM_INGEST_JOB_KIND: GoatBrainIngestJobKind =
  "brain_source_item_ingest";
export const GOAT_BRAIN_AGENT_INGEST_JOB_KIND: GoatBrainIngestJobKind = "brain_agent_ingest";

export type UpsertGoatBrainSourceItemResult = {
  sourceItemId: string;
  jobId: string | null;
  jobIds: string[];
  enqueued: boolean;
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
  now?: Date;
  db?: DbLike;
}): Promise<UpsertGoatBrainSourceItemResult> {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const kind = input.kind ?? GOAT_BRAIN_SOURCE_ITEM_INGEST_JOB_KIND;
  const occurredAt = new Date(input.item.occurredAt);
  const capturedAt = new Date(input.item.capturedAt);
  const integrationId = input.integrationId ?? null;
  const brainRefs = input.brainRefs ?? [input.brainRef ?? null];

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
  const jobs: { id: string }[] =
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
              status: "queued" as const,
              nextRunAt: now,
              updatedAt: now,
            })),
          )
          .onConflictDoNothing()
          .returning({
            id: goatBrainIngestJobs.id,
          });

  const lastJob = jobs.at(-1) ?? null;
  if (lastJob) {
    await db
      .update(goatBrainSourceItems)
      .set({
        lastIngestJobId: lastJob.id,
        lastIngestStatus: "pending",
        lastIngestError: null,
        updatedAt: now,
      })
      .where(eq(goatBrainSourceItems.id, sourceItem.id));
  }

  return {
    sourceItemId: sourceItem.id,
    jobId: lastJob?.id ?? null,
    jobIds: jobs.map((job) => job.id),
    enqueued: jobs.length > 0,
  };
}

export function newGoatBrainSourceItemId() {
  return `gbsrc_${randomUUID().replace(/-/g, "")}`;
}

export function newGoatBrainIngestJobId() {
  return `gbjob_${randomUUID().replace(/-/g, "")}`;
}
