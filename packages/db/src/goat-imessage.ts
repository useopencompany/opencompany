import { randomUUID } from "node:crypto";
import { and, eq, gte, sql } from "drizzle-orm";
import { getDb } from "./client";
import {
  type GoatImessageSendSource,
  type GoatImessageSendStatus,
  goatImessagePairingChallenges,
  goatImessageSends,
  goatIntegrations,
  goatUsers,
} from "./goat-schema";

type DbLike = any;

export const GOAT_IMESSAGE_PROVIDER = "imessage" as const;

// One iMessage pairing per user: the paired phone lives on a single personal
// integration row keyed on this stable sentinel, so re-pairing with a new
// number updates the row in place instead of minting a sibling.
export function goatImessageExternalIdForUser(userWorkosId: string) {
  return `imessage:${userWorkosId}`;
}

export type GoatImessageDelivery = {
  integrationId: string;
  phoneE164: string;
};

// The single availability gate for the send_user_message tool: the user's
// feature flag is on AND a paired, connected integration row exists. Every
// surface (chat route, runner task executors) must use this same resolver.
export async function resolveGoatImessageDelivery(
  userWorkosId: string,
  db: DbLike = getDb(),
): Promise<GoatImessageDelivery | null> {
  const [row] = await db
    .select({
      integrationId: goatIntegrations.id,
      phoneE164: goatIntegrations.accountName,
    })
    .from(goatIntegrations)
    .innerJoin(goatUsers, eq(goatUsers.workosUserId, goatIntegrations.userWorkosId))
    .where(
      and(
        eq(goatIntegrations.userWorkosId, userWorkosId),
        eq(goatIntegrations.provider, GOAT_IMESSAGE_PROVIDER),
        eq(goatIntegrations.status, "connected"),
        sql`${goatIntegrations.workspaceId} IS NULL`,
        eq(goatUsers.imessageEnabled, true),
      ),
    )
    .limit(1);
  if (!row?.phoneE164) return null;
  return { integrationId: row.integrationId, phoneE164: row.phoneE164 };
}

export type GoatImessagePairingChallengeRow = {
  id: string;
  userWorkosId: string;
  phoneE164: string;
  codeHash: string;
  attemptCount: number;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
};

export async function getGoatImessagePairingChallenge(
  userWorkosId: string,
  db: DbLike = getDb(),
): Promise<GoatImessagePairingChallengeRow | null> {
  const [row] = await db
    .select()
    .from(goatImessagePairingChallenges)
    .where(eq(goatImessagePairingChallenges.userWorkosId, userWorkosId))
    .limit(1);
  return row ?? null;
}

export async function upsertGoatImessagePairingChallenge(
  input: {
    userWorkosId: string;
    phoneE164: string;
    codeHash: string;
    expiresAt: Date;
    now?: Date;
  },
  db: DbLike = getDb(),
): Promise<void> {
  const now = input.now ?? new Date();
  await db
    .insert(goatImessagePairingChallenges)
    .values({
      id: `gimc_${randomUUID().replace(/-/g, "")}`,
      userWorkosId: input.userWorkosId,
      phoneE164: input.phoneE164,
      codeHash: input.codeHash,
      attemptCount: 0,
      expiresAt: input.expiresAt,
      consumedAt: null,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: [goatImessagePairingChallenges.userWorkosId],
      set: {
        phoneE164: input.phoneE164,
        codeHash: input.codeHash,
        attemptCount: 0,
        expiresAt: input.expiresAt,
        consumedAt: null,
        createdAt: now,
      },
    });
}

export async function incrementGoatImessageChallengeAttempts(
  challengeId: string,
  db: DbLike = getDb(),
): Promise<void> {
  await db
    .update(goatImessagePairingChallenges)
    .set({ attemptCount: sql`${goatImessagePairingChallenges.attemptCount} + 1` })
    .where(eq(goatImessagePairingChallenges.id, challengeId));
}

export async function consumeGoatImessageChallenge(
  challengeId: string,
  db: DbLike = getDb(),
): Promise<void> {
  await db
    .update(goatImessagePairingChallenges)
    .set({ consumedAt: new Date() })
    .where(eq(goatImessagePairingChallenges.id, challengeId));
}

export async function countGoatImessageSendsSince(
  userWorkosId: string,
  since: Date,
  db: DbLike = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(goatImessageSends)
    .where(
      and(
        eq(goatImessageSends.userWorkosId, userWorkosId),
        gte(goatImessageSends.createdAt, since),
      ),
    );
  return row?.count ?? 0;
}

export async function recordGoatImessageSend(
  input: {
    userWorkosId: string;
    source: GoatImessageSendSource;
    status: GoatImessageSendStatus;
    chatSessionId?: string | null;
    errorReason?: string | null;
  },
  db: DbLike = getDb(),
): Promise<void> {
  await db.insert(goatImessageSends).values({
    id: `gims_${randomUUID().replace(/-/g, "")}`,
    userWorkosId: input.userWorkosId,
    source: input.source,
    status: input.status,
    chatSessionId: input.chatSessionId ?? null,
    errorReason: input.errorReason ?? null,
  });
}
