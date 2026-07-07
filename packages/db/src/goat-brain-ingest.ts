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

export type UpsertGoatBrainSourceItemResult = {
  sourceItemId: string;
  jobId: string | null;
  enqueued: boolean;
};

export async function upsertGoatBrainSourceItemAndEnqueue(input: {
  userWorkosId: string;
  sourceConnectionId: string;
  integrationId?: string | null;
  item: NormalizedBrainSourceItem;
  rawPayload: unknown;
  now?: Date;
  db?: DbLike;
}): Promise<UpsertGoatBrainSourceItemResult> {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const occurredAt = new Date(input.item.occurredAt);
  const capturedAt = new Date(input.item.capturedAt);
  const integrationId = input.integrationId ?? null;

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

  const [job] = await db
    .insert(goatBrainIngestJobs)
    .values({
      id: newGoatBrainIngestJobId(),
      sourceItemId: sourceItem.id,
      userWorkosId: input.userWorkosId,
      sourceProvider: input.item.sourceProvider,
      sourceConnectionId: input.sourceConnectionId,
      integrationId,
      kind: GOAT_BRAIN_SOURCE_ITEM_INGEST_JOB_KIND,
      contentHash: input.item.contentHash,
      status: "queued",
      nextRunAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({
      target: [
        goatBrainIngestJobs.sourceItemId,
        goatBrainIngestJobs.contentHash,
        goatBrainIngestJobs.kind,
      ],
    })
    .returning({
      id: goatBrainIngestJobs.id,
    });

  if (job) {
    await db
      .update(goatBrainSourceItems)
      .set({
        lastIngestJobId: job.id,
        lastIngestStatus: "pending",
        lastIngestError: null,
        updatedAt: now,
      })
      .where(eq(goatBrainSourceItems.id, sourceItem.id));
  }

  return {
    sourceItemId: sourceItem.id,
    jobId: job?.id ?? null,
    enqueued: Boolean(job),
  };
}

export function newGoatBrainSourceItemId() {
  return `gbsrc_${randomUUID().replace(/-/g, "")}`;
}

export function newGoatBrainIngestJobId() {
  return `gbjob_${randomUUID().replace(/-/g, "")}`;
}
