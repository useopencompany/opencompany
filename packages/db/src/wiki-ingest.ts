import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { NeonHttpDatabase } from "drizzle-orm/neon-http";
import { reserveWorkspaceIngestion } from "./billing";
import { getDb } from "./client";
import { stringifyPostgresJson } from "./postgres-json";
import {
  type WikiIngestJob,
  type WikiIngestJobStatus,
  type WikiSourceProvider,
  type WikiSourceType,
  wikiIngestJobs,
  wikiSourceItems,
} from "./product-schema";

export type ActiveWikiSourceProvider = Exclude<WikiSourceProvider, "slack">;

type DbLike = any;

export const WIKI_INGEST_LEASE_TTL_MS = 5 * 60_000;
export const WIKI_INGEST_MAX_ATTEMPTS = 5;
const ATTEMPT_ERROR_MAX_CHARS = 500;

export type NormalizedWikiSourceItem<TContent = unknown> = {
  sourceProvider: ActiveWikiSourceProvider;
  sourceType: WikiSourceType;
  externalId: string;
  sourceRef: string;
  title: string | null;
  occurredAt: string;
  capturedAt: string;
  contentHash: string;
  contentHashInput?: unknown;
  content: TContent;
};

export type UpsertWikiSourceItemResult = {
  sourceItemId: string;
  jobId: string | null;
  enqueued: boolean;
  skipped: boolean;
  paused?: boolean;
  pendingUnits?: number;
};

type PersistedWikiIngestJob = {
  id: string;
  status: WikiIngestJobStatus;
  completedAt: Date | null;
  lastError: string | null;
  skipReason: string | null;
};

export type ClaimedWikiIngestJob = Omit<WikiIngestJob, "sourceProvider"> & {
  sourceProvider: ActiveWikiSourceProvider;
  sourceType: WikiSourceType;
  sourceRef: string;
  title: string | null;
  occurredAt: Date;
  rawPayload: unknown;
  normalizedPayload: unknown;
  rawEventCount: number;
};

export type WikiIngestActivityRow = {
  id: string;
  sourceProvider: WikiSourceProvider;
  sourceType: WikiSourceType;
  title: string | null;
  occurredAt: Date;
  status: WikiIngestJobStatus;
  attempts: number;
  lastError: string | null;
  skipReason: string | null;
  result: Record<string, unknown>;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export async function listWikiIngestActivityRows(input: {
  workspaceId: string;
  limit: number;
  before?: { createdAt: Date; id: string } | null;
  db?: DbLike;
}): Promise<WikiIngestActivityRow[]> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 101) {
    throw new Error("Wiki ingestion activity limit must be between 1 and 101.");
  }
  const db = input.db ?? getDb();
  const beforeCreatedAt = input.before?.createdAt ?? null;
  const beforeId = input.before?.id ?? null;
  const result = await db.execute(sql`
    SELECT
      job.id,
      job.source_provider AS "sourceProvider",
      source.source_type AS "sourceType",
      source.title,
      source.occurred_at AS "occurredAt",
      job.status,
      job.attempts,
      job.last_error AS "lastError",
      job.skip_reason AS "skipReason",
      job.result,
      job.completed_at AS "completedAt",
      job.created_at AS "createdAt",
      job.updated_at AS "updatedAt"
    FROM goat.wiki_ingest_jobs AS job
    INNER JOIN goat.wiki_source_items AS source
      ON source.id = job.source_item_id
     AND source.workspace_id = job.workspace_id
    WHERE job.workspace_id = ${input.workspaceId}
      AND job.source_provider <> 'slack'
      AND (
        ${beforeCreatedAt}::timestamptz IS NULL
        OR (job.created_at, job.id) < (${beforeCreatedAt}::timestamptz, ${beforeId})
      )
    ORDER BY job.created_at DESC, job.id DESC
    LIMIT ${input.limit}
  `);
  return rowsFromExecute<WikiIngestActivityRow>(result).map(normalizeWikiIngestActivityRowDates);
}

