import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, isNotNull, isNull, lt } from "drizzle-orm";
import { getDb } from "./client";
import {
  type GoatBrainVisibility,
  type GoatIntegrationStatus,
  goatBrainSources,
  goatBrains,
  goatIntegrations,
  goatSlackBotEventClaims,
  goatSlackBotThreadParticipation,
} from "./schema";
import { type GoatSlackBrainSourceConfig, parseGoatSlackBrainSourceConfig } from "./slack";

type DbLike = any;

export const GOAT_SLACK_BOT_EVENT_CLAIM_LEASE_MS = 5 * 60 * 1000;

export type GoatSlackBotEventClaim = {
  eventId: string;
  claimId: string;
};

export type GoatSlackBotIntegrationForTeam = {
  id: string;
  userWorkosId: string;
  workspaceId: string;
  status: GoatIntegrationStatus;
  // Bot scopes granted at install time; features added after an install (DMs,
  // reactions, user lookups) check these and degrade until a reconnect.
  scopes: string[];
};

export type GoatSlackBotIntegrationForWorkspace = GoatSlackBotIntegrationForTeam & {
  externalId: string;
  connectionLabel: string | null;
  statusReason: string | null;
  updatedAt: Date;
};

// A brain the bot is allowed to answer from, with its channel scoping.
export type GoatSlackBotBrainRoute = {
  brainRef: string;
  brainName: string;
  visibility: GoatBrainVisibility;
  config: GoatSlackBrainSourceConfig;
};

// All workspace installs of the bot for a Slack team. Normally one row, but
// two goat workspaces installing the same Slack team is possible (the unique
// index is per-workspace); callers process every match — channel scoping
// keeps double-answers unlikely, an accepted beta caveat.
export async function listGoatSlackBotIntegrationsForTeam(
  teamId: string,
  db: DbLike = getDb(),
): Promise<GoatSlackBotIntegrationForTeam[]> {
  const rows = await db
    .select({
      id: goatIntegrations.id,
      userWorkosId: goatIntegrations.userWorkosId,
      workspaceId: goatIntegrations.workspaceId,
      status: goatIntegrations.status,
      scopes: goatIntegrations.scopes,
    })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.provider, "slack_bot"),
        eq(goatIntegrations.externalId, teamId),
        isNotNull(goatIntegrations.workspaceId),
      ),
    );
  return rows as GoatSlackBotIntegrationForTeam[];
}

export async function getGoatSlackBotIntegrationForWorkspace(
  workspaceId: string,
  db: DbLike = getDb(),
): Promise<GoatSlackBotIntegrationForWorkspace | null> {
  const [row] = await db
    .select({
      id: goatIntegrations.id,
      userWorkosId: goatIntegrations.userWorkosId,
      workspaceId: goatIntegrations.workspaceId,
      status: goatIntegrations.status,
      scopes: goatIntegrations.scopes,
      externalId: goatIntegrations.externalId,
      connectionLabel: goatIntegrations.connectionLabel,
      statusReason: goatIntegrations.statusReason,
      updatedAt: goatIntegrations.updatedAt,
    })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.provider, "slack_bot"),
        eq(goatIntegrations.workspaceId, workspaceId),
      ),
    )
    .orderBy(desc(goatIntegrations.updatedAt))
    .limit(1);
  return (row as GoatSlackBotIntegrationForWorkspace | undefined) ?? null;
}

export async function listEnabledGoatSlackBotBrainRoutes(
  integrationId: string,
  db: DbLike = getDb(),
): Promise<GoatSlackBotBrainRoute[]> {
  const rows = await db
    .select({
      brainRef: goatBrainSources.brainId,
      brainName: goatBrains.name,
      visibility: goatBrains.visibility,
      config: goatBrainSources.config,
    })
    .from(goatBrainSources)
    .innerJoin(goatBrains, eq(goatBrains.id, goatBrainSources.brainId))
    .where(
      and(
        eq(goatBrainSources.provider, "slack_bot"),
        eq(goatBrainSources.enabled, true),
        eq(goatBrainSources.integrationId, integrationId),
      ),
    );

  return rows.map(
    (row: {
      brainRef: string;
      brainName: string;
      visibility: GoatBrainVisibility;
      config: unknown;
    }) => ({
      brainRef: row.brainRef,
      brainName: row.brainName,
      visibility: row.visibility,
      config: parseGoatSlackBrainSourceConfig(row.config),
    }),
  );
}

export async function markGoatSlackBotIntegrationStatusForTeam(
  input: {
    teamId: string;
    status: GoatIntegrationStatus;
    statusReason?: string | null;
    now?: Date;
  },
  db: DbLike = getDb(),
): Promise<void> {
  await db
    .update(goatIntegrations)
    .set({
      status: input.status,
      statusReason: input.statusReason ? input.statusReason.slice(0, 240) : null,
      updatedAt: input.now ?? new Date(),
    })
    .where(
      and(
        eq(goatIntegrations.provider, "slack_bot"),
        eq(goatIntegrations.externalId, input.teamId),
        isNotNull(goatIntegrations.workspaceId),
      ),
    );
}

