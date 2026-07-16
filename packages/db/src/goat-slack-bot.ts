import { randomUUID } from "node:crypto";
import { and, desc, eq, isNotNull, isNull, lt } from "drizzle-orm";
import { getDb } from "./client";
import {
  type GoatBrainVisibility,
  type GoatIntegrationStatus,
  goatBrainSources,
  goatBrains,
  goatIntegrations,
  goatSlackBotEventClaims,
} from "./goat-schema";
import { type GoatSlackBrainSourceConfig, parseGoatSlackBrainSourceConfig } from "./goat-slack";

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
