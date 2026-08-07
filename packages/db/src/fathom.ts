import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { getDb } from "./client";
import { brainSources, fathomPendingMeetings, fathomSyncState } from "./schema";

type DbLike = any;

export const GOAT_FATHOM_PROVIDER = "fathom" as const;
export const GOAT_FATHOM_CREDENTIAL_KIND = "api_key" as const;

export type FathomBrainSourceRoute = {
  integrationId: string;
  brainRef: string;
};

export type FathomSyncStateRow = {
  integrationId: string;
  userWorkosId: string;
  createdAfterCursor: Date | null;
  pageCursor: string | null;
  pendingCreatedBeforeCursor: Date | null;
};

export type FathomPendingMeetingRow = {
  integrationId: string;
  recordingId: string;
  userWorkosId: string;
  meetingCreatedAt: Date;
  rawPayload: Record<string, unknown>;
  attemptCount: number;
};

export async function listEnabledFathomBrainSourceRoutes(
  integrationIds: readonly string[],
  db: DbLike = getDb(),
): Promise<FathomBrainSourceRoute[]> {
  if (integrationIds.length === 0) return [];
  const rows = await db
    .select({
      integrationId: brainSources.integrationId,
      brainRef: brainSources.brainId,
    })
    .from(brainSources)
    .where(
      and(
        eq(brainSources.provider, GOAT_FATHOM_PROVIDER),
        eq(brainSources.enabled, true),
        inArray(brainSources.integrationId, [...integrationIds]),
      ),
    );
  return rows;
}

export async function ensureFathomSyncState(
  input: { integrationId: string; userWorkosId: string; createdAfterCursor?: Date },
  db: DbLike = getDb(),
): Promise<void> {
  await db
    .insert(fathomSyncState)
    .values({
      integrationId: input.integrationId,
      userWorkosId: input.userWorkosId,
      ...(input.createdAfterCursor ? { createdAfterCursor: input.createdAfterCursor } : {}),
    })
    .onConflictDoNothing();
}

export async function upsertFathomPendingMeeting(
  input: {
    integrationId: string;
    recordingId: string;
    userWorkosId: string;
    meetingCreatedAt: Date;
    rawPayload: Record<string, unknown>;
  },
  db: DbLike = getDb(),
): Promise<void> {
  await db
    .insert(fathomPendingMeetings)
    .values(input)
    .onConflictDoUpdate({
      target: [fathomPendingMeetings.integrationId, fathomPendingMeetings.recordingId],
      set: {
        userWorkosId: input.userWorkosId,
        meetingCreatedAt: input.meetingCreatedAt,
        rawPayload: input.rawPayload,
        updatedAt: sql`now()`,
      },
    });
}

export async function listFathomPendingMeetings(
  input: { integrationId: string; limit?: number },
  db: DbLike = getDb(),
): Promise<FathomPendingMeetingRow[]> {
  return (
    db
      .select({
        integrationId: fathomPendingMeetings.integrationId,
        recordingId: fathomPendingMeetings.recordingId,
        userWorkosId: fathomPendingMeetings.userWorkosId,
        meetingCreatedAt: fathomPendingMeetings.meetingCreatedAt,
        rawPayload: fathomPendingMeetings.rawPayload,
        attemptCount: fathomPendingMeetings.attemptCount,
      })
      .from(fathomPendingMeetings)
      .where(eq(fathomPendingMeetings.integrationId, input.integrationId))
      // Explicit NULLS FIRST attempts newly pending meetings before the oldest
      // retry timestamp. Persisted failures then rotate fairly instead of
      // starving newer recordings behind a stuck row.
      .orderBy(
        sql`${fathomPendingMeetings.lastAttemptedAt} ASC NULLS FIRST`,
        asc(fathomPendingMeetings.createdAt),
      )
      .limit(Math.max(1, input.limit ?? 20))
  );
}

export async function recordFathomPendingMeetingAttempt(
  input: {
    integrationId: string;
    recordingId: string;
    rawPayload: Record<string, unknown>;
  },
  db: DbLike = getDb(),
): Promise<void> {
  await db
    .update(fathomPendingMeetings)
    .set({
      rawPayload: input.rawPayload,
      attemptCount: sql`${fathomPendingMeetings.attemptCount} + 1`,
      lastAttemptedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(fathomPendingMeetings.integrationId, input.integrationId),
        eq(fathomPendingMeetings.recordingId, input.recordingId),
      ),
    );
}

