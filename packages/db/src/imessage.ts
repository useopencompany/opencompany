import { randomUUID } from "node:crypto";
import { and, eq, gte, sql } from "drizzle-orm";
import { getDb } from "./client";
import {
  type ImessageSendSource,
  type ImessageSendStatus,
  imessagePairingChallenges,
  imessageSends,
  integrations,
  users,
} from "./product-schema";

type DbLike = any;

export const IMESSAGE_PROVIDER = "imessage" as const;

// One iMessage pairing per user: the paired phone lives on a single personal
// integration row keyed on this stable sentinel, so re-pairing with a new
// number updates the row in place instead of minting a sibling.
export function imessageExternalIdForUser(userWorkosId: string) {
  return `imessage:${userWorkosId}`;
}

export type ImessageDelivery = {
  integrationId: string;
  phoneE164: string;
};

// The single availability gate for the send_user_message tool: the user's
// feature flag is on AND a paired, connected integration row exists. Every
// surface (chat route, runner task executors) must use this same resolver.
export async function resolveImessageDelivery(
  userWorkosId: string,
  db: DbLike = getDb(),
): Promise<ImessageDelivery | null> {
  const [row] = await db
    .select({
      integrationId: integrations.id,
      phoneE164: integrations.accountName,
    })
    .from(integrations)
    .innerJoin(users, eq(users.workosUserId, integrations.userWorkosId))
    .where(
      and(
        eq(integrations.userWorkosId, userWorkosId),
        eq(integrations.provider, IMESSAGE_PROVIDER),
        eq(integrations.status, "connected"),
        sql`${integrations.workspaceId} IS NULL`,
        eq(users.imessageEnabled, true),
      ),
    )
    .limit(1);
  if (!row?.phoneE164) return null;
  return { integrationId: row.integrationId, phoneE164: row.phoneE164 };
}

export type ImessagePairingChallengeRow = {
  id: string;
  userWorkosId: string;
  phoneE164: string;
  codeHash: string;
  attemptCount: number;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
};

export async function getImessagePairingChallenge(
  userWorkosId: string,
  db: DbLike = getDb(),
): Promise<ImessagePairingChallengeRow | null> {
  const [row] = await db
    .select()
    .from(imessagePairingChallenges)
    .where(eq(imessagePairingChallenges.userWorkosId, userWorkosId))
    .limit(1);
  return row ?? null;
}

export async function upsertImessagePairingChallenge(
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
    .insert(imessagePairingChallenges)
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
      target: [imessagePairingChallenges.userWorkosId],
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

export async function incrementImessageChallengeAttempts(
  challengeId: string,
  db: DbLike = getDb(),
): Promise<void> {
  await db
    .update(imessagePairingChallenges)
    .set({ attemptCount: sql`${imessagePairingChallenges.attemptCount} + 1` })
    .where(eq(imessagePairingChallenges.id, challengeId));
}

export async function consumeImessageChallenge(
  challengeId: string,
  db: DbLike = getDb(),
): Promise<void> {
  await db
    .update(imessagePairingChallenges)
    .set({ consumedAt: new Date() })
    .where(eq(imessagePairingChallenges.id, challengeId));
}

export async function countImessageSendsSince(
  userWorkosId: string,
  since: Date,
  db: DbLike = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(imessageSends)
    .where(and(eq(imessageSends.userWorkosId, userWorkosId), gte(imessageSends.createdAt, since)));
  return row?.count ?? 0;
}

export async function getSuccessfulImessageSendForTurn(
  turnId: string,
  db: DbLike = getDb(),
): Promise<{ id: string; createdAt: Date } | null> {
  const [row] = await db
    .select({
      id: imessageSends.id,
      createdAt: imessageSends.createdAt,
    })
    .from(imessageSends)
    .where(and(eq(imessageSends.turnId, turnId), eq(imessageSends.status, "sent")))
    .limit(1);
  return row ?? null;
}

export async function recordImessageSend(
  input: {
    userWorkosId: string;
    source: ImessageSendSource;
    status: ImessageSendStatus;
    chatSessionId?: string | null;
    turnId?: string | null;
    errorReason?: string | null;
  },
  db: DbLike = getDb(),
): Promise<void> {
  await db.insert(imessageSends).values({
    id: `gims_${randomUUID().replace(/-/g, "")}`,
    userWorkosId: input.userWorkosId,
    source: input.source,
    status: input.status,
    chatSessionId: input.chatSessionId ?? null,
    turnId: input.turnId ?? null,
    errorReason: input.errorReason ?? null,
  });
}