export async function upsertWikiSourceItemAndEnqueue(input: {
  workspaceId: string;
  sourceConnectionId: string;
  integrationId: string;
  item: NormalizedWikiSourceItem;
  rawPayload: unknown;
  skipReason?: string | null;
  rawEventCount?: number;
  now?: Date;
  db?: DbLike;
}): Promise<UpsertWikiSourceItemResult> {
  if (!input.db) {
    const db: DbLike = getDb();
    if (db instanceof NeonHttpDatabase || typeof db.transaction !== "function") {
      return upsertWikiSourceItemAndEnqueue({ ...input, db });
    }
    return db.transaction((tx: DbLike) => upsertWikiSourceItemAndEnqueue({ ...input, db: tx }));
  }

  const db = input.db;
  const now = input.now ?? new Date();
  const occurredAt = new Date(input.item.occurredAt);
  const capturedAt = new Date(input.item.capturedAt);
  const skipReason = input.skipReason?.trim() || null;
  const rawEventCount = input.rawEventCount ?? 1;
  if (!Number.isInteger(rawEventCount) || rawEventCount < 1 || rawEventCount > 200) {
    throw new Error("opencompany wiki ingestion raw event count must be between 1 and 200.");
  }

  const [sourceItem] = await db
    .insert(wikiSourceItems)
    .values({
      id: newWikiSourceItemId(),
      workspaceId: input.workspaceId,
      sourceProvider: input.item.sourceProvider,
      sourceConnectionId: input.sourceConnectionId,
      integrationId: input.integrationId,
      sourceType: input.item.sourceType,
      externalId: input.item.externalId,
      sourceRef: input.item.sourceRef,
      title: input.item.title,
      occurredAt,
      capturedAt,
      contentHash: input.item.contentHash,
      rawPayload: input.rawPayload,
      normalizedPayload: input.item,
      rawEventCount,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        wikiSourceItems.workspaceId,
        wikiSourceItems.sourceProvider,
        wikiSourceItems.sourceConnectionId,
        wikiSourceItems.sourceType,
        wikiSourceItems.externalId,
        wikiSourceItems.contentHash,
      ],
      set: {
        integrationId: input.integrationId,
        sourceRef: input.item.sourceRef,
        title: input.item.title,
        occurredAt,
        capturedAt,
        rawPayload: input.rawPayload,
        normalizedPayload: input.item,
        rawEventCount,
        updatedAt: now,
      },
    })
    .returning({ id: wikiSourceItems.id });

  if (!sourceItem) throw new Error("Could not persist opencompany wiki source item.");

  const [insertedJob] = await db
    .insert(wikiIngestJobs)
    .values({
      id: newWikiIngestJobId(),
      workspaceId: input.workspaceId,
      sourceItemId: sourceItem.id,
      sourceProvider: input.item.sourceProvider,
      sourceConnectionId: input.sourceConnectionId,
      integrationId: input.integrationId,
      contentHash: input.item.contentHash,
      status: skipReason ? "skipped" : "queued",
      nextRetryAt: now,
      skipReason,
      ...(skipReason
        ? {
            result: {
              skipped: true,
              reason: skipReason,
              summary: skipReason,
            },
            completedAt: now,
          }
        : {}),
      updatedAt: now,
    })
    .onConflictDoNothing({
      target: [wikiIngestJobs.sourceItemId, wikiIngestJobs.contentHash],
    })
    .returning({
      id: wikiIngestJobs.id,
      status: wikiIngestJobs.status,
      completedAt: wikiIngestJobs.completedAt,
      lastError: wikiIngestJobs.lastError,
      skipReason: wikiIngestJobs.skipReason,
    });

  let reservation: Awaited<ReturnType<typeof reserveWorkspaceIngestion>> | null = null;
  if (!skipReason) {
    reservation = await reserveWorkspaceIngestion({
      workspaceId: input.workspaceId,
      sourceItemId: sourceItem.id,
      sourceKind: "wiki",
      sourceProvider: input.item.sourceProvider,
      rawEventCount,
      now,
      db,
    });
  }

  const job = skipReason
    ? await transitionQueuedWikiIngestJobToSkipped({
        sourceItemId: sourceItem.id,
        contentHash: input.item.contentHash,
        reason: skipReason,
        now,
        db,
      })
    : (insertedJob ??
      (await findWikiIngestJob({
        sourceItemId: sourceItem.id,
        contentHash: input.item.contentHash,
        db,
      })));

  if (job) {
    await db
      .update(wikiSourceItems)
      .set({
        lastIngestJobId: job.id,
        lastIngestStatus: sourceItemStatusForJob(job.status),
        lastIngestedAt: sourceItemIngestedAtForJob(job, now),
        lastIngestError: sourceItemErrorForJob(job),
        updatedAt: now,
      })
      .where(eq(wikiSourceItems.id, sourceItem.id));
  }

  return {
    sourceItemId: sourceItem.id,
    jobId: job?.id ?? null,
    enqueued: Boolean(insertedJob) && !skipReason,
    skipped: Boolean(skipReason) && job?.status === "skipped",
    ...(reservation?.paused ? { paused: true, pendingUnits: reservation.pendingUnits } : {}),
  };
}