export async function claimGoatSlackBotEvent(
  input: { eventId: string; teamId: string; now?: Date },
  db: DbLike = getDb(),
): Promise<GoatSlackBotEventClaim | null> {
  const eventId = input.eventId.trim();
  const teamId = input.teamId.trim();
  if (!eventId || !teamId) return null;

  const now = input.now ?? new Date();
  const staleBefore = new Date(now.getTime() - GOAT_SLACK_BOT_EVENT_CLAIM_LEASE_MS);
  const claimId = `gsbec_${randomUUID().replace(/-/g, "")}`;
  const [claimed] = await db
    .insert(goatSlackBotEventClaims)
    .values({ eventId, teamId, claimId, claimedAt: now, completedAt: null })
    .onConflictDoUpdate({
      target: goatSlackBotEventClaims.eventId,
      set: { teamId, claimId, claimedAt: now, completedAt: null },
      setWhere: and(
        isNull(goatSlackBotEventClaims.completedAt),
        lt(goatSlackBotEventClaims.claimedAt, staleBefore),
      ),
    })
    .returning({ eventId: goatSlackBotEventClaims.eventId });

  return claimed ? { eventId, claimId } : null;
}

export async function completeGoatSlackBotEvent(
  claim: GoatSlackBotEventClaim,
  db: DbLike = getDb(),
): Promise<void> {
  await db
    .update(goatSlackBotEventClaims)
    .set({ completedAt: new Date() })
    .where(
      and(
        eq(goatSlackBotEventClaims.eventId, claim.eventId),
        eq(goatSlackBotEventClaims.claimId, claim.claimId),
      ),
    );
}

export async function releaseGoatSlackBotEvent(
  claim: GoatSlackBotEventClaim,
  db: DbLike = getDb(),
): Promise<void> {
  await db
    .delete(goatSlackBotEventClaims)
    .where(
      and(
        eq(goatSlackBotEventClaims.eventId, claim.eventId),
        eq(goatSlackBotEventClaims.claimId, claim.claimId),
        isNull(goatSlackBotEventClaims.completedAt),
      ),
    );
}

export const GOAT_SLACK_BOT_THREAD_PARTICIPATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type GoatSlackBotThreadRef = {
  teamId: string;
  channelId: string;
  threadTs: string;
};

// Upserted every time the bot posts an answer into a thread; the message-event
// webhook then treats replies in that thread as follow-ups without a mention.
export async function recordGoatSlackBotThreadParticipation(
  input: GoatSlackBotThreadRef & { integrationId: string; botReplyTs: string; now?: Date },
  db: DbLike = getDb(),
): Promise<void> {
  const now = input.now ?? new Date();
  await db
    .insert(goatSlackBotThreadParticipation)
    .values({
      teamId: input.teamId,
      channelId: input.channelId,
      threadTs: input.threadTs,
      integrationId: input.integrationId,
      lastBotReplyTs: input.botReplyTs,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        goatSlackBotThreadParticipation.teamId,
        goatSlackBotThreadParticipation.channelId,
        goatSlackBotThreadParticipation.threadTs,
      ],
      set: {
        integrationId: input.integrationId,
        lastBotReplyTs: input.botReplyTs,
        updatedAt: now,
      },
    });
}

export async function getGoatSlackBotThreadParticipation(
  input: GoatSlackBotThreadRef & { now?: Date },
  db: DbLike = getDb(),
): Promise<{ integrationId: string } | null> {
  const cutoff = new Date(
    (input.now ?? new Date()).getTime() - GOAT_SLACK_BOT_THREAD_PARTICIPATION_TTL_MS,
  );
  const rows = await db
    .select({ integrationId: goatSlackBotThreadParticipation.integrationId })
    .from(goatSlackBotThreadParticipation)
    .where(
      and(
        eq(goatSlackBotThreadParticipation.teamId, input.teamId),
        eq(goatSlackBotThreadParticipation.channelId, input.channelId),
        eq(goatSlackBotThreadParticipation.threadTs, input.threadTs),
        gte(goatSlackBotThreadParticipation.updatedAt, cutoff),
      ),
    )
    .limit(1);
  return (rows[0] as { integrationId: string } | undefined) ?? null;
}

// Threads with no bot reply in ~30 days stop qualifying for mention-free
// follow-ups; a fresh mention re-records them.
export async function pruneGoatSlackBotThreadParticipation(
  now: Date = new Date(),
  db: DbLike = getDb(),
): Promise<void> {
  const cutoff = new Date(now.getTime() - GOAT_SLACK_BOT_THREAD_PARTICIPATION_TTL_MS);
  await db
    .delete(goatSlackBotThreadParticipation)
    .where(lt(goatSlackBotThreadParticipation.updatedAt, cutoff));
}
