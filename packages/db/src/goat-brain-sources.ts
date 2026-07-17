import { randomUUID } from "node:crypto";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { getDb } from "./client";
import {
  type GoatBrainSourceConfigProvider,
  type GoatIntegrationStatus,
  goatBrainSources,
  goatIntegrations,
  goatUsers,
} from "./goat-schema";

type DbLike = any;

export const GOAT_BRAIN_SOURCE_DISABLED_INGEST_REASON =
  "Stopped because this Brain source was disabled.";

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
  if (!input.db) {
    return await getDb().transaction((tx) => upsertGoatBrainSource({ ...input, db: tx }));
  }
  const db = input.db;
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
  if (!input.enabled) {
    await cancelActiveGoatBrainIngestJobsForSource({
      brainRef: input.brainRef,
      integrationId: input.integrationId,
      now,
      db,
    });
  }
  return { id: row.id };
}

export async function setGoatBrainSourceEnabled(input: {
  brainRef: string;
  sourceId: string;
  enabled: boolean;
  now?: Date;
  db?: DbLike;
}): Promise<boolean> {
  if (!input.db) {
    return await getDb().transaction((tx) => setGoatBrainSourceEnabled({ ...input, db: tx }));
  }
  const db = input.db;
  const now = input.now ?? new Date();
  const [source] = await db
    .update(goatBrainSources)
    .set({ enabled: input.enabled, updatedAt: now })
    .where(
      and(eq(goatBrainSources.id, input.sourceId), eq(goatBrainSources.brainId, input.brainRef)),
    )
    .returning({
      id: goatBrainSources.id,
      integrationId: goatBrainSources.integrationId,
    });
  if (!source) return false;
  if (!input.enabled) {
    await cancelActiveGoatBrainIngestJobsForSource({
      brainRef: input.brainRef,
      integrationId: source.integrationId,
      now,
      db,
    });
  }
  return true;
}

export async function deleteGoatBrainSource(input: {
  brainRef: string;
  sourceId: string;
  db?: DbLike;
}): Promise<boolean> {
  if (!input.db) {
    return await getDb().transaction((tx) => deleteGoatBrainSource({ ...input, db: tx }));
  }
  const db = input.db;
  const now = new Date();
  const rows = await db
    .delete(goatBrainSources)
    .where(
      and(eq(goatBrainSources.id, input.sourceId), eq(goatBrainSources.brainId, input.brainRef)),
    )
    .returning({ id: goatBrainSources.id, integrationId: goatBrainSources.integrationId });
  const source = rows[0];
  if (source) {
    await cancelActiveGoatBrainIngestJobsForSource({
      brainRef: input.brainRef,
      integrationId: source.integrationId,
      now,
      db,
    });
  }
  return rows.length > 0;
}

async function cancelActiveGoatBrainIngestJobsForSource(input: {
  brainRef: string;
  integrationId: string;
  now: Date;
  db: DbLike;
}) {
  const reason = GOAT_BRAIN_SOURCE_DISABLED_INGEST_REASON;
  await input.db.execute(sql`
    WITH canceled_jobs AS MATERIALIZED (
      UPDATE goat.brain_ingest_jobs AS job
      SET status = 'skipped',
          plan_paused = false,
          lease_id = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error = NULL,
          result = job.result || jsonb_build_object(
            'skipped', true,
            'reason', ${reason},
            'summary', ${reason}
          ),
          completed_at = ${input.now},
          updated_at = ${input.now}
      WHERE job.brain_ref = ${input.brainRef}
        AND job.integration_id = ${input.integrationId}
        AND job.status IN ('queued', 'running')
      RETURNING job.id, job.source_item_id
    )
    UPDATE goat.brain_source_items AS source
    SET last_ingest_status = 'skipped',
        last_ingested_at = ${input.now},
        last_ingest_error = ${reason},
        updated_at = ${input.now}
    FROM canceled_jobs AS job
    WHERE source.id = job.source_item_id
      AND source.last_ingest_job_id = job.id
      AND NOT EXISTS (
        SELECT 1
        FROM goat.brain_ingest_jobs AS other
        WHERE other.source_item_id = source.id
          AND other.id <> job.id
          AND other.status IN ('queued', 'running')
      )
  `);
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
