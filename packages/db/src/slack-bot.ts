import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, isNotNull, isNull, lt } from "drizzle-orm";
import { getDb } from "./client";
import {
  type BrainVisibility,
  brainSources,
  brains,
  type IntegrationStatus,
  integrations,
  slackBotEventClaims,
  slackBotThreadParticipation,
} from "./product-schema";

type DbLike = any;

export const SLACK_BOT_EVENT_CLAIM_LEASE_MS = 5 * 60 * 1000;

export type SlackConversationRef = {
  id: string;
  name: string;
};

export type SlackBotSourceConfig = {
  channels?: SlackConversationRef[];
};

export function parseSlackBotSourceConfig(value: unknown): SlackBotSourceConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const channels = parseConversationRefs((value as Record<string, unknown>).channels);
  return channels ? { channels } : {};
}

export function slackBotSelectedChannelIds(config: SlackBotSourceConfig): Set<string> {
  return new Set((config.channels ?? []).map((channel) => channel.id));
}

export type SlackBotEventClaim = {
  eventId: string;
  claimId: string;
};

export type SlackBotIntegrationForTeam = {
  id: string;
  userWorkosId: string;
  workspaceId: string;
  status: IntegrationStatus;
  // Bot scopes granted at install time; features added after an install (DMs,
  // reactions, user lookups) check these and degrade until a reconnect.
  scopes: string[];
};

export type SlackBotIntegrationForWorkspace = SlackBotIntegrationForTeam & {
  externalId: string;
  connectionLabel: string | null;
  statusReason: string | null;
  updatedAt: Date;
};

// A brain the bot is allowed to answer from, with its channel scoping.
export type SlackBotBrainRoute = {
  brainRef: string;
  brainName: string;
  visibility: BrainVisibility;
  config: SlackBotSourceConfig;
};

// All workspace installs of the bot for a Slack team. Normally one row, but
// two opencompany workspaces installing the same Slack team is possible (the unique
// index is per-workspace); callers process every match — channel scoping
// keeps double-answers unlikely, an accepted beta caveat.
export async function listSlackBotIntegrationsForTeam(
  teamId: string,
  db: DbLike = getDb(),
): Promise<SlackBotIntegrationForTeam[]> {
  const rows = await db
    .select({
      id: integrations.id,
      userWorkosId: integrations.userWorkosId,
      workspaceId: integrations.workspaceId,
      status: integrations.status,
      scopes: integrations.scopes,
    })
    .from(integrations)
    .where(
      and(
        eq(integrations.provider, "slack_bot"),
        eq(integrations.externalId, teamId),
        isNotNull(integrations.workspaceId),
      ),
    );
  return rows as SlackBotIntegrationForTeam[];
}

export async function getSlackBotIntegrationForWorkspace(
  workspaceId: string,
  db: DbLike = getDb(),
): Promise<SlackBotIntegrationForWorkspace | null> {
  const [row] = await db
    .select({
      id: integrations.id,
      userWorkosId: integrations.userWorkosId,
      workspaceId: integrations.workspaceId,
      status: integrations.status,
      scopes: integrations.scopes,
      externalId: integrations.externalId,
      connectionLabel: integrations.connectionLabel,
      statusReason: integrations.statusReason,
      updatedAt: integrations.updatedAt,
    })
    .from(integrations)
    .where(and(eq(integrations.provider, "slack_bot"), eq(integrations.workspaceId, workspaceId)))
    .orderBy(desc(integrations.updatedAt))
    .limit(1);
  return (row as SlackBotIntegrationForWorkspace | undefined) ?? null;
}

export async function listEnabledSlackBotBrainRoutes(
  integrationId: string,
  db: DbLike = getDb(),
): Promise<SlackBotBrainRoute[]> {
  const rows = await db
    .select({
      brainRef: brainSources.brainId,
      brainName: brains.name,
      visibility: brains.visibility,
      config: brainSources.config,
    })
    .from(brainSources)
    .innerJoin(brains, eq(brains.id, brainSources.brainId))
    .where(
      and(
        eq(brainSources.provider, "slack_bot"),
        eq(brainSources.enabled, true),
        eq(brainSources.integrationId, integrationId),
      ),
    );

  return rows.map(
    (row: {
      brainRef: string;
      brainName: string;
      visibility: BrainVisibility;
      config: unknown;
    }) => ({
      brainRef: row.brainRef,
      brainName: row.brainName,
      visibility: row.visibility,
      config: parseSlackBotSourceConfig(row.config),
    }),
  );
}