export async function deleteFathomPendingMeeting(
  input: { integrationId: string; recordingId: string },
  db: DbLike = getDb(),
): Promise<void> {
  await db
    .delete(fathomPendingMeetings)
    .where(
      and(
        eq(fathomPendingMeetings.integrationId, input.integrationId),
        eq(fathomPendingMeetings.recordingId, input.recordingId),
      ),
    );
}

// Claims one integration's poll slot: stamps last_polled_at only when the row
// hasn't been polled within the cooldown, so concurrent runner replicas skip
// each other. Returns the cursor on success, null when another replica holds
// the slot.
export async function claimFathomSyncState(
  input: { integrationId: string; cooldownMs: number },
  db: DbLike = getDb(),
): Promise<FathomSyncStateRow | null> {
  const cooldownSeconds = Math.max(1, Math.floor(input.cooldownMs / 1000));
  const rows = await db
    .update(fathomSyncState)
    .set({ lastPolledAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        eq(fathomSyncState.integrationId, input.integrationId),
        or(
          isNull(fathomSyncState.lastPolledAt),
          lt(fathomSyncState.lastPolledAt, sql`now() - make_interval(secs => ${cooldownSeconds})`),
        ),
      ),
    )
    .returning({
      integrationId: fathomSyncState.integrationId,
      userWorkosId: fathomSyncState.userWorkosId,
      createdAfterCursor: fathomSyncState.createdAfterCursor,
      pageCursor: fathomSyncState.pageCursor,
      pendingCreatedBeforeCursor: fathomSyncState.pendingCreatedBeforeCursor,
    });
  return rows[0] ?? null;
}

export async function updateFathomSyncPage(
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
    .update(fathomSyncState)
    .set({
      pageCursor: input.pageCursor,
      pendingCreatedBeforeCursor: input.pendingCreatedBeforeCursor,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(fathomSyncState.integrationId, input.integrationId),
        eq(fathomSyncState.createdAfterCursor, input.expectedCreatedAfterCursor),
        input.expectedPageCursor
          ? eq(fathomSyncState.pageCursor, input.expectedPageCursor)
          : isNull(fathomSyncState.pageCursor),
      ),
    )
    .returning({ integrationId: fathomSyncState.integrationId });
  return rows.length > 0;
}

export async function completeFathomSyncPages(
  input: {
    integrationId: string;
    expectedCreatedAfterCursor: Date;
    expectedPageCursor: string | null;
    createdAfterCursor: Date;
  },
  db: DbLike = getDb(),
): Promise<boolean> {
  const rows = await db
    .update(fathomSyncState)
    .set({
      createdAfterCursor: input.createdAfterCursor,
      pageCursor: null,
      pendingCreatedBeforeCursor: null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(fathomSyncState.integrationId, input.integrationId),
        eq(fathomSyncState.createdAfterCursor, input.expectedCreatedAfterCursor),
        input.expectedPageCursor
          ? eq(fathomSyncState.pageCursor, input.expectedPageCursor)
          : isNull(fathomSyncState.pageCursor),
      ),
    )
    .returning({ integrationId: fathomSyncState.integrationId });
  return rows.length > 0;
}

export async function updateFathomSyncCursor(
  input: { integrationId: string; createdAfterCursor: Date },
  db: DbLike = getDb(),
): Promise<void> {
  await db
    .update(fathomSyncState)
    .set({
      createdAfterCursor: input.createdAfterCursor,
      pageCursor: null,
      pendingCreatedBeforeCursor: null,
      updatedAt: sql`now()`,
    })
    .where(eq(fathomSyncState.integrationId, input.integrationId));
}

// Cross-member dedup key for one Fathom recording. Recording ids are stable
// per meeting, so two members whose keys can both read a team-shared meeting
// converge on one claim per brain.
export function fathomEventClaimKey(recordingId: string | number): string {
  return `recording:${recordingId}`;
}
