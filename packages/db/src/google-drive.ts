import { randomUUID } from "node:crypto";
import { and, asc, eq, or, sql } from "drizzle-orm";
import { getDb } from "./client";
import {
  brainSources,
  googleDriveFileStates,
  googleDriveSyncCursors,
  googleDriveWatchChannels,
} from "./schema";

type DbLike = any;

export const GOOGLE_DRIVE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
export const GOOGLE_DRIVE_QUIET_MS = 5 * 60_000;
export const GOOGLE_DRIVE_FORCE_MS = 30 * 60_000;
export const GOOGLE_DRIVE_MAX_FILE_ATTEMPTS = 5;

export type GoogleDriveCorpusKey = "user" | `drive:${string}`;
export type GoogleDriveResourceKind = "file" | "folder";
export type GoogleDriveResourceRef = {
  id: string;
  name: string;
  kind: GoogleDriveResourceKind;
  mimeType: string;
  driveId: string | null;
  corpusKey: GoogleDriveCorpusKey;
  webViewLink: string | null;
  selectedAt: string;
};

export type GoogleDriveAllFilesRef = {
  selectedAt: string;
};

export type GoogleDriveSourceConfig = {
  allFiles?: GoogleDriveAllFilesRef;
  resources: GoogleDriveResourceRef[];
};

export function readGoogleDriveAllFiles(config: unknown): GoogleDriveAllFilesRef | null {
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;
  const allFiles = (config as Record<string, unknown>).allFiles;
  if (!allFiles || typeof allFiles !== "object" || Array.isArray(allFiles)) return null;
  const selectedAt = readIso((allFiles as Record<string, unknown>).selectedAt);
  return selectedAt ? { selectedAt } : null;
}

export function readGoogleDriveResources(config: unknown): GoogleDriveResourceRef[] {
  if (!config || typeof config !== "object" || Array.isArray(config)) return [];
  const resources = (config as Record<string, unknown>).resources;
  if (!Array.isArray(resources)) return [];
  const seen = new Set<string>();
  const result: GoogleDriveResourceRef[] = [];
  for (const value of resources) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    const id = readNonEmpty(row.id);
    const name = readNonEmpty(row.name);
    const mimeType = readNonEmpty(row.mimeType);
    const selectedAt = readIso(row.selectedAt);
    const corpusKey = readCorpusKey(row.corpusKey);
    const kind = row.kind === "file" || row.kind === "folder" ? row.kind : null;
    if (!id || !name || !mimeType || !selectedAt || !corpusKey || !kind || seen.has(id)) continue;
    seen.add(id);
    result.push({
      id,
      name,
      kind,
      mimeType,
      driveId: readNonEmpty(row.driveId),
      corpusKey,
      webViewLink: readNonEmpty(row.webViewLink),
      selectedAt,
    });
  }
  return result;
}

