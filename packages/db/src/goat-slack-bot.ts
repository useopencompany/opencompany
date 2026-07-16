import { and, desc, eq, isNotNull } from "drizzle-orm";
import { getDb } from "./client";
import {
  type GoatBrainVisibility,
  type GoatIntegrationStatus,
  goatBrainSources,
  goatBrains,
  goatIntegrations,
} from "./goat-schema";
import { type GoatSlackBrainSourceConfig, parseGoatSlackBrainSourceConfig } from "./goat-slack";

type DbLike = any;

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