export async function claimNextWikiIngestJob(input: {
  leaseOwner: string;
  leaseId?: string;
  leaseTtlMs?: number;
  now?: Date;
  db?: DbLike;
}): Promise<ClaimedWikiIngestJob | null> {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const leaseId = input.leaseId ?? newWikiIngestLeaseId();
  const leaseExpiresAt = new Date(now.getTime() + (input.leaseTtlMs ?? WIKI_INGEST_LEASE_TTL_MS));
  let result: unknown;
  try {
    result = await db.execute(sql`
    WITH candidate AS (
      SELECT job.id
      FROM goat.wiki_ingest_jobs AS job
      INNER JOIN goat.workspace_ingestion_reservations AS reservation
        ON reservation.workspace_id = job.workspace_id
       AND reservation.wiki_source_item_id = job.source_item_id
       AND reservation.status = 'consumed'
      WHERE (
          (job.status = 'queued' AND job.next_retry_at <= ${now})
          OR (job.status = 'running' AND job.lease_expires_at < ${now})
        )
        AND job.source_provider <> 'slack'
        AND EXISTS (
          SELECT 1
          FROM goat.wiki_sources AS source
          WHERE source.workspace_id = job.workspace_id
            AND source.integration_id = job.integration_id
            AND source.provider = job.source_provider
            AND source.enabled = true
        )
        AND NOT EXISTS (
          SELECT 1
          FROM goat.wiki_ingest_jobs AS running
          WHERE running.workspace_id = job.workspace_id
            AND running.status = 'running'
            AND running.id <> job.id
        )
      ORDER BY job.next_retry_at ASC, job.created_at ASC
      FOR UPDATE OF job SKIP LOCKED
      LIMIT 1
    ),
    claimed AS (
      UPDATE goat.wiki_ingest_jobs AS job
      SET status = 'running',
          attempts = job.attempts + 1,
          lease_id = ${leaseId},
          lease_owner = ${input.leaseOwner},
          lease_expires_at = ${leaseExpiresAt},
          heartbeat_at = ${now},
          updated_at = ${now}
      FROM candidate
      WHERE job.id = candidate.id
      RETURNING ${wikiIngestJobColumnsSql}
    )
    SELECT
      claimed.*,
      source.source_type AS "sourceType",
      source.source_ref AS "sourceRef",
      source.title,
      source.occurred_at AS "occurredAt",
      source.raw_payload AS "rawPayload",
      source.normalized_payload AS "normalizedPayload",
      source.raw_event_count AS "rawEventCount"
    FROM claimed
    INNER JOIN goat.wiki_source_items AS source ON source.id = claimed."sourceItemId"
    `);
  } catch (error) {
    // The partial unique index is the final concurrency fence for two claims that observed the
    // same workspace before either transaction committed. The losing worker simply polls again.
    if (isUniqueViolation(error)) return null;
    throw error;
  }
  const claimed = rowsFromExecute<ClaimedWikiIngestJob>(result)[0];
  return claimed ? normalizeClaimedWikiIngestJobDates(claimed) : null;
}

