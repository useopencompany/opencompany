import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "./client";
import { type ActiveWikiSourceProvider, wikiSourceEventClaims } from "./product-schema";

type DbLike = any;

// Claims provider-native event identities once for the workspace. Concurrent
// flushes serialize on the unique (workspace, provider, event_key) index.
export async function claimWikiSourceEvents(input: {
  workspaceId: string;
  sourceProvider: ActiveWikiSourceProvider;
  eventKeys: string[];
  sourceItemId?: string;
  db?: DbLike;
}): Promise<{ claimedCount: number; claimedEventKeys: string[] }> {
  const keys = [...new Set(input.eventKeys.map((key) => key.trim()).filter(Boolean))];
  if (keys.length === 0) return { claimedCount: 0, claimedEventKeys: [] };
  const db = input.db ?? getDb();

  const inserted = await db
    .insert(wikiSourceEventClaims)
    .values(
      keys.map((key) => ({
        id: newWikiSourceEventClaimId(),
        workspaceId: input.workspaceId,
        sourceProvider: input.sourceProvider,
        eventKey: key,
        sourceItemId: input.sourceItemId ?? null,
      })),
    )
    .onConflictDoNothing({
      target: [
        wikiSourceEventClaims.workspaceId,
        wikiSourceEventClaims.sourceProvider,
        wikiSourceEventClaims.eventKey,
      ],
    })
    .returning({ eventKey: wikiSourceEventClaims.eventKey });

  return {
    claimedCount: inserted.length,
    claimedEventKeys: inserted.map((row: { eventKey: string }) => row.eventKey),
  };
}

// Read-only claim lookup for pollers that would otherwise fetch an expensive
// provider payload (for example, a Granola transcript) after every updated_at
// bump. Claims are still inserted only after the payload fetch succeeds.
export async function listWikiSourceEventClaimedWorkspaceIds(input: {
  workspaceIds: readonly string[];
  sourceProvider: ActiveWikiSourceProvider;
  eventKey: string;
  db?: DbLike;
}): Promise<Set<string>> {
  if (input.workspaceIds.length === 0) return new Set();
  const db = input.db ?? getDb();
  const rows = await db
    .select({ workspaceId: wikiSourceEventClaims.workspaceId })
    .from(wikiSourceEventClaims)
    .where(
      and(
        inArray(wikiSourceEventClaims.workspaceId, [...input.workspaceIds]),
        eq(wikiSourceEventClaims.sourceProvider, input.sourceProvider),
        eq(wikiSourceEventClaims.eventKey, input.eventKey),
      ),
    );
  return new Set(rows.map((row: { workspaceId: string }) => row.workspaceId));
}

// Links freshly inserted claims to the source item that honored them. The
// unique workspace/provider/event key is the deduplication fence; this linkage
// is retained for ingestion observability.
export async function attributeWikiSourceEventClaims(input: {
  workspaceId: string;
  sourceProvider: ActiveWikiSourceProvider;
  eventKeys: string[];
  sourceItemId: string;
  db?: DbLike;
}): Promise<void> {
  const keys = [...new Set(input.eventKeys.map((key) => key.trim()).filter(Boolean))];
  if (keys.length === 0) return;
  const db = input.db ?? getDb();
  await db
    .update(wikiSourceEventClaims)
    .set({ sourceItemId: input.sourceItemId })
    .where(
      and(
        eq(wikiSourceEventClaims.workspaceId, input.workspaceId),
        eq(wikiSourceEventClaims.sourceProvider, input.sourceProvider),
        isNull(wikiSourceEventClaims.sourceItemId),
        inArray(wikiSourceEventClaims.eventKey, keys),
      ),
    );
}

export function newWikiSourceEventClaimId() {
  return `gwsec_${randomUUID().replace(/-/g, "")}`;
}