export async function markSlackBotIntegrationStatusForTeam(
  input: {
    teamId: string;
    status: IntegrationStatus;
    statusReason?: string | null;
    now?: Date;
  },
  db: DbLike = getDb(),
): Promise<void> {
  await db
    .update(integrations)
    .set({
      status: input.status,
      statusReason: input.statusReason ? input.statusReason.slice(0, 240) : null,
      updatedAt: input.now ?? new Date(),
    })
    .where(
      and(
        eq(integrations.provider, "slack_bot"),
        eq(integrations.externalId, input.teamId),
        isNotNull(integrations.workspaceId),
      ),
    );
}

export async function claimSlackBotEvent(
  input: { eventId: string; teamId: string; now?: Date },
  db: DbLike = getDb(),
): Promise<SlackBotEventClaim | null> {
  const eventId = input.eventId.trim();
  const teamId = input.teamId.trim();
  if (!eventId || !teamId) return null;

  const now = input.now ?? new Date();
  const staleBefore = new Date(now.getTime() - SLACK_BOT_EVENT_CLAIM_LEASE_MS);
  const claimId = `gsbec_${randomUUID().replace(/-/g, "")}`;
  const [claimed] = await db
    .insert(slackBotEventClaims)
    .values({ eventId, teamId, claimId, claimedAt: now, completedAt: null })
    .onConflictDoUpdate({
      target: slackBotEventClaims.eventId,
      set: { teamId, claimId, claimedAt: now, completedAt: null },
      setWhere: and(
        isNull(slackBotEventClaims.completedAt),
        lt(slackBotEventClaims.claimedAt, staleBefore),
      ),
    })
    .returning({ eventId: slackBotEventClaims.eventId });

  return claimed ? { eventId, claimId } : null;
}

export async function completeSlackBotEvent(
  claim: SlackBotEventClaim,
  db: DbLike = getDb(),
): Promise<void> {
  await db
    .update(slackBotEventClaims)
    .set({ completedAt: new Date() })
    .where(
      and(
        eq(slackBotEventClaims.eventId, claim.eventId),
        eq(slackBotEventClaims.claimId, claim.claimId),
      ),
    );
}

export async function releaseSlackBotEvent(
  claim: SlackBotEventClaim,
  db: DbLike = getDb(),
): Promise<void> {
  await db
    .delete(slackBotEventClaims)
    .where(
      and(
        eq(slackBotEventClaims.eventId, claim.eventId),
        eq(slackBotEventClaims.claimId, claim.claimId),
        isNull(slackBotEventClaims.completedAt),
      ),
    );
}

export const SLACK_BOT_THREAD_PARTICIPATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type SlackBotThreadRef = {
  teamId: string;
  channelId: string;
  threadTs: string;
};

// Upserted every time the bot posts an answer into a thread; the message-event
// webhook then treats replies in that thread as follow-ups without a mention.
export async function recordSlackBotThreadParticipation(
  input: SlackBotThreadRef & { integrationId: string; botReplyTs: string; now?: Date },
  db: DbLike = getDb(),
): Promise<void> {
  const now = input.now ?? new Date();
  await db
    .insert(slackBotThreadParticipation)
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
        slackBotThreadParticipation.teamId,
        slackBotThreadParticipation.channelId,
        slackBotThreadParticipation.threadTs,
      ],
      set: {
        integrationId: input.integrationId,
        lastBotReplyTs: input.botReplyTs,
        updatedAt: now,
      },
    });
}

export async function getSlackBotThreadParticipation(
  input: SlackBotThreadRef & { now?: Date },
  db: DbLike = getDb(),
): Promise<{ integrationId: string } | null> {
  const cutoff = new Date(
    (input.now ?? new Date()).getTime() - SLACK_BOT_THREAD_PARTICIPATION_TTL_MS,
  );
  const rows = await db
    .select({ integrationId: slackBotThreadParticipation.integrationId })
    .from(slackBotThreadParticipation)
    .where(
      and(
        eq(slackBotThreadParticipation.teamId, input.teamId),
        eq(slackBotThreadParticipation.channelId, input.channelId),
        eq(slackBotThreadParticipation.threadTs, input.threadTs),
        gte(slackBotThreadParticipation.updatedAt, cutoff),
      ),
    )
    .limit(1);
  return (rows[0] as { integrationId: string } | undefined) ?? null;
}

// Threads with no bot reply in ~30 days stop qualifying for mention-free
// follow-ups; a fresh mention re-records them.
export async function pruneSlackBotThreadParticipation(
  now: Date = new Date(),
  db: DbLike = getDb(),
): Promise<void> {
  const cutoff = new Date(now.getTime() - SLACK_BOT_THREAD_PARTICIPATION_TTL_MS);
  await db
    .delete(slackBotThreadParticipation)
    .where(lt(slackBotThreadParticipation.updatedAt, cutoff));
}

function parseConversationRefs(value: unknown): SlackConversationRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const refs = value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id) return [];
    const name = typeof record.name === "string" ? record.name.trim() : "";
    return [{ id, name: name || id }];
  });
  return refs.length > 0 ? refs : undefined;
}