export async function heartbeatWikiIngestJob(input: {
  id: string;
  leaseId: string;
  leaseOwner: string;
  leaseTtlMs?: number;
  now?: Date;
  db?: DbLike;
}): Promise<boolean> {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const leaseExpiresAt = new Date(now.getTime() + (input.leaseTtlMs ?? WIKI_INGEST_LEASE_TTL_MS));
  const result = await db.execute(sql`
    UPDATE goat.wiki_ingest_jobs
    SET lease_expires_at = ${leaseExpiresAt},
        heartbeat_at = ${now},
        updated_at = ${now}
    WHERE id = ${input.id}
      AND lease_id = ${input.leaseId}
      AND lease_owner = ${input.leaseOwner}
      AND status = 'running'
    RETURNING id
  `);
  return rowsFromExecute<{ id: string }>(result).length > 0;
}

// Hands an in-flight job back to the queue when a runner is shutting down.
// The claim increment is rolled back because the attempt was interrupted by
// infrastructure before it could produce an ingestion outcome.
export async function releaseWikiIngestJob(input: {
  id: string;
  sourceItemId: string;
  leaseId: string;
  leaseOwner: string;
  now?: Date;
  db?: DbLike;
}): Promise<boolean> {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const released = await db.execute(sql`
    UPDATE goat.wiki_ingest_jobs
    SET status = 'queued',
        attempts = GREATEST(attempts - 1, 0),
        lease_id = NULL,
        lease_owner = NULL,
        lease_expires_at = NULL,
        heartbeat_at = NULL,
        next_retry_at = ${now},
        updated_at = ${now}
    WHERE id = ${input.id}
      AND source_item_id = ${input.sourceItemId}
      AND lease_id = ${input.leaseId}
      AND lease_owner = ${input.leaseOwner}
      AND status = 'running'
    RETURNING id
  `);
  return rowsFromExecute<{ id: string }>(released).length > 0;
}

export async function completeWikiIngestJob(input: {
  id: string;
  sourceItemId: string;
  leaseId: string;
  leaseOwner: string;
  result: Record<string, unknown>;
  traceRef?: string | null;
  now?: Date;
  db?: DbLike;
}): Promise<boolean> {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const resultJson = stringifyPostgresJson(input.result);
  const completed = await db.execute(sql`
    WITH completed_job AS (
      UPDATE goat.wiki_ingest_jobs
      SET status = 'succeeded',
          lease_id = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          heartbeat_at = NULL,
          last_error = NULL,
          skip_reason = NULL,
          trace_ref = COALESCE(${input.traceRef ?? null}, trace_ref),
          result = ${resultJson}::jsonb
            || jsonb_strip_nulls(jsonb_build_object('attemptErrors', result->'attemptErrors')),
          completed_at = ${now},
          updated_at = ${now}
      WHERE id = ${input.id}
        AND source_item_id = ${input.sourceItemId}
        AND lease_id = ${input.leaseId}
        AND lease_owner = ${input.leaseOwner}
        AND status = 'running'
      RETURNING id, source_item_id
    ),
    updated_source AS (
      UPDATE goat.wiki_source_items AS source
      SET last_ingest_status = 'succeeded',
          last_ingested_at = ${now},
          last_ingest_error = NULL,
          updated_at = ${now}
      FROM completed_job
      WHERE source.id = completed_job.source_item_id
      RETURNING source.id
    )
    SELECT id FROM completed_job
  `);
  return rowsFromExecute<{ id: string }>(completed).length > 0;
}

