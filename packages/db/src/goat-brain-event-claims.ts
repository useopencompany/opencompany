import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "./client";
import { goatBrainSourceEventClaims } from "./goat-schema";

type DbLike = any;

export type GoatBrainClaimProvider = "slack" | "gmail" | "linear";

// Claims provider-native event identities for a brain. Inserts are
// ON CONFLICT DO NOTHING against the (brain, provider, event_key) unique
// index, so concurrent flushes of overlapping windows serialize there: the
// caller that claims at least one new event ingests the window; a caller whose
// events are all already claimed skips the brain entirely (no ingest job, no
// billing reservation).
export async function claimGoatBrainSourceEvents(input: {
  brainRef: string;
  sourceProvider: GoatBrainClaimProvider;
  eventKeys: string[];
  sourceItemId?: string;
  db?: DbLike;
}): Promise<{ claimedCount: number; claimedEventKeys: string[] }> {
  const keys = [...new Set(input.eventKeys.map((key) => key.trim()).filter(Boolean))];
  if (keys.length === 0) return { claimedCount: 0, claimedEventKeys: [] };
  const db = input.db ?? getDb();

  const inserted = await db
    .insert(goatBrainSourceEventClaims)
    .values(
      keys.map((key) => ({
        id: newGoatBrainSourceEventClaimId(),
        brainId: input.brainRef,
        sourceProvider: input.sourceProvider,
        eventKey: key,
        sourceItemId: input.sourceItemId ?? null,
      })),
    )
    .onConflictDoNothing({
      target: [
        goatBrainSourceEventClaims.brainId,
        goatBrainSourceEventClaims.sourceProvider,
        goatBrainSourceEventClaims.eventKey,
      ],
    })
    .returning({ eventKey: goatBrainSourceEventClaims.eventKey });

  return {
    claimedCount: inserted.length,
    claimedEventKeys: inserted.map((row: { eventKey: string }) => row.eventKey),
  };
}

// Attributes freshly inserted claims (source_item_id still NULL) for a window
// to the source item that carried them. Best-effort observability only — the
// dedup guarantee lives in the unique index, not in this linkage.
export async function attributeGoatBrainSourceEventClaims(input: {
  brainRef: string;
  sourceProvider: GoatBrainClaimProvider;
  eventKeys: string[];
  sourceItemId: string;
  db?: DbLike;
}): Promise<void> {
  const keys = [...new Set(input.eventKeys.map((key) => key.trim()).filter(Boolean))];
  if (keys.length === 0) return;
  const db = input.db ?? getDb();
  await db
    .update(goatBrainSourceEventClaims)
    .set({ sourceItemId: input.sourceItemId })
    .where(
      and(
        eq(goatBrainSourceEventClaims.brainId, input.brainRef),
        eq(goatBrainSourceEventClaims.sourceProvider, input.sourceProvider),
        isNull(goatBrainSourceEventClaims.sourceItemId),
        inArray(goatBrainSourceEventClaims.eventKey, keys),
      ),
    );
}

export function newGoatBrainSourceEventClaimId() {
  return `gbsec_${randomUUID().replace(/-/g, "")}`;
}