export async function upsertGoogleDriveSyncCursor(input: {
  integrationId: string;
  userWorkosId: string;
  corpusKey: GoogleDriveCorpusKey;
  driveId: string | null;
  pageToken: string;
  webhookAddress: string;
  now?: Date;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  await db
    .insert(googleDriveSyncCursors)
    .values({
      id: newGoogleDriveCursorId(),
      integrationId: input.integrationId,
      userWorkosId: input.userWorkosId,
      corpusKey: input.corpusKey,
      driveId: input.driveId,
      pageToken: input.pageToken,
      webhookAddress: input.webhookAddress,
      wakeRequestedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [googleDriveSyncCursors.integrationId, googleDriveSyncCursors.corpusKey],
      // Never reset an existing durable cursor when another brain selects the
      // same corpus; only refresh routing metadata and request a prompt drain.
      set: {
        driveId: input.driveId,
        webhookAddress: input.webhookAddress,
        wakeRequestedAt: now,
        updatedAt: now,
      },
    });
  const [cursor] = await db
    .select()
    .from(googleDriveSyncCursors)
    .where(
      and(
        eq(googleDriveSyncCursors.integrationId, input.integrationId),
        eq(googleDriveSyncCursors.corpusKey, input.corpusKey),
      ),
    )
    .limit(1);
  if (!cursor) throw new Error("Could not persist Google Drive sync cursor.");
  return cursor;
}

export async function listGoogleDriveSyncCursors(db: DbLike = getDb()) {
  return db.select().from(googleDriveSyncCursors).orderBy(asc(googleDriveSyncCursors.id));
}

export async function claimNextGoogleDriveSyncCursor(input: {
  leaseId: string;
  leaseOwner: string;
  leaseExpiresAt: Date;
  reconcileBefore: Date;
  now?: Date;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const result = await db.execute(sql`
    WITH candidate AS (
      SELECT cursor.id
      FROM goat.google_drive_sync_cursors cursor
      JOIN goat.integrations integration ON integration.id = cursor.integration_id
      WHERE integration.provider = 'google_drive'
        AND integration.status = 'connected'
        AND (cursor.wake_requested_at IS NOT NULL OR cursor.last_polled_at IS NULL OR cursor.last_polled_at <= ${input.reconcileBefore})
        AND (cursor.lease_expires_at IS NULL OR cursor.lease_expires_at <= ${now})
        AND EXISTS (
          SELECT 1
          FROM goat.brain_sources source
          WHERE source.integration_id = cursor.integration_id
            AND source.provider = 'google_drive'
            AND source.enabled = true
        )
      ORDER BY cursor.wake_requested_at NULLS LAST, cursor.last_polled_at NULLS FIRST, cursor.created_at
      FOR UPDATE OF cursor SKIP LOCKED
      LIMIT 1
    )
    UPDATE goat.google_drive_sync_cursors cursor
    SET lease_id = ${input.leaseId},
        lease_owner = ${input.leaseOwner},
        lease_expires_at = ${input.leaseExpiresAt},
        updated_at = ${now}
    FROM candidate
    WHERE cursor.id = candidate.id
    RETURNING
      cursor.id,
      cursor.integration_id AS "integrationId",
      cursor.user_workos_id AS "userWorkosId",
      cursor.corpus_key AS "corpusKey",
      cursor.drive_id AS "driveId",
      cursor.page_token AS "pageToken",
      cursor.webhook_address AS "webhookAddress",
      cursor.wake_requested_at AS "wakeRequestedAt",
      cursor.lease_id AS "leaseId",
      cursor.last_polled_at AS "lastPolledAt"
  `);
  return rowsFromExecute<Record<string, unknown>>(result)[0] ?? null;
}

export async function releaseGoogleDriveSyncCursor(input: {
  cursorId: string;
  leaseId: string;
  pageToken?: string;
  clearWakeThrough?: Date;
  lastPolledAt: Date;
  lastSuccessfulAt?: Date;
  lastResetAt?: Date;
  lastError?: string | null;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  const [released] = await db
    .update(googleDriveSyncCursors)
    .set({
      ...(input.pageToken !== undefined ? { pageToken: input.pageToken } : {}),
      ...(input.clearWakeThrough
        ? {
            wakeRequestedAt: sql`CASE WHEN ${googleDriveSyncCursors.wakeRequestedAt} <= ${input.clearWakeThrough} THEN NULL ELSE ${googleDriveSyncCursors.wakeRequestedAt} END`,
          }
        : {}),
      lastPolledAt: input.lastPolledAt,
      ...(input.lastSuccessfulAt ? { lastSuccessfulAt: input.lastSuccessfulAt } : {}),
      ...(input.lastResetAt ? { lastResetAt: input.lastResetAt } : {}),
      ...(input.lastError !== undefined ? { lastError: input.lastError } : {}),
      leaseId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: input.lastPolledAt,
    })
    .where(
      and(
        eq(googleDriveSyncCursors.id, input.cursorId),
        eq(googleDriveSyncCursors.leaseId, input.leaseId),
      ),
    )
    .returning({ id: googleDriveSyncCursors.id });
  return Boolean(released);
}

export async function advanceGoogleDriveSyncCursor(input: {
  cursorId: string;
  leaseId: string;
  pageToken: string;
  leaseExpiresAt: Date;
  now?: Date;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const [advanced] = await db
    .update(googleDriveSyncCursors)
    .set({
      pageToken: input.pageToken,
      leaseExpiresAt: input.leaseExpiresAt,
      updatedAt: now,
    })
    .where(
      and(
        eq(googleDriveSyncCursors.id, input.cursorId),
        eq(googleDriveSyncCursors.leaseId, input.leaseId),
      ),
    )
    .returning({ id: googleDriveSyncCursors.id });
  return Boolean(advanced);
}

export async function updateGoogleDriveSyncCursor(input: {
  cursorId: string;
  pageToken?: string;
  wakeRequestedAt?: Date | null;
  lastPolledAt?: Date;
  lastSuccessfulAt?: Date;
  lastResetAt?: Date;
  lastError?: string | null;
  now?: Date;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  await db
    .update(googleDriveSyncCursors)
    .set({
      ...(input.pageToken !== undefined ? { pageToken: input.pageToken } : {}),
      ...(input.wakeRequestedAt !== undefined ? { wakeRequestedAt: input.wakeRequestedAt } : {}),
      ...(input.lastPolledAt ? { lastPolledAt: input.lastPolledAt } : {}),
      ...(input.lastSuccessfulAt ? { lastSuccessfulAt: input.lastSuccessfulAt } : {}),
      ...(input.lastResetAt ? { lastResetAt: input.lastResetAt } : {}),
      ...(input.lastError !== undefined ? { lastError: input.lastError } : {}),
      updatedAt: now,
    })
    .where(eq(googleDriveSyncCursors.id, input.cursorId));
}

export async function loadGoogleDriveWatchChannel(channelId: string, db: DbLike = getDb()) {
  const [row] = await db
    .select({
      id: googleDriveWatchChannels.id,
      cursorId: googleDriveWatchChannels.cursorId,
      tokenHash: googleDriveWatchChannels.tokenHash,
      resourceId: googleDriveWatchChannels.resourceId,
      status: googleDriveWatchChannels.status,
      expiresAt: googleDriveWatchChannels.expiresAt,
    })
    .from(googleDriveWatchChannels)
    .where(eq(googleDriveWatchChannels.id, channelId))
    .limit(1);
  return row ?? null;
}

export async function requestGoogleDriveCursorWake(
  cursorId: string,
  now = new Date(),
  db: DbLike = getDb(),
) {
  await db
    .update(googleDriveSyncCursors)
    .set({ wakeRequestedAt: now, updatedAt: now })
    .where(eq(googleDriveSyncCursors.id, cursorId));
}

export async function createGoogleDriveWatchChannel(input: {
  id: string;
  cursorId: string;
  integrationId: string;
  tokenHash: string;
  expiresAt: Date;
  now?: Date;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  await db.insert(googleDriveWatchChannels).values({
    id: input.id,
    cursorId: input.cursorId,
    integrationId: input.integrationId,
    tokenHash: input.tokenHash,
    status: "creating",
    expiresAt: input.expiresAt,
    createdAt: now,
    updatedAt: now,
  });
}

export async function activateGoogleDriveWatchChannel(input: {
  id: string;
  resourceId: string;
  expiresAt: Date;
  now?: Date;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  await db
    .update(googleDriveWatchChannels)
    .set({
      resourceId: input.resourceId,
      expiresAt: input.expiresAt,
      status: "active",
      updatedAt: now,
    })
    .where(eq(googleDriveWatchChannels.id, input.id));
}

export async function stopGoogleDriveWatchChannel(
  id: string,
  now = new Date(),
  db: DbLike = getDb(),
) {
  await db
    .update(googleDriveWatchChannels)
    .set({ status: "stopped", updatedAt: now })
    .where(eq(googleDriveWatchChannels.id, id));
}

export async function listActiveGoogleDriveWatchChannels(cursorId: string, db: DbLike = getDb()) {
  return db
    .select()
    .from(googleDriveWatchChannels)
    .where(
      and(
        eq(googleDriveWatchChannels.cursorId, cursorId),
        or(
          eq(googleDriveWatchChannels.status, "creating"),
          eq(googleDriveWatchChannels.status, "active"),
        ),
      ),
    )
    .orderBy(asc(googleDriveWatchChannels.createdAt));
}

export async function observeGoogleDriveFile(input: {
  integrationId: string;
  userWorkosId: string;
  fileId: string;
  driveId: string | null;
  version: string;
  metadata: Record<string, unknown>;
  observedAt?: Date;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  const now = input.observedAt ?? new Date();
  const nextIngestAt = new Date(now.getTime() + GOOGLE_DRIVE_QUIET_MS);
  const forceIngestAt = new Date(now.getTime() + GOOGLE_DRIVE_FORCE_MS);
  await db
    .insert(googleDriveFileStates)
    .values({
      id: newGoogleDriveFileStateId(),
      integrationId: input.integrationId,
      userWorkosId: input.userWorkosId,
      fileId: input.fileId,
      driveId: input.driveId,
      observedVersion: input.version,
      metadata: input.metadata,
      firstObservedAt: now,
      lastObservedAt: now,
      nextIngestAt,
      forceIngestAt,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [googleDriveFileStates.integrationId, googleDriveFileStates.fileId],
      set: {
        driveId: input.driveId,
        observedVersion: input.version,
        metadata: input.metadata,
        lastObservedAt: now,
        nextIngestAt,
        // Preserve the start of an outstanding burst. Once caught up, start a
        // fresh thirty-minute ceiling for the next revision.
        firstObservedAt: sql`CASE WHEN ${googleDriveFileStates.observedVersion} = ${googleDriveFileStates.ingestedVersion} THEN ${now} ELSE ${googleDriveFileStates.firstObservedAt} END`,
        forceIngestAt: sql`CASE WHEN ${googleDriveFileStates.observedVersion} = ${googleDriveFileStates.ingestedVersion} THEN ${forceIngestAt} ELSE ${googleDriveFileStates.forceIngestAt} END`,
        attempts: sql`CASE WHEN ${googleDriveFileStates.observedVersion} <> ${input.version} THEN 0 ELSE ${googleDriveFileStates.attempts} END`,
        lastError: null,
        updatedAt: now,
      },
    });
}

export async function claimNextGoogleDriveFile(input: {
  leaseId: string;
  leaseOwner: string;
  leaseExpiresAt: Date;
  now?: Date;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const result = await db.execute(sql`
    WITH candidate AS (
      SELECT id
      FROM goat.google_drive_file_states
      WHERE observed_version <> COALESCE(ingested_version, '')
        AND attempts < ${GOOGLE_DRIVE_MAX_FILE_ATTEMPTS}
        AND (next_ingest_at <= ${now} OR force_ingest_at <= ${now})
        AND (lease_expires_at IS NULL OR lease_expires_at <= ${now})
      ORDER BY LEAST(next_ingest_at, force_ingest_at), created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE goat.google_drive_file_states state
    SET lease_id = ${input.leaseId},
        lease_owner = ${input.leaseOwner},
        lease_expires_at = ${input.leaseExpiresAt},
        attempts = state.attempts + 1,
        updated_at = ${now}
    FROM candidate
    WHERE state.id = candidate.id
    RETURNING
      state.id,
      state.integration_id AS "integrationId",
      state.user_workos_id AS "userWorkosId",
      state.file_id AS "fileId",
      state.drive_id AS "driveId",
      state.observed_version AS "observedVersion",
      state.ingested_version AS "ingestedVersion",
      state.metadata,
      state.first_observed_at AS "firstObservedAt",
      state.last_observed_at AS "lastObservedAt",
      state.lease_id AS "leaseId",
      state.attempts
  `);
  return rowsFromExecute<Record<string, unknown>>(result)[0] ?? null;
}

export async function completeGoogleDriveFile(input: {
  id: string;
  leaseId: string;
  claimedVersion: string;
  fetchedVersion: string;
  sourceItemId: string | null;
  now?: Date;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  await db
    .update(googleDriveFileStates)
    .set({
      observedVersion: sql`CASE WHEN ${googleDriveFileStates.observedVersion} = ${input.claimedVersion} THEN ${input.fetchedVersion} ELSE ${googleDriveFileStates.observedVersion} END`,
      ingestedVersion: input.fetchedVersion,
      lastSourceItemId: input.sourceItemId,
      leaseId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      attempts: 0,
      lastError: null,
      updatedAt: now,
    })
    .where(
      and(eq(googleDriveFileStates.id, input.id), eq(googleDriveFileStates.leaseId, input.leaseId)),
    );
}

export async function failGoogleDriveFile(input: {
  id: string;
  leaseId: string;
  error: string;
  retryAt: Date;
  now?: Date;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  await db
    .update(googleDriveFileStates)
    .set({
      leaseId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      nextIngestAt: input.retryAt,
      lastError: input.error.slice(0, 2_000),
      updatedAt: now,
    })
    .where(
      and(eq(googleDriveFileStates.id, input.id), eq(googleDriveFileStates.leaseId, input.leaseId)),
    );
}

export async function listEnabledGoogleDriveSources(integrationId: string, db: DbLike = getDb()) {
  const rows = await db
    .select({ brainRef: brainSources.brainId, config: brainSources.config })
    .from(brainSources)
    .where(
      and(
        eq(brainSources.integrationId, integrationId),
        eq(brainSources.provider, "google_drive"),
        eq(brainSources.enabled, true),
      ),
    );
  return rows.map((row: { brainRef: string; config: unknown }) => ({
    brainRef: row.brainRef,
    allFiles: readGoogleDriveAllFiles(row.config),
    resources: readGoogleDriveResources(row.config),
  }));
}

function readNonEmpty(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readIso(value: unknown) {
  const text = readNonEmpty(value);
  return text && Number.isFinite(new Date(text).getTime()) ? new Date(text).toISOString() : null;
}

function readCorpusKey(value: unknown): GoogleDriveCorpusKey | null {
  if (value === "user") return value;
  return typeof value === "string" && value.startsWith("drive:") && value.length > 6
    ? (value as `drive:${string}`)
    : null;
}

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    return Array.isArray(rows) ? (rows as T[]) : [];
  }
  return [];
}

export function newGoogleDriveCursorId() {
  return `ggdc_${randomUUID().replaceAll("-", "")}`;
}

export function newGoogleDriveFileStateId() {
  return `ggdf_${randomUUID().replaceAll("-", "")}`;
}
