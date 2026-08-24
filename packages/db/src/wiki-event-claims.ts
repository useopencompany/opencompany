import { randomUUID } from "node:crypto";
import { getDb } from "./client";
import { type WikiSourceProvider, wikiSourceEventClaims } from "./product-schema";

type DbLike = any;

// Claims provider-native event identities once for the workspace. Concurrent
// flushes serialize on the unique (workspace, provider, event_key) index.
export async function claimWikiSourceEvents(input: {
  workspaceId: string;
  sourceProvider: WikiSourceProvider;
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

export function newWikiSourceEventClaimId() {
  return `gwsec_${randomUUID().replace(/-/g, "")}`;
}
