import { randomUUID } from "node:crypto";
import { and, eq, type SQL, sql } from "drizzle-orm";
import { NeonHttpDatabase } from "drizzle-orm/neon-http";
import { getDb } from "./client";
import {
  type IntegrationStatus,
  integrations,
  users,
  type WikiSourceProvider,
  wikiSources,
} from "./product-schema";

type DbLike = any;

// The neon-http client cannot open interactive transactions. Pooled runner
// callers still get a real transaction around source mutation + cancellation.
function runAtomically<T>(db: DbLike, fn: (tx: DbLike) => Promise<T>): Promise<T> {
  if (db instanceof NeonHttpDatabase) return fn(db);
  if (typeof db.transaction !== "function") return fn(db);
  return db.transaction(fn);
}

export const WIKI_SOURCE_DISABLED_INGEST_REASON = "Stopped because this wiki source was disabled.";

export type WikiSourceWithIntegration = {
  id: string;
  workspaceId: string;
  provider: WikiSourceProvider;
  integrationId: string;
  userWorkosId: string;
  enabled: boolean;
  config: Record<string, unknown>;
  integrationStatus: IntegrationStatus;
  integrationAccountName: string | null;
  integrationAccountEmail: string | null;
  integrationConnectionLabel: string | null;
  integrationWorkspaceId: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  ownerAvatarUrl: string | null;
};

export async function listWikiSourcesForWorkspace(
  workspaceId: string,
  db: DbLike = getDb(),
): Promise<WikiSourceWithIntegration[]> {
  return listWikiSourcesWhere(eq(wikiSources.workspaceId, workspaceId), db);
}

export async function listEnabledWikiSourcesForIntegration(
  integrationId: string,
  db: DbLike = getDb(),
): Promise<WikiSourceWithIntegration[]> {
  const where = and(eq(wikiSources.integrationId, integrationId), eq(wikiSources.enabled, true));
  if (!where) return [];
  return listWikiSourcesWhere(where, db);
}

export async function upsertWikiSource(input: {
  workspaceId: string;
  provider: WikiSourceProvider;
  integrationId: string;
  userWorkosId: string;
  createdByWorkosId: string;
  enabled: boolean;
  config?: Record<string, unknown>;
  now?: Date;
  db?: DbLike;
}): Promise<{ id: string; created: boolean }> {
  if (!input.db) {
    const db = getDb();
    return runAtomically(db, (tx) => upsertWikiSource({ ...input, db: tx }));
  }
  const db = input.db;
  const now = input.now ?? new Date();
  const values = {
    id: newWikiSourceId(),
    workspaceId: input.workspaceId,
    provider: input.provider,
    integrationId: input.integrationId,
    userWorkosId: input.userWorkosId,
    createdByWorkosId: input.createdByWorkosId,
    enabled: input.enabled,
    ...(input.config !== undefined ? { config: input.config } : {}),
    updatedAt: now,
  };
  const [inserted] = await db
    .insert(wikiSources)
    .values(values)
    .onConflictDoNothing({
      target: [wikiSources.workspaceId, wikiSources.integrationId],
    })
    .returning({ id: wikiSources.id });

  const [row] = inserted
    ? [inserted]
    : await db
        .update(wikiSources)
        .set({
          enabled: input.enabled,
          ...(input.config !== undefined ? { config: input.config } : {}),
          updatedAt: now,
        })
        .where(
          and(
            eq(wikiSources.workspaceId, input.workspaceId),
            eq(wikiSources.integrationId, input.integrationId),
          ),
        )
        .returning({ id: wikiSources.id });

  if (!row) throw new Error("Could not persist opencompany wiki source.");
  if (!input.enabled) {
    await cancelActiveWikiIngestJobsForSource({
      workspaceId: input.workspaceId,
      integrationId: input.integrationId,
      now,
      db,
    });
  }
  return { id: row.id, created: Boolean(inserted) };
}

