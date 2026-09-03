import { randomUUID } from "node:crypto";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { NeonHttpDatabase } from "drizzle-orm/neon-http";
import { getDb } from "./client";
import {
  type BrainSourceConfigProvider,
  brainSources,
  type IntegrationStatus,
  integrations,
  users,
} from "./product-schema";

type DbLike = any;

// The opencompany web app uses neon-http, which cannot open interactive transactions.
// Run multi-statement mutations sequentially there; pooled runner callers still
// get a real transaction.
function runAtomically<T>(db: DbLike, fn: (tx: DbLike) => Promise<T>): Promise<T> {
  if (db instanceof NeonHttpDatabase) return fn(db);
  if (typeof db.transaction !== "function") return fn(db);
  return db.transaction(fn);
}

export const BRAIN_SOURCE_DISABLED_INGEST_REASON =
  "Stopped because this Brain source was disabled.";

export type BrainSourceWithIntegration = {
  id: string;
  brainRef: string;
  provider: BrainSourceConfigProvider;
  integrationId: string;
  userWorkosId: string;
  enabled: boolean;
  config: Record<string, unknown>;
  integrationStatus: IntegrationStatus;
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

export async function listBrainSourcesForBrain(
  brainRef: string,
  db: DbLike = getDb(),
): Promise<BrainSourceWithIntegration[]> {
  const rows = await db
    .select({
      id: brainSources.id,
      brainRef: brainSources.brainId,
      provider: brainSources.provider,
      integrationId: brainSources.integrationId,
      userWorkosId: brainSources.userWorkosId,
      enabled: brainSources.enabled,
      config: brainSources.config,
      integrationStatus: integrations.status,
      integrationAccountName: integrations.accountName,
      integrationAccountEmail: integrations.accountEmail,
      integrationConnectionLabel: integrations.connectionLabel,
      integrationWorkspaceId: integrations.workspaceId,
      ownerFirstName: users.firstName,
      ownerLastName: users.lastName,
      ownerEmail: users.email,
      ownerAvatarUrl: users.avatarUrl,
    })
    .from(brainSources)
    .innerJoin(integrations, eq(brainSources.integrationId, integrations.id))
    .innerJoin(users, eq(brainSources.userWorkosId, users.workosUserId))
    .where(eq(brainSources.brainId, brainRef));

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
    .select({ brainRef: brainSources.brainId })
    .from(brainSources)
    .where(and(eq(brainSources.integrationId, integrationId), eq(brainSources.enabled, true)));
  return rows.map((row: { brainRef: string }) => row.brainRef);
}

export async function hasAnyBrainSourceForIntegration(
  integrationId: string,
  db: DbLike = getDb(),
): Promise<boolean> {
  const rows = await db
    .select({ id: brainSources.id })
    .from(brainSources)
    .where(eq(brainSources.integrationId, integrationId))
    .limit(1);
  return rows.length > 0;
}

export async function upsertBrainSource(input: {
  brainRef: string;
  provider: BrainSourceConfigProvider;
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
}): Promise<{ id: string; created: boolean }> {
  if (!input.db) {
    const db = getDb();
    return await runAtomically(db, (tx) => upsertBrainSource({ ...input, db: tx }));
  }
  const db = input.db;
  const now = input.now ?? new Date();

  const values = {
    id: newBrainSourceId(),
    brainId: input.brainRef,
    provider: input.provider,
    integrationId: input.integrationId,
    userWorkosId: input.userWorkosId,
    createdByWorkosId: input.createdByWorkosId,
    enabled: input.enabled,
    ...(input.config !== undefined ? { config: input.config } : {}),
    updatedAt: now,
  };
  const [inserted] = await db
    .insert(brainSources)
    .values(values)
    .onConflictDoNothing({
      target: [brainSources.brainId, brainSources.integrationId],
    })
    .returning({ id: brainSources.id });

  const [row] = inserted
    ? [inserted]
    : await db
        .update(brainSources)
        .set({
          enabled: input.enabled,
          ...(input.config !== undefined ? { config: input.config } : {}),
          updatedAt: now,
        })
        .where(
          and(
            eq(brainSources.brainId, input.brainRef),
            eq(brainSources.integrationId, input.integrationId),
          ),
        )
        .returning({ id: brainSources.id });

  if (!row) throw new Error("Could not persist opencompany Brain source.");
  if (!input.enabled) {
    await cancelActiveBrainIngestJobsForSource({
      brainRef: input.brainRef,
      integrationId: input.integrationId,
      now,
      db,
    });
  }
  return { id: row.id, created: Boolean(inserted) };
}

export async function setBrainSourceEnabled(input: {
  brainRef: string;
  sourceId: string;
  enabled: boolean;
  now?: Date;
  db?: DbLike;
}): Promise<boolean> {
  if (!input.db) {
    const db = getDb();
    return await runAtomically(db, (tx) => setBrainSourceEnabled({ ...input, db: tx }));
  }
  const db = input.db;
  const now = input.now ?? new Date();
  const [source] = await db
    .update(brainSources)
    .set({ enabled: input.enabled, updatedAt: now })
    .where(and(eq(brainSources.id, input.sourceId), eq(brainSources.brainId, input.brainRef)))
    .returning({
      id: brainSources.id,
      integrationId: brainSources.integrationId,
    });
  if (!source) return false;
  if (!input.enabled) {
    await cancelActiveBrainIngestJobsForSource({
      brainRef: input.brainRef,
      integrationId: source.integrationId,
      now,
      db,
    });
  }
  return true;
}

export async function deleteBrainSource(input: {
  brainRef: string;
  sourceId: string;
  db?: DbLike;
}): Promise<boolean> {
  if (!input.db) {
    const db = getDb();
    return await runAtomically(db, (tx) => deleteBrainSource({ ...input, db: tx }));
  }
  const db = input.db;
  const now = new Date();
  const rows = await db
    .delete(brainSources)
    .where(and(eq(brainSources.id, input.sourceId), eq(brainSources.brainId, input.brainRef)))
    .returning({ id: brainSources.id, integrationId: brainSources.integrationId });
  const source = rows[0];
  if (source) {
    await cancelActiveBrainIngestJobsForSource({
      brainRef: input.brainRef,
      integrationId: source.integrationId,
      now,
      db,
    });
  }
  return rows.length > 0;
}

async function cancelActiveBrainIngestJobsForSource(input: {
  brainRef: string;
  integrationId: string;
  now: Date;
  db: DbLike;
}) {
  const reason = BRAIN_SOURCE_DISABLED_INGEST_REASON;
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
            'reason', ${reason}::text,
            'summary', ${reason}::text
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
export async function listPersonalIntegrationAccounts(input: {
  userWorkosId: string;
  provider: BrainSourceConfigProvider;
  excludeExternalId?: string;
  db?: DbLike;
}): Promise<
  Array<{
    integrationId: string;
    status: IntegrationStatus;
    accountEmail: string | null;
    accountName: string | null;
    connectionLabel: string | null;
    externalId: string;
  }>
> {
  const db = input.db ?? getDb();
  const rows = await db
    .select({
      integrationId: integrations.id,
      status: integrations.status,
      accountEmail: integrations.accountEmail,
      accountName: integrations.accountName,
      connectionLabel: integrations.connectionLabel,
      externalId: integrations.externalId,
    })
    .from(integrations)
    .where(
      and(
        eq(integrations.userWorkosId, input.userWorkosId),
        eq(integrations.provider, input.provider),
        isNull(integrations.workspaceId),
        ne(integrations.status, "disconnected"),
        ...(input.excludeExternalId ? [ne(integrations.externalId, input.excludeExternalId)] : []),
      ),
    )
    .orderBy(integrations.createdAt);
  return rows;
}

export function newBrainSourceId() {
  return `gbscfg_${randomUUID().replace(/-/g, "")}`;
}