export async function failWikiIngestJobWithBackoff(input: {
  id: string;
  sourceItemId: string;
  leaseId: string;
  leaseOwner: string;
  attempts: number;
  error: string;
  maxAttempts?: number;
  result?: Record<string, unknown>;
  traceRef?: string | null;
  now?: Date;
  db?: DbLike;
}): Promise<boolean> {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const terminal = input.attempts >= (input.maxAttempts ?? WIKI_INGEST_MAX_ATTEMPTS);
  const nextRetryAt = terminal ? now : wikiIngestRetryAt(now, input.attempts);
  const attemptErrorJson = stringifyPostgresJson([
    {
      attempt: input.attempts,
      at: now.toISOString(),
      error: input.error.slice(0, ATTEMPT_ERROR_MAX_CHARS),
    },
  ]);
  const failureResultJson = stringifyPostgresJson(input.result ?? {});
  const failed = await db.execute(sql`
    WITH failed_job AS (
      UPDATE goat.wiki_ingest_jobs
      SET status = ${terminal ? "failed" : "queued"},
          lease_id = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          heartbeat_at = NULL,
          next_retry_at = ${nextRetryAt},
          last_error = ${input.error},
          skip_reason = NULL,
          trace_ref = COALESCE(${input.traceRef ?? null}, trace_ref),
          result = result || ${failureResultJson}::jsonb || jsonb_build_object(
            'attemptErrors',
            COALESCE(result->'attemptErrors', '[]'::jsonb) || ${attemptErrorJson}::jsonb
          ),
          completed_at = ${terminal ? now : null},
          updated_at = ${now}
      WHERE id = ${input.id}
        AND source_item_id = ${input.sourceItemId}
        AND lease_id = ${input.leaseId}
        AND lease_owner = ${input.leaseOwner}
        AND status = 'running'
      RETURNING id, source_item_id
    ),
    updated_source AS (
      UPDATE goat.wiki_source_items AS source
      SET last_ingest_status = ${terminal ? "failed" : "pending"},
          last_ingested_at = ${terminal ? now : null},
          last_ingest_error = ${input.error},
          updated_at = ${now}
      FROM failed_job
      WHERE source.id = failed_job.source_item_id
      RETURNING source.id
    )
    SELECT id FROM failed_job
  `);
  return rowsFromExecute<{ id: string }>(failed).length > 0;
}

export async function skipWikiIngestJob(input: {
  id: string;
  sourceItemId: string;
  leaseId: string;
  leaseOwner: string;
  reason: string | null;
  result: Record<string, unknown>;
  traceRef?: string | null;
  now?: Date;
  db?: DbLike;
}): Promise<boolean> {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const reason = input.reason?.trim() || null;
  const resultJson = stringifyPostgresJson(input.result);
  const skipped = await db.execute(sql`
    WITH skipped_job AS (
      UPDATE goat.wiki_ingest_jobs
      SET status = 'skipped',
          lease_id = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          heartbeat_at = NULL,
          last_error = NULL,
          skip_reason = ${reason},
          trace_ref = COALESCE(${input.traceRef ?? null}, trace_ref),
          result = ${resultJson}::jsonb
            || jsonb_strip_nulls(jsonb_build_object('attemptErrors', result->'attemptErrors')),
          completed_at = ${now},
          updated_at = ${now}
      WHERE id = ${input.id}
        AND source_item_id = ${input.sourceItemId}
        AND lease_id = ${input.leaseId}
        AND lease_owner = ${input.leaseOwner}
        AND status = 'running'
      RETURNING id, source_item_id
    ),
    updated_source AS (
      UPDATE goat.wiki_source_items AS source
      SET last_ingest_status = 'skipped',
          last_ingested_at = ${now},
          last_ingest_error = ${reason},
          updated_at = ${now}
      FROM skipped_job
      WHERE source.id = skipped_job.source_item_id
      RETURNING source.id
    )
    SELECT id FROM skipped_job
  `);
  return rowsFromExecute<{ id: string }>(skipped).length > 0;
}

async function transitionQueuedWikiIngestJobToSkipped(input: {
  sourceItemId: string;
  contentHash: string;
  reason: string;
  now: Date;
  db: DbLike;
}): Promise<PersistedWikiIngestJob | null> {
  await input.db
    .update(wikiIngestJobs)
    .set({
      status: "skipped",
      lastError: null,
      skipReason: input.reason,
      result: { skipped: true, reason: input.reason, summary: input.reason },
      completedAt: input.now,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(wikiIngestJobs.sourceItemId, input.sourceItemId),
        eq(wikiIngestJobs.contentHash, input.contentHash),
        eq(wikiIngestJobs.status, "queued"),
      ),
    );
  return findWikiIngestJob(input);
}

