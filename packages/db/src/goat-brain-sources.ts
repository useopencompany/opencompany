import { randomUUID } from "node:crypto";
import { and, eq, isNull, ne } from "drizzle-orm";
import { getDb } from "./client";
import {
  type GoatBrainSourceConfigProvider,
  type GoatIntegrationStatus,
  goatBrainSources,
  goatIntegrations,
  goatUsers,
} from "./goat-schema";

type DbLike = any;

export type GoatBrainSourceWithIntegration = {
  id: string;
  brainRef: string;
  provider: GoatBrainSourceConfigProvider;
  integrationId: string;
  userWorkosId: string;
  enabled: boolean;
  config: Record<string, unknown>;
  integrationStatus: GoatIntegrationStatus;
  integrationAccountName: string | null;
  integrationAccountEmail: string | null;
  integrationConnectionLabel: string | null;
  // Set when the backing integration is workspace-owned (github, jamie); null
  // for personal connections.
  integrationWorkspaceId: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  ownerAvatarUrl: string | null;
};

export async function listGoatBrainSourcesForBrain(
  brainRef: string,
  db: DbLike = getDb(),
): Promise<GoatBrainSourceWithIntegration[]> {
  const rows = await db
    .select({
      id: goatBrainSources.id,
      brainRef: goatBrainSources.brainId,
      provider: goatBrainSources.provider,
      integrationId: goatBrainSources.integrationId,
      userWorkosId: goatBrainSources.userWorkosId,
      enabled: goatBrainSources.enabled,
      config: goatBrainSources.config,
      integrationStatus: goatIntegrations.status,
      integrationAccountName: goatIntegrations.accountName,
      integrationAccountEmail: goatIntegrations.accountEmail,
      integrationConnectionLabel: goatIntegrations.connectionLabel,
      integrationWorkspaceId: goatIntegrations.workspaceId,
      ownerFirstName: goatUsers.firstName,
      ownerLastName: goatUsers.lastName,
      ownerEmail: goatUsers.email,
      ownerAvatarUrl: goatUsers.avatarUrl,
    })
    .from(goatBrainSources)
    .innerJoin(goatIntegrations, eq(goatBrainSources.integrationId, goatIntegrations.id))
    .innerJoin(goatUsers, eq(goatBrainSources.userWorkosId, goatUsers.workosUserId))
    .where(eq(goatBrainSources.brainId, brainRef));

  return rows.map((row: (typeof rows)[number]) => ({
    id: row.id,
    brainRef: row.brainRef,
    provider: row.provider,
    integrationId: row.integrationId,
    userWorkosId: row.userWorkosId,
    enabled: row.enabled,
    config: row.config,
    integrationStatus: row.integrationStatus,
    integrationAccountName: row.integrationAccountName,
    integrationAccountEmail: row.integrationAccountEmail,
    integrationConnectionLabel: row.integrationConnectionLabel,
    integrationWorkspaceId: row.integrationWorkspaceId,
    ownerName: [row.ownerFirstName, row.ownerLastName].filter(Boolean).join(" ").trim() || null,
    ownerEmail: row.ownerEmail,
    ownerAvatarUrl: row.ownerAvatarUrl,
  }));
}

export async function listEnabledBrainRefsForIntegration(
  integrationId: string,
  db: DbLike = getDb(),
): Promise<string[]> {
  const rows = await db
    .select({ brainRef: goatBrainSources.brainId })
    .from(goatBrainSources)
    .where(
      and(eq(goatBrainSources.integrationId, integrationId), eq(goatBrainSources.enabled, true)),
    );
  return rows.map((row: { brainRef: string }) => row.brainRef);
}

export async function hasAnyBrainSourceForIntegration(
  integrationId: string,
  db: DbLike = getDb(),
): Promise<boolean> {
  const rows = await db
    .select({ id: goatBrainSources.id })
    .from(goatBrainSources)
    .where(eq(goatBrainSources.integrationId, integrationId))
    .limit(1);
  return rows.length > 0;
}

export async function upsertGoatBrainSource(input: {
  brainRef: string;
  provider: GoatBrainSourceConfigProvider;
  integrationId: string;
  userWorkosId: string;
  createdByWorkosId: string;
  enabled: boolean;
  // Provider-specific routing config (e.g. selected Slack channels). Left out
  // of the conflict update when omitted so enable/disable toggles don't wipe
  // an existing selection.
  config?: Record<string, unknown>;
  now?: Date;
  db?: DbLike;
}): Promise<{ id: string }> {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();

  const [row] = await db
    .insert(goatBrainSources)
    .values({
      id: newGoatBrainSourceId(),
      brainId: input.brainRef,
      provider: input.provider,
      integrationId: input.integrationId,
      userWorkosId: input.userWorkosId,
      createdByWorkosId: input.createdByWorkosId,
      enabled: input.enabled,
      ...(input.config !== undefined ? { config: input.config } : {}),
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [goatBrainSources.brainId, goatBrainSources.integrationId],
      set: {
        enabled: input.enabled,
        ...(input.config !== undefined ? { config: input.config } : {}),
        updatedAt: now,
      },
    })
    .returning({ id: goatBrainSources.id });

  if (!row) throw new Error("Could not persist Goat Brain source.");
  return { id: row.id };
}

export async function deleteGoatBrainSource(input: {
  brainRef: string;
  sourceId: string;
  db?: DbLike;
}): Promise<boolean> {
  const db = input.db ?? getDb();
  const rows = await db
    .delete(goatBrainSources)
    .where(
      and(eq(goatBrainSources.id, input.sourceId), eq(goatBrainSources.brainId, input.brainRef)),
    )
    .returning({ id: goatBrainSources.id });
  return rows.length > 0;
}

// The actor's personal (workspace_id IS NULL) connections for one provider —
// the pool of accounts they can attach to a brain. Excludes disconnected rows
// and the Linear MCP connector row (provider "linear" is shared with MCP; only
// the ingest connection keyed on the organization id can feed brains).
export async function listGoatPersonalIntegrationAccounts(input: {
  userWorkosId: string;
  provider: GoatBrainSourceConfigProvider;
  excludeExternalId?: string;
  db?: DbLike;
}): Promise<
  Array<{
    integrationId: string;
    status: GoatIntegrationStatus;
    accountEmail: string | null;
    accountName: string | null;
    connectionLabel: string | null;
    externalId: string;
  }>
> {
  const db = input.db ?? getDb();
  const rows = await db
    .select({
      integrationId: goatIntegrations.id,
      status: goatIntegrations.status,
      accountEmail: goatIntegrations.accountEmail,
      accountName: goatIntegrations.accountName,
      connectionLabel: goatIntegrations.connectionLabel,
      externalId: goatIntegrations.externalId,
    })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.userWorkosId, input.userWorkosId),
        eq(goatIntegrations.provider, input.provider),
        isNull(goatIntegrations.workspaceId),
        ne(goatIntegrations.status, "disconnected"),
        ...(input.excludeExternalId
          ? [ne(goatIntegrations.externalId, input.excludeExternalId)]
          : []),
      ),
    )
    .orderBy(goatIntegrations.createdAt);
  return rows;
}

export function newGoatBrainSourceId() {
  return `gbscfg_${randomUUID().replace(/-/g, "")}`;
}
