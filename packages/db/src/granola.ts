import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { getDb } from "./client";
import { brainSources, granolaSyncState } from "./schema";

type DbLike = any;

export const GOAT_GRANOLA_PROVIDER = "granola" as const;
export const GOAT_GRANOLA_CREDENTIAL_KIND = "api_key" as const;

export type GranolaBrainSourceRoute = {
  integrationId: string;
  brainRef: string;
};

export type GranolaSyncStateRow = {
  integrationId: string;
  userWorkosId: string;
  updatedAfterCursor: Date | null;
  pageCursor: string | null;
  pendingUpdatedAfterCursor: Date | null;
};

export async function listEnabledGranolaBrainSourceRoutes(
  integrationIds: readonly string[],
  db: DbLike = getDb(),
): Promise<GranolaBrainSourceRoute[]> {
  if (integrationIds.length === 0) return [];
  const rows = await db
    .select({
      integrationId: brainSources.integrationId,
      brainRef: brainSources.brainId,
    })
    .from(brainSources)
    .where(
      and(
        eq(brainSources.provider, GOAT_GRANOLA_PROVIDER),
        eq(brainSources.enabled, true),
        inArray(brainSources.integrationId, [...integrationIds]),
      ),
    );
  return rows;
}

export async function ensureGranolaSyncState(
  input: { integrationId: string; userWorkosId: string },
  db: DbLike = getDb(),
): Promise<void> {
  await db
    .insert(granolaSyncState)
    .values({ integrationId: input.integrationId, userWorkosId: input.userWorkosId })
    .onConflictDoNothing();
}

// Claims one integration's poll slot: stamps last_polled_at only when the row
// hasn't been polled within the cooldown, so concurrent runner replicas skip
// each other. Returns the cursor on success, null when another replica holds
// the slot.
export async function claimGranolaSyncState(
  input: { integrationId: string; cooldownMs: number },
  db: DbLike = getDb(),
): Promise<GranolaSyncStateRow | null> {
  const cooldownSeconds = Math.max(1, Math.floor(input.cooldownMs / 1000));
  const rows = await db
    .update(granolaSyncState)
    .set({ lastPolledAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        eq(granolaSyncState.integrationId, input.integrationId),
        or(
          isNull(granolaSyncState.lastPolledAt),
          lt(granolaSyncState.lastPolledAt, sql`now() - make_interval(secs => ${cooldownSeconds})`),
        ),
      ),
    )
    .returning({
      integrationId: granolaSyncState.integrationId,
      userWorkosId: granolaSyncState.userWorkosId,
      updatedAfterCursor: granolaSyncState.updatedAfterCursor,
      pageCursor: granolaSyncState.pageCursor,
      pendingUpdatedAfterCursor: granolaSyncState.pendingUpdatedAfterCursor,
    });
  return rows[0] ?? null;
}

export async function updateGranolaSyncPage(
  input: {
    integrationId: string;
    expectedUpdatedAfterCursor: Date;
    expectedPageCursor: string | null;
    pageCursor: string;
    pendingUpdatedAfterCursor: Date | null;
  },
  db: DbLike = getDb(),
): Promise<boolean> {
  const rows = await db
    .update(granolaSyncState)
    .set({
      pageCursor: input.pageCursor,
      pendingUpdatedAfterCursor: input.pendingUpdatedAfterCursor,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(granolaSyncState.integrationId, input.integrationId),
        eq(granolaSyncState.updatedAfterCursor, input.expectedUpdatedAfterCursor),
        input.expectedPageCursor
          ? eq(granolaSyncState.pageCursor, input.expectedPageCursor)
          : isNull(granolaSyncState.pageCursor),
      ),
    )
    .returning({ integrationId: granolaSyncState.integrationId });
  return rows.length > 0;
}

export async function completeGranolaSyncPages(
  input: {
    integrationId: string;
    expectedUpdatedAfterCursor: Date;
    expectedPageCursor: string | null;
    updatedAfterCursor: Date;
  },
  db: DbLike = getDb(),
): Promise<boolean> {
  const rows = await db
    .update(granolaSyncState)
    .set({
      updatedAfterCursor: input.updatedAfterCursor,
      pageCursor: null,
      pendingUpdatedAfterCursor: null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(granolaSyncState.integrationId, input.integrationId),
        eq(granolaSyncState.updatedAfterCursor, input.expectedUpdatedAfterCursor),
        input.expectedPageCursor
          ? eq(granolaSyncState.pageCursor, input.expectedPageCursor)
          : isNull(granolaSyncState.pageCursor),
      ),
    )
    .returning({ integrationId: granolaSyncState.integrationId });
  return rows.length > 0;
}

export async function updateGranolaSyncCursor(
  input: { integrationId: string; updatedAfterCursor: Date },
  db: DbLike = getDb(),
): Promise<void> {
  await db
    .update(granolaSyncState)
    .set({
      updatedAfterCursor: input.updatedAfterCursor,
      pageCursor: null,
      pendingUpdatedAfterCursor: null,
      updatedAt: sql`now()`,
    })
    .where(eq(granolaSyncState.integrationId, input.integrationId));
}

// Cross-member dedup key for one Granola note. Note ids are stable per note,
// so two members whose keys can both read a shared note converge on one claim
// per brain.
export function granolaEventClaimKey(noteId: string): string {
  return `note:${noteId}`;
}