async function findWikiIngestJob(input: {
  sourceItemId: string;
  contentHash: string;
  db: DbLike;
}): Promise<PersistedWikiIngestJob | null> {
  const [job] = await input.db
    .select({
      id: wikiIngestJobs.id,
      status: wikiIngestJobs.status,
      completedAt: wikiIngestJobs.completedAt,
      lastError: wikiIngestJobs.lastError,
      skipReason: wikiIngestJobs.skipReason,
    })
    .from(wikiIngestJobs)
    .where(
      and(
        eq(wikiIngestJobs.sourceItemId, input.sourceItemId),
        eq(wikiIngestJobs.contentHash, input.contentHash),
      ),
    )
    .limit(1);
  return job ?? null;
}

function sourceItemStatusForJob(status: WikiIngestJobStatus) {
  if (status === "queued" || status === "running") return "pending";
  return status;
}

function sourceItemIngestedAtForJob(job: PersistedWikiIngestJob, now: Date) {
  if (job.status === "queued" || job.status === "running") return null;
  return job.completedAt ?? now;
}

function sourceItemErrorForJob(job: PersistedWikiIngestJob) {
  if (job.status === "failed") return job.lastError;
  if (job.status === "skipped") return job.skipReason;
  return null;
}

export function wikiIngestRetryAt(now: Date, attempts: number) {
  const delayMs = Math.min(15 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));
  return new Date(now.getTime() + delayMs);
}

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: T[] }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

function normalizeClaimedWikiIngestJobDates(job: ClaimedWikiIngestJob): ClaimedWikiIngestJob {
  return {
    ...job,
    nextRetryAt: requiredDbDate(job.nextRetryAt, "nextRetryAt"),
    leaseExpiresAt: optionalDbDate(job.leaseExpiresAt, "leaseExpiresAt"),
    heartbeatAt: optionalDbDate(job.heartbeatAt, "heartbeatAt"),
    completedAt: optionalDbDate(job.completedAt, "completedAt"),
    createdAt: requiredDbDate(job.createdAt, "createdAt"),
    updatedAt: requiredDbDate(job.updatedAt, "updatedAt"),
    occurredAt: requiredDbDate(job.occurredAt, "occurredAt"),
  };
}

function normalizeWikiIngestActivityRowDates(row: WikiIngestActivityRow): WikiIngestActivityRow {
  return {
    ...row,
    occurredAt: requiredDbDate(row.occurredAt, "occurredAt"),
    completedAt: optionalDbDate(row.completedAt, "completedAt"),
    createdAt: requiredDbDate(row.createdAt, "createdAt"),
    updatedAt: requiredDbDate(row.updatedAt, "updatedAt"),
  };
}

function requiredDbDate(value: Date, field: string) {
  const date = value instanceof Date ? value : new Date(value as unknown as string);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`Claimed wiki ingest job has an invalid ${field} timestamp.`);
  }
  return date;
}

function optionalDbDate(value: Date | null, field: string) {
  return value === null ? null : requiredDbDate(value, field);
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; cause?: unknown };
  return value.code === "23505" || isUniqueViolation(value.cause);
}

const wikiIngestJobColumnsSql = sql`
  job.id,
  job.workspace_id AS "workspaceId",
  job.source_item_id AS "sourceItemId",
  job.source_provider AS "sourceProvider",
  job.source_connection_id AS "sourceConnectionId",
  job.integration_id AS "integrationId",
  job.content_hash AS "contentHash",
  job.status,
  job.attempts,
  job.next_retry_at AS "nextRetryAt",
  job.lease_id AS "leaseId",
  job.lease_owner AS "leaseOwner",
  job.lease_expires_at AS "leaseExpiresAt",
  job.heartbeat_at AS "heartbeatAt",
  job.last_error AS "lastError",
  job.skip_reason AS "skipReason",
  job.trace_ref AS "traceRef",
  job.result,
  job.completed_at AS "completedAt",
  job.created_at AS "createdAt",
  job.updated_at AS "updatedAt"
`;

export function newWikiSourceItemId() {
  return `gwsrc_${randomUUID().replace(/-/g, "")}`;
}

export function newWikiIngestJobId() {
  return `gwjob_${randomUUID().replace(/-/g, "")}`;
}

export function newWikiIngestLeaseId() {
  return `goat_wiki_ingest_${randomUUID()}`;
}