export async function setWikiSourceEnabled(input: {
  workspaceId: string;
  sourceId: string;
  enabled: boolean;
  now?: Date;
  db?: DbLike;
}): Promise<boolean> {
  if (!input.db) {
    const db = getDb();
    return runAtomically(db, (tx) => setWikiSourceEnabled({ ...input, db: tx }));
  }
  const db = input.db;
  const now = input.now ?? new Date();
  const [source] = await db
    .update(wikiSources)
    .set({ enabled: input.enabled, updatedAt: now })
    .where(and(eq(wikiSources.id, input.sourceId), eq(wikiSources.workspaceId, input.workspaceId)))
    .returning({
      id: wikiSources.id,
      integrationId: wikiSources.integrationId,
    });
  if (!source) return false;
  if (!input.enabled) {
    await cancelActiveWikiIngestJobsForSource({
      workspaceId: input.workspaceId,
      integrationId: source.integrationId,
      now,
      db,
    });
  }
  return true;
}

export async function deleteWikiSource(input: {
  workspaceId: string;
  sourceId: string;
  now?: Date;
  db?: DbLike;
}): Promise<boolean> {
  if (!input.db) {
    const db = getDb();
    return runAtomically(db, (tx) => deleteWikiSource({ ...input, db: tx }));
  }
  const db = input.db;
  const now = input.now ?? new Date();
  const [source] = await db
    .delete(wikiSources)
    .where(and(eq(wikiSources.id, input.sourceId), eq(wikiSources.workspaceId, input.workspaceId)))
    .returning({ id: wikiSources.id, integrationId: wikiSources.integrationId });
  if (!source) return false;
  await cancelActiveWikiIngestJobsForSource({
    workspaceId: input.workspaceId,
    integrationId: source.integrationId,
    now,
    db,
  });
  return true;
}

async function listWikiSourcesWhere(where: SQL, db: DbLike): Promise<WikiSourceWithIntegration[]> {
  const rows = await db
    .select({
      id: wikiSources.id,
      workspaceId: wikiSources.workspaceId,
      provider: wikiSources.provider,
      integrationId: wikiSources.integrationId,
      userWorkosId: wikiSources.userWorkosId,
      enabled: wikiSources.enabled,
      config: wikiSources.config,
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
    .from(wikiSources)
    .innerJoin(integrations, eq(wikiSources.integrationId, integrations.id))
    .innerJoin(users, eq(wikiSources.userWorkosId, users.workosUserId))
    .where(where);

  return rows.map((row: (typeof rows)[number]) => ({
    id: row.id,
    workspaceId: row.workspaceId,
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

async function cancelActiveWikiIngestJobsForSource(input: {
  workspaceId: string;
  integrationId: string;
  now: Date;
  db: DbLike;
}) {
  const reason = WIKI_SOURCE_DISABLED_INGEST_REASON;
  await input.db.execute(sql`
    WITH canceled_jobs AS MATERIALIZED (
      UPDATE goat.wiki_ingest_jobs AS job
      SET status = 'skipped',
          lease_id = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          heartbeat_at = NULL,
          last_error = NULL,
          skip_reason = ${reason},
          result = job.result || jsonb_build_object(
            'skipped', true,
            'reason', ${reason},
            'summary', ${reason}
          ),
          completed_at = ${input.now},
          updated_at = ${input.now}
      WHERE job.workspace_id = ${input.workspaceId}
        AND job.integration_id = ${input.integrationId}
        AND job.status IN ('queued', 'running')
      RETURNING job.id, job.source_item_id
    )
    UPDATE goat.wiki_source_items AS source
    SET last_ingest_status = 'skipped',
        last_ingested_at = ${input.now},
        last_ingest_error = ${reason},
        updated_at = ${input.now}
    FROM canceled_jobs AS job
    WHERE source.id = job.source_item_id
      AND source.last_ingest_job_id = job.id
  `);
}

export function newWikiSourceId() {
  return `gwscfg_${randomUUID().replace(/-/g, "")}`;
}
