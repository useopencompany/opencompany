import { getDb } from "@opencompany/db/client";
import { brainIngestJobs, brainSourceItems } from "@opencompany/db/schema";
import { getBrainAccess } from "@opencompany/db/workspaces";
import { and, eq, inArray } from "drizzle-orm";
import { currentUser } from "@/lib/auth";
import type { BrainSourceItemRow } from "@/lib/task-collections";

export const runtime = "nodejs";

const MAX_SOURCE_ITEM_IDS = 100;

export async function GET(request: Request): Promise<Response> {
  const context = await currentUser({ optional: true });
  if (!context) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const brainRef = url.searchParams.get("brain_ref")?.trim();
  if (!brainRef) return Response.json({ error: "`brain_ref` is required." }, { status: 400 });

  const sourceItemIds = readSourceItemIds(url.searchParams.get("source_item_ids"));
  if (sourceItemIds.length === 0) return Response.json({ sourceItems: [] });

  const access = await getBrainAccess({
    userWorkosId: context.user.workosUserId,
    brainRef,
  });
  if (!access) return Response.json({ error: "Not found." }, { status: 404 });

  const rows = await getDb()
    .select({
      id: brainSourceItems.id,
      userWorkosId: brainSourceItems.userWorkosId,
      sourceProvider: brainSourceItems.sourceProvider,
      sourceType: brainSourceItems.sourceType,
      externalId: brainSourceItems.externalId,
      title: brainSourceItems.title,
      occurredAt: brainSourceItems.occurredAt,
      capturedAt: brainSourceItems.capturedAt,
      contentHash: brainSourceItems.contentHash,
      lastIngestJobId: brainSourceItems.lastIngestJobId,
      lastIngestStatus: brainSourceItems.lastIngestStatus,
      lastIngestError: brainSourceItems.lastIngestError,
      lastIngestedAt: brainSourceItems.lastIngestedAt,
      createdAt: brainSourceItems.createdAt,
      updatedAt: brainSourceItems.updatedAt,
    })
    .from(brainSourceItems)
    .innerJoin(brainIngestJobs, eq(brainIngestJobs.sourceItemId, brainSourceItems.id))
    .where(
      and(eq(brainIngestJobs.brainRef, brainRef), inArray(brainSourceItems.id, sourceItemIds)),
    );

  const sourceItemsById = new Map<string, BrainSourceItemRow>();
  for (const row of rows) {
    sourceItemsById.set(row.id, {
      id: row.id,
      user_workos_id: row.userWorkosId,
      source_provider: row.sourceProvider,
      source_type: row.sourceType,
      external_id: row.externalId,
      title: row.title,
      occurred_at: toIsoString(row.occurredAt),
      captured_at: toIsoString(row.capturedAt),
      content_hash: row.contentHash,
      last_ingest_job_id: row.lastIngestJobId,
      last_ingest_status: row.lastIngestStatus,
      last_ingest_error: row.lastIngestError,
      last_ingested_at: row.lastIngestedAt ? toIsoString(row.lastIngestedAt) : null,
      created_at: toIsoString(row.createdAt),
      updated_at: toIsoString(row.updatedAt),
    });
  }

  return Response.json({ sourceItems: Array.from(sourceItemsById.values()) });
}

function readSourceItemIds(value: string | null): string[] {
  if (!value) return [];
  return Array.from(
    new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ).slice(0, MAX_SOURCE_ITEM_IDS);
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
