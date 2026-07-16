import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { getDb } from "./client";
import { goatBrainSources, goatGranolaSyncState } from "./goat-schema";

type DbLike = any;

export const GOAT_GRANOLA_PROVIDER = "granola" as const;
export const GOAT_GRANOLA_CREDENTIAL_KIND = "api_key" as const;

export type GoatGranolaBrainSourceRoute = {
  integrationId: string;
  brainRef: string;
};

export type GoatGranolaSyncStateRow = {
  integrationId: string;
  userWorkosId: string;
  updatedAfterCursor: Date | null;
  pageCursor: string | null;
  pendingUpdatedAfterCursor: Date | null;
};

export async function listEnabledGoatGranolaBrainSourceRoutes(
  integrationIds: readonly string[],
  db: DbLike = getDb(),
): Promise<GoatGranolaBrainSourceRoute[]> {
  if (integrationIds.length === 0) return [];
  const rows = await db
    .select({
      integrationId: goatBrainSources.integrationId,
      brainRef: goatBrainSources.brainId,
    })
    .from(goatBrainSources)
    .where(
      and(
        eq(goatBrainSources.provider, GOAT_GRANOLA_PROVIDER),
        eq(goatBrainSources.enabled, true),
        inArray(goatBrainSources.integrationId, [...integrationIds]),
      ),
    );
  return rows;
}

export async function ensureGoatGranolaSyncState(
  input: { integrationId: string; userWorkosId: string },
  db: DbLike = getDb(),
): Promise<void> {
  await db
    .insert(goatGranolaSyncState)
    .values({ integrationId: input.integrationId, userWorkosId: input.userWorkosId })
    .onConflictDoNothing();
}

// Claims one integration's poll slot: stamps last_polled_at only when the row
// hasn't been polled within the cooldown, so concurrent runner replicas skip
// each other. Returns the cursor on success, null when another replica holds
// the slot.
export async function claimGoatGranolaSyncState(
  input: { integrationId: string; cooldownMs: number },
  db: DbLike = getDb(),
): Promise<GoatGranolaSyncStateRow | null> {
  const cooldownSeconds = Math.max(1, Math.floor(input.cooldownMs / 1000));
  const rows = await db
    .update(goatGranolaSyncState)
    .set({ lastPolledAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        eq(goatGranolaSyncState.integrationId, input.integrationId),
        or(
          isNull(goatGranolaSyncState.lastPolledAt),
          lt(
            goatGranolaSyncState.lastPolledAt,
            sql`now() - make_interval(secs => ${cooldownSeconds})`,
          ),
        ),
      ),
    )
    .returning({
      integrationId: goatGranolaSyncState.integrationId,
      userWorkosId: goatGranolaSyncState.userWorkosId,
      updatedAfterCursor: goatGranolaSyncState.updatedAfterCursor,
      pageCursor: goatGranolaSyncState.pageCursor,
      pendingUpdatedAfterCursor: goatGranolaSyncState.pendingUpdatedAfterCursor,
    });
  return rows[0] ?? null;
}

export async function updateGoatGranolaSyncPage(
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
    .update(goatGranolaSyncState)
    .set({
      pageCursor: input.pageCursor,
      pendingUpdatedAfterCursor: input.pendingUpdatedAfterCursor,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(goatGranolaSyncState.integrationId, input.integrationId),
        eq(goatGranolaSyncState.updatedAfterCursor, input.expectedUpdatedAfterCursor),
        input.expectedPageCursor
          ? eq(goatGranolaSyncState.pageCursor, input.expectedPageCursor)
          : isNull(goatGranolaSyncState.pageCursor),
      ),
    )
    .returning({ integrationId: goatGranolaSyncState.integrationId });
  return rows.length > 0;
}

export async function completeGoatGranolaSyncPages(
  input: {
    integrationId: string;
    expectedUpdatedAfterCursor: Date;
    expectedPageCursor: string | null;
    updatedAfterCursor: Date;
  },
  db: DbLike = getDb(),
): Promise<boolean> {
  const rows = await db
    .update(goatGranolaSyncState)
    .set({
      updatedAfterCursor: input.updatedAfterCursor,
      pageCursor: null,
      pendingUpdatedAfterCursor: null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(goatGranolaSyncState.integrationId, input.integrationId),
        eq(goatGranolaSyncState.updatedAfterCursor, input.expectedUpdatedAfterCursor),
        input.expectedPageCursor
          ? eq(goatGranolaSyncState.pageCursor, input.expectedPageCursor)
          : isNull(goatGranolaSyncState.pageCursor),
      ),
    )
    .returning({ integrationId: goatGranolaSyncState.integrationId });
  return rows.length > 0;
}

export async function updateGoatGranolaSyncCursor(
  input: { integrationId: string; updatedAfterCursor: Date },
  db: DbLike = getDb(),
): Promise<void> {
  await db
    .update(goatGranolaSyncState)
    .set({
      updatedAfterCursor: input.updatedAfterCursor,
      pageCursor: null,
      pendingUpdatedAfterCursor: null,
      updatedAt: sql`now()`,
    })
    .where(eq(goatGranolaSyncState.integrationId, input.integrationId));
}

// Cross-member dedup key for one Granola note. Note ids are stable per note,
// so two members whose keys can both read a shared note converge on one claim
// per brain.
export function goatGranolaEventClaimKey(noteId: string): string {
  return `note:${noteId}`;
}
