import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "./client";
import { brainSourceEventClaims } from "./product-schema";

type DbLike = any;

export type BrainClaimProvider =
  | "gmail"
  | "linear"
  | "github"
  | "hubspot"
  | "granola"
  | "fathom"
  | "attio";

// Claims provider-native event identities for a brain. Inserts are
// ON CONFLICT DO NOTHING against the (brain, provider, event_key) unique
// index, so concurrent flushes of overlapping windows serialize there: the
// caller that claims at least one new event ingests the window; a caller whose
// events are all already claimed skips the brain entirely (no ingest job, no
// billing reservation).
export async function claimBrainSourceEvents(input: {
  brainRef: string;
  sourceProvider: BrainClaimProvider;
  eventKeys: string[];
  sourceItemId?: string;
  db?: DbLike;
}): Promise<{ claimedCount: number; claimedEventKeys: string[] }> {
  const keys = [...new Set(input.eventKeys.map((key) => key.trim()).filter(Boolean))];
  if (keys.length === 0) return { claimedCount: 0, claimedEventKeys: [] };
  const db = input.db ?? getDb();

  const inserted = await db
    .insert(brainSourceEventClaims)
    .values(
      keys.map((key) => ({
        id: newBrainSourceEventClaimId(),
        brainId: input.brainRef,
        sourceProvider: input.sourceProvider,
        eventKey: key,
        sourceItemId: input.sourceItemId ?? null,
      })),
    )
    .onConflictDoNothing({
      target: [
        brainSourceEventClaims.brainId,
        brainSourceEventClaims.sourceProvider,
        brainSourceEventClaims.eventKey,
      ],
    })
    .returning({ eventKey: brainSourceEventClaims.eventKey });

  return {
    claimedCount: inserted.length,
    claimedEventKeys: inserted.map((row: { eventKey: string }) => row.eventKey),
  };
}

// Attributes freshly inserted claims (source_item_id still NULL) for a window
// to the source item that carried them. Best-effort observability only — the
// dedup guarantee lives in the unique index, not in this linkage.
export async function attributeBrainSourceEventClaims(input: {
  brainRef: string;
  sourceProvider: BrainClaimProvider;
  eventKeys: string[];
  sourceItemId: string;
  db?: DbLike;
}): Promise<void> {
  const keys = [...new Set(input.eventKeys.map((key) => key.trim()).filter(Boolean))];
  if (keys.length === 0) return;
  const db = input.db ?? getDb();
  await db
    .update(brainSourceEventClaims)
    .set({ sourceItemId: input.sourceItemId })
    .where(
      and(
        eq(brainSourceEventClaims.brainId, input.brainRef),
        eq(brainSourceEventClaims.sourceProvider, input.sourceProvider),
        isNull(brainSourceEventClaims.sourceItemId),
        inArray(brainSourceEventClaims.eventKey, keys),
      ),
    );
}

// Read-only claim lookup: which of these brains already ingested this event.
// Lets a poller skip fetching expensive payloads (e.g. Granola transcripts)
// for notes every routed brain has seen, without writing a claim it might not
// be able to honor if the payload fetch fails.
export async function listBrainSourceEventClaimedBrainRefs(input: {
  brainRefs: readonly string[];
  sourceProvider: BrainClaimProvider;
  eventKey: string;
  db?: DbLike;
}): Promise<Set<string>> {
  if (input.brainRefs.length === 0) return new Set();
  const db = input.db ?? getDb();
  const rows = await db
    .select({ brainId: brainSourceEventClaims.brainId })
    .from(brainSourceEventClaims)
    .where(
      and(
        inArray(brainSourceEventClaims.brainId, [...input.brainRefs]),
        eq(brainSourceEventClaims.sourceProvider, input.sourceProvider),
        eq(brainSourceEventClaims.eventKey, input.eventKey),
      ),
    );
  return new Set(rows.map((row: { brainId: string }) => row.brainId));
}

export function newBrainSourceEventClaimId() {
  return `gbsec_${randomUUID().replace(/-/g, "")}`;
}
