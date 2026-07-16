import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { getDb } from "./client";
import { goatBrainSources, goatFathomSyncState } from "./goat-schema";

type DbLike = any;

export const GOAT_FATHOM_PROVIDER = "fathom" as const;
export const GOAT_FATHOM_CREDENTIAL_KIND = "api_key" as const;

export type GoatFathomBrainSourceRoute = {
  integrationId: string;
  brainRef: string;
};

export type GoatFathomSyncStateRow = {
  integrationId: string;
  userWorkosId: string;
  createdAfterCursor: Date | null;
  pageCursor: string | null;
  pendingCreatedBeforeCursor: Date | null;
};

export async function listEnabledGoatFathomBrainSourceRoutes(
  integrationIds: readonly string[],
  db: DbLike = getDb(),
): Promise<GoatFathomBrainSourceRoute[]> {
  if (integrationIds.length === 0) return [];
  const rows = await db
    .select({
      integrationId: goatBrainSources.integrationId,
      brainRef: goatBrainSources.brainId,
    })
    .from(goatBrainSources)
    .where(
      and(
        eq(goatBrainSources.provider, GOAT_FATHOM_PROVIDER),
        eq(goatBrainSources.enabled, true),
        inArray(goatBrainSources.integrationId, [...integrationIds]),
      ),
    );
  return rows;
}

export async function ensureGoatFathomSyncState(
  input: { integrationId: string; userWorkosId: string },
  db: DbLike = getDb(),
): Promise<void> {
  await db
    .insert(goatFathomSyncState)
    .values({ integrationId: input.integrationId, userWorkosId: input.userWorkosId })
    .onConflictDoNothing();
}

// Claims one integration's poll slot: stamps last_polled_at only when the row
// hasn't been polled within the cooldown, so concurrent runner replicas skip
// each other. Returns the cursor on success, null when another replica holds
// the slot.
export async function claimGoatFathomSyncState(
  input: { integrationId: string; cooldownMs: number },
  db: DbLike = getDb(),
): Promise<GoatFathomSyncStateRow | null> {
  const cooldownSeconds = Math.max(1, Math.floor(input.cooldownMs / 1000));
  const rows = await db
    .update(goatFathomSyncState)
    .set({ lastPolledAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        eq(goatFathomSyncState.integrationId, input.integrationId),
        or(
          isNull(goatFathomSyncState.lastPolledAt),
          lt(
            goatFathomSyncState.lastPolledAt,
            sql`now() - make_interval(secs => ${cooldownSeconds})`,
          ),
        ),
      ),
    )
    .returning({
      integrationId: goatFathomSyncState.integrationId,
      userWorkosId: goatFathomSyncState.userWorkosId,
      createdAfterCursor: goatFathomSyncState.createdAfterCursor,
      pageCursor: goatFathomSyncState.pageCursor,
      pendingCreatedBeforeCursor: goatFathomSyncState.pendingCreatedBeforeCursor,
    });
  return rows[0] ?? null;
}

export async function updateGoatFathomSyncPage(
  input: {
    integrationId: string;
    expectedCreatedAfterCursor: Date;
    expectedPageCursor: string | null;
    pageCursor: string;
    pendingCreatedBeforeCursor: Date;
  },
  db: DbLike = getDb(),
): Promise<boolean> {
  const rows = await db
    .update(goatFathomSyncState)
    .set({
      pageCursor: input.pageCursor,
      pendingCreatedBeforeCursor: input.pendingCreatedBeforeCursor,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(goatFathomSyncState.integrationId, input.integrationId),
        eq(goatFathomSyncState.createdAfterCursor, input.expectedCreatedAfterCursor),
        input.expectedPageCursor
          ? eq(goatFathomSyncState.pageCursor, input.expectedPageCursor)
          : isNull(goatFathomSyncState.pageCursor),
      ),
    )
    .returning({ integrationId: goatFathomSyncState.integrationId });
  return rows.length > 0;
}

export async function completeGoatFathomSyncPages(
  input: {
    integrationId: string;
    expectedCreatedAfterCursor: Date;
    expectedPageCursor: string | null;
    createdAfterCursor: Date;
  },
  db: DbLike = getDb(),
): Promise<boolean> {
  const rows = await db
    .update(goatFathomSyncState)
    .set({
      createdAfterCursor: input.createdAfterCursor,
      pageCursor: null,
      pendingCreatedBeforeCursor: null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(goatFathomSyncState.integrationId, input.integrationId),
        eq(goatFathomSyncState.createdAfterCursor, input.expectedCreatedAfterCursor),
        input.expectedPageCursor
          ? eq(goatFathomSyncState.pageCursor, input.expectedPageCursor)
          : isNull(goatFathomSyncState.pageCursor),
      ),
    )
    .returning({ integrationId: goatFathomSyncState.integrationId });
  return rows.length > 0;
}

export async function updateGoatFathomSyncCursor(
  input: { integrationId: string; createdAfterCursor: Date },
  db: DbLike = getDb(),
): Promise<void> {
  await db
    .update(goatFathomSyncState)
    .set({
      createdAfterCursor: input.createdAfterCursor,
      pageCursor: null,
      pendingCreatedBeforeCursor: null,
      updatedAt: sql`now()`,
    })
    .where(eq(goatFathomSyncState.integrationId, input.integrationId));
}

// Cross-member dedup key for one Fathom recording. Recording ids are stable
// per meeting, so two members whose keys can both read a team-shared meeting
// converge on one claim per brain.
export function goatFathomEventClaimKey(recordingId: string | number): string {
  return `recording:${recordingId}`;
}
