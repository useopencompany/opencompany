import { createHash, randomBytes, randomUUID } from "node:crypto";
import { captureIngestionQuotaAnalytics } from "@opencompany/analytics/app";
import { normalizeGoogleDriveDocument } from "@opencompany/brain";
import {
  BRAIN_AGENT_INGEST_JOB_KIND,
  upsertBrainSourceItemAndEnqueue,
} from "@opencompany/db/brain-ingest";
import {
  activateGoogleDriveWatchChannel,
  advanceGoogleDriveSyncCursor,
  claimNextGoogleDriveFile,
  claimNextGoogleDriveSyncCursor,
  completeGoogleDriveFile,
  createGoogleDriveWatchChannel,
  failGoogleDriveFile,
  type GoogleDriveAllFilesRef,
  type GoogleDriveResourceRef,
  listActiveGoogleDriveWatchChannels,
  listEnabledGoogleDriveSources,
  observeGoogleDriveFile,
  releaseGoogleDriveSyncCursor,
  stopGoogleDriveWatchChannel,
} from "@opencompany/db/google-drive";
import { integrations } from "@opencompany/db/schema";
import { captureException, createLogger } from "@opencompany/observability";
import { eq } from "drizzle-orm";
import { wakeBrainIngestWorker } from "./brain-ingest-worker";
import { getDb } from "./db";
import type { RunnerEnv } from "./env";
import { type GoogleApiAccount, GoogleApiRequestError } from "./google-api-auth";
import {
  GOOGLE_DRIVE_FOLDER_MIME_TYPE,
  type GoogleDriveApiContext,
  type GoogleDriveFileMetadata,
  getGoogleDriveFileMetadata,
  getGoogleDriveStartPageToken,
  listGoogleDriveChanges,
  listGoogleDriveFolderChildren,
  readGoogleDriveDocument,
  watchGoogleDriveChanges,
} from "./google-drive-api";

const logger = createLogger({
  service: "opencompany-runner",
  runtime: "goat-google-drive-sync",
});

const POLL_INTERVAL_MS = 60_000;
const RECONCILIATION_INTERVAL_MS = 15 * 60_000;
const CURSOR_LEASE_MS = 10 * 60_000;
const FILE_LEASE_MS = 12 * 60_000;
const WATCH_LIFETIME_MS = 7 * 24 * 60 * 60_000;
const WATCH_RENEW_BEFORE_MS = 24 * 60 * 60_000;
const MAX_CURSOR_CLAIMS_PER_TICK = 20;
const MAX_FILE_CLAIMS_PER_TICK = 20;
const MAX_ANCESTRY_DEPTH = 100;
const MAX_DISCOVERED_DESCENDANTS = 5_000;

type ClaimedCursor = {
  id: string;
  integrationId: string;
  userWorkosId: string;
  driveId: string | null;
  pageToken: string;
  webhookAddress: string;
  wakeRequestedAt: Date | null;
  leaseId: string;
};

type ClaimedFile = {
  id: string;
  integrationId: string;
  userWorkosId: string;
  fileId: string;
  observedVersion: string;
  metadata: Record<string, unknown>;
  lastObservedAt: Date;
  leaseId: string;
  attempts: number;
};

type DriveRoute = {
  brainRef: string;
  allFiles: GoogleDriveAllFilesRef | null;
  resources: GoogleDriveResourceRef[];
};

let wakeup: (() => void) | null = null;

export function setGoogleDriveSyncWakeup(callback: (() => void) | null) {
  wakeup = callback;
}

export function wakeGoogleDriveSyncWorker() {
  wakeup?.();
}

export function startGoogleDriveSyncWorker(
  env: RunnerEnv,
  options: { pollIntervalMs?: number } = {},
) {
  const pollIntervalMs = Math.max(50, options.pollIntervalMs ?? POLL_INTERVAL_MS);
  let stopped = false;
  let running = false;
  let pendingWake = true;
  let wake: (() => void) | null = null;

  const notify = () => {
    if (wake) wake();
    else pendingWake = true;
  };

  const waitForPollOrWake = () => {
    if (pendingWake) {
      pendingWake = false;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, pollIntervalMs);
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });
  };

  const loop = (async () => {
    while (!stopped) {
      running = true;
      try {
        await runGoogleDriveTick(env);
      } catch (error) {
        captureException(error, { event: "opencompany.goat_google_drive_sync_worker_failed" });
        logger.error("Goat Google Drive sync worker failed", {
          event: "opencompany.goat_google_drive_sync_worker_failed",
          error,
        });
      } finally {
        running = false;
      }
      if (!stopped) await waitForPollOrWake();
    }
  })();

  return {
    notify,
    activeCount: () => (running ? 1 : 0),
    stop: async () => {
      stopped = true;
      notify();
      await loop;
    },
  };
}

async function runGoogleDriveTick(env: RunnerEnv) {
  for (let count = 0; count < MAX_CURSOR_CLAIMS_PER_TICK; count += 1) {
    const now = new Date();
    const row = await claimNextGoogleDriveSyncCursor({
      leaseId: `ggdc_lease_${randomUUID()}`,
      leaseOwner: env.instanceId,
      leaseExpiresAt: new Date(now.getTime() + CURSOR_LEASE_MS),
      reconcileBefore: new Date(now.getTime() - RECONCILIATION_INTERVAL_MS),
      now,
      db: getDb(),
    });
    if (!row) break;
    await syncClaimedCursor(env, row as ClaimedCursor);
  }

  for (let count = 0; count < MAX_FILE_CLAIMS_PER_TICK; count += 1) {
    const now = new Date();
    const row = await claimNextGoogleDriveFile({
      leaseId: `ggdf_lease_${randomUUID()}`,
      leaseOwner: env.instanceId,
      leaseExpiresAt: new Date(now.getTime() + FILE_LEASE_MS),
      now,
      db: getDb(),
    });
    if (!row) break;
    await processClaimedFile(env, row as ClaimedFile);
  }
}

async function syncClaimedCursor(env: RunnerEnv, cursor: ClaimedCursor) {
  const now = new Date();
  const context = await loadDriveContext(env, cursor.integrationId, cursor.userWorkosId);
  let pageToken = cursor.pageToken;
  let resetAt: Date | undefined;
  try {
    const routes: DriveRoute[] = await listEnabledGoogleDriveSources(cursor.integrationId, getDb());
    while (true) {
      const page = await listGoogleDriveChanges(context, {
        pageToken,
        driveId: cursor.driveId,
      });
      for (const change of page.changes) {
        await handleDriveChange(context, cursor.integrationId, routes, change);
      }
      if (page.nextPageToken) {
        pageToken = page.nextPageToken;
        const advanced = await advanceGoogleDriveSyncCursor({
          cursorId: cursor.id,
          leaseId: cursor.leaseId,
          pageToken,
          leaseExpiresAt: new Date(Date.now() + CURSOR_LEASE_MS),
          db: getDb(),
        });
        if (!advanced)
          throw new Error("Lost the Google Drive cursor lease while draining changes.");
        continue;
      }
      if (page.newStartPageToken) pageToken = page.newStartPageToken;
      break;
    }

    await ensureDriveWatchChannel(context, cursor, pageToken, now);
    await releaseGoogleDriveSyncCursor({
      cursorId: cursor.id,
      leaseId: cursor.leaseId,
      pageToken,
      ...(cursor.wakeRequestedAt ? { clearWakeThrough: cursor.wakeRequestedAt } : {}),
      lastPolledAt: now,
      lastSuccessfulAt: now,
      lastError: null,
      db: getDb(),
    });
  } catch (error) {
    if (error instanceof GoogleApiRequestError && error.status === 410) {
      pageToken = await getGoogleDriveStartPageToken(context, cursor.driveId);
      resetAt = new Date();
      logger.warn("Google Drive change cursor expired; anchored without backfill", {
        event: "opencompany.goat_google_drive_cursor_expired",
        integration_id: cursor.integrationId,
        cursor_id: cursor.id,
      });
    }
    await releaseGoogleDriveSyncCursor({
      cursorId: cursor.id,
      leaseId: cursor.leaseId,
      ...(resetAt ? { pageToken, lastResetAt: resetAt } : {}),
      ...(cursor.wakeRequestedAt ? { clearWakeThrough: cursor.wakeRequestedAt } : {}),
      lastPolledAt: new Date(),
      ...(resetAt
        ? {
            lastSuccessfulAt: resetAt,
            lastError: "Change cursor expired; skipped an unobservable sync gap.",
          }
        : { lastError: errorMessage(error) }),
      db: getDb(),
    });
    if (!resetAt) throw error;
  }
}

async function handleDriveChange(
  context: GoogleDriveApiContext,
  integrationId: string,
  routes: DriveRoute[],
  change: {
    fileId: string;
    removed: boolean;
    time: string | null;
    driveId: string | null;
    file: GoogleDriveFileMetadata | null;
  },
) {
  if (change.removed) return;
  let file = change.file;
  if (!file) {
    try {
      file = await getGoogleDriveFileMetadata(context, change.fileId);
    } catch (error) {
      if (isLostDriveAccess(error)) return;
      throw error;
    }
  }
  if (file.trashed) return;
  const observedAt = validDate(change.time) ?? new Date();
  const matching = await matchingDriveRoutes(context, routes, file, observedAt);
  if (matching.length === 0) return;

  if (file.mimeType !== GOOGLE_DRIVE_FOLDER_MIME_TYPE) {
    await observeDriveFile(integrationId, context.userWorkosId, file, observedAt);
    return;
  }

  // Never enumerate an explicitly selected folder on its own post-selection
  // metadata changes. A nested folder that newly appears inside a selected
  // tree is the bounded moved-subtree discovery case.
  const directlySelected = matching.some((route) =>
    route.resources.some((resource) => resource.kind === "folder" && resource.id === file!.id),
  );
  const matchedFolderSelection = matching.some((route) =>
    route.resources.some(
      (resource) => resource.kind === "folder" && selectedBefore(resource, observedAt),
    ),
  );
  if (!directlySelected && matchedFolderSelection) {
    await discoverMovedFolderDescendants(context, integrationId, routes, file, observedAt);
  }
}

async function discoverMovedFolderDescendants(
  context: GoogleDriveApiContext,
  integrationId: string,
  routes: DriveRoute[],
  root: GoogleDriveFileMetadata,
  observedAt: Date,
) {
  const queue = [root.id];
  let discovered = 0;
  while (queue.length > 0) {
    const folderId = queue.shift()!;
    for (const child of await listGoogleDriveFolderChildren(context, folderId)) {
      discovered += 1;
      if (discovered > MAX_DISCOVERED_DESCENDANTS) {
        throw new Error("Google Drive moved folder exceeds the 5,000-file discovery limit.");
      }
      if (child.mimeType === GOOGLE_DRIVE_FOLDER_MIME_TYPE) {
        queue.push(child.id);
      } else if ((await matchingDriveRoutes(context, routes, child, observedAt)).length > 0) {
        await observeDriveFile(integrationId, context.userWorkosId, child, observedAt);
      }
    }
  }
}

async function observeDriveFile(
  integrationId: string,
  userWorkosId: string,
  file: GoogleDriveFileMetadata,
  observedAt: Date,
) {
  await observeGoogleDriveFile({
    integrationId,
    userWorkosId,
    fileId: file.id,
    driveId: file.driveId,
    version: file.version,
    metadata: file,
    observedAt,
    db: getDb(),
  });
}

async function processClaimedFile(env: RunnerEnv, state: ClaimedFile) {
  const leaseId = state.leaseId;
  try {
    const context = await loadDriveContext(env, state.integrationId, state.userWorkosId);
    let file: GoogleDriveFileMetadata;
    try {
      file = await getGoogleDriveFileMetadata(context, state.fileId);
    } catch (error) {
      if (isLostDriveAccess(error)) {
        const routes: DriveRoute[] = await listEnabledGoogleDriveSources(
          state.integrationId,
          getDb(),
        );
        const eligibleRoutes = routes.filter(
          (route) =>
            isAllFilesSelectedBefore(route.allFiles, state.lastObservedAt) ||
            route.resources.some((resource) => selectedBefore(resource, state.lastObservedAt)),
        );
        const cached = cachedDriveMetadata(state);
        const skipped = normalizeGoogleDriveDocument({
          fileId: state.fileId,
          name: cached?.name ?? state.fileId,
          mimeType: cached?.mimeType ?? "application/octet-stream",
          ...(cached?.webViewLink ? { webViewLink: cached.webViewLink } : {}),
          ...(cached?.driveId ? { driveId: cached.driveId } : {}),
          modifiedTime: cached?.modifiedTime ?? state.lastObservedAt.toISOString(),
          version: state.observedVersion,
          extractedText: "",
          contentSha256: sha256(""),
          owners: cached?.owners ?? [],
          ...(cached?.lastModifyingUser ? { lastModifyingUser: cached.lastModifyingUser } : {}),
          capturedAt: new Date().toISOString(),
        });
        const upserted = await upsertBrainSourceItemAndEnqueue({
          userWorkosId: state.userWorkosId,
          sourceConnectionId: state.integrationId,
          integrationId: state.integrationId,
          item: skipped,
          rawPayload: {
            fileId: state.fileId,
            version: state.observedVersion,
            skipReason: "Google Drive no longer permits this file to be read.",
          },
          kind: BRAIN_AGENT_INGEST_JOB_KIND,
          brainRefs: uniqueStrings(eligibleRoutes.map((route) => route.brainRef)),
          skipReason: "Google Drive no longer permits this file to be read.",
        });
        captureIngestionQuotaAnalytics(upserted.quotaUpdates);
        await completeGoogleDriveFile({
          id: state.id,
          leaseId,
          claimedVersion: state.observedVersion,
          fetchedVersion: state.observedVersion,
          sourceItemId: upserted.sourceItemId,
          db: getDb(),
        });
        return;
      }
      throw error;
    }

    const routes: DriveRoute[] = await listEnabledGoogleDriveSources(state.integrationId, getDb());
    const matching = file.trashed
      ? []
      : await matchingDriveRoutes(context, routes, file, state.lastObservedAt);
    if (matching.length === 0) {
      await completeGoogleDriveFile({
        id: state.id,
        leaseId,
        claimedVersion: state.observedVersion,
        fetchedVersion: file.version,
        sourceItemId: null,
        db: getDb(),
      });
      return;
    }

    const content = await readGoogleDriveDocument(context, file);
    const skippedReason = content.ok ? null : content.reason;
    const capturedAt = new Date().toISOString();
    const item = normalizeGoogleDriveDocument({
      fileId: file.id,
      name: file.name,
      mimeType: file.mimeType,
      ...(file.webViewLink ? { webViewLink: file.webViewLink } : {}),
      ...(file.driveId ? { driveId: file.driveId } : {}),
      modifiedTime: file.modifiedTime,
      version: file.version,
      extractedText: content.ok ? content.extractedText : "",
      contentSha256: content.ok ? content.contentSha256 : sha256(""),
      owners: file.owners,
      ...(file.lastModifyingUser ? { lastModifyingUser: file.lastModifyingUser } : {}),
      capturedAt,
    });
    const upserted = await upsertBrainSourceItemAndEnqueue({
      userWorkosId: state.userWorkosId,
      sourceConnectionId: state.integrationId,
      integrationId: state.integrationId,
      item,
      rawPayload: {
        fileId: file.id,
        version: file.version,
        driveId: file.driveId,
        skipReason: skippedReason,
      },
      kind: BRAIN_AGENT_INGEST_JOB_KIND,
      brainRefs: uniqueStrings(matching.map((route) => route.brainRef)),
      skipReason: skippedReason,
    });
    captureIngestionQuotaAnalytics(upserted.quotaUpdates);
    await completeGoogleDriveFile({
      id: state.id,
      leaseId,
      claimedVersion: state.observedVersion,
      fetchedVersion: file.version,
      sourceItemId: upserted.sourceItemId,
      db: getDb(),
    });
    if (upserted.enqueued) wakeBrainIngestWorker();
  } catch (error) {
    const now = new Date();
    await failGoogleDriveFile({
      id: state.id,
      leaseId,
      error: errorMessage(error),
      retryAt: new Date(now.getTime() + retryDelayMs(state.attempts)),
      now,
      db: getDb(),
    });
    throw error;
  }
}

async function matchingDriveRoutes(
  context: GoogleDriveApiContext,
  routes: DriveRoute[],
  file: GoogleDriveFileMetadata,
  observedAt: Date,
) {
  const eligible = routes.filter(
    (route) =>
      (file.mimeType !== GOOGLE_DRIVE_FOLDER_MIME_TYPE &&
        isAllFilesSelectedBefore(route.allFiles, observedAt)) ||
      route.resources.some(
        (resource) => resource.id === file.id && selectedBefore(resource, observedAt),
      ),
  );
  const folderResources = routes.flatMap((route) =>
    route.resources
      .filter((resource) => resource.kind === "folder" && selectedBefore(resource, observedAt))
      .map((resource) => ({ route, resource })),
  );
  if (folderResources.length === 0 || file.parents.length === 0) return uniqueRoutes(eligible);

  const targetIds = new Set(folderResources.map(({ resource }) => resource.id));
  const ancestorIds = await collectDriveAncestorIds(context, file.parents, targetIds);
  for (const entry of folderResources) {
    if (ancestorIds.has(entry.resource.id)) eligible.push(entry.route);
  }
  return uniqueRoutes(eligible);
}

async function collectDriveAncestorIds(
  context: GoogleDriveApiContext,
  initialParents: string[],
  targetIds: Set<string>,
) {
  const found = new Set<string>();
  const visited = new Set<string>();
  const queue = [...initialParents];
  while (queue.length > 0 && visited.size < MAX_ANCESTRY_DEPTH) {
    const parentId = queue.shift()!;
    if (visited.has(parentId)) continue;
    visited.add(parentId);
    if (targetIds.has(parentId)) found.add(parentId);
    if (found.size === targetIds.size) break;
    try {
      const parent = await getGoogleDriveFileMetadata(context, parentId);
      queue.push(...parent.parents);
    } catch (error) {
      if (!isLostDriveAccess(error)) throw error;
    }
  }
  return found;
}

async function ensureDriveWatchChannel(
  context: GoogleDriveApiContext,
  cursor: ClaimedCursor,
  pageToken: string,
  now: Date,
) {
  if (!isPublicHttpsAddress(cursor.webhookAddress)) return;
  const existing = await listActiveGoogleDriveWatchChannels(cursor.id, getDb());
  for (const channel of existing) {
    if (channel.expiresAt && channel.expiresAt <= now) {
      await stopGoogleDriveWatchChannel(channel.id, now, getDb());
    }
  }
  const liveChannels = existing.filter(
    (channel: { expiresAt: Date | null }) => !channel.expiresAt || channel.expiresAt > now,
  );
  const renewAfter = new Date(now.getTime() + WATCH_RENEW_BEFORE_MS);
  if (
    liveChannels.some(
      (channel: { expiresAt: Date | null }) => channel.expiresAt && channel.expiresAt > renewAfter,
    )
  ) {
    return;
  }

  const channelId = randomUUID();
  const channelToken = randomBytes(32).toString("base64url");
  const requestedExpiry = new Date(now.getTime() + WATCH_LIFETIME_MS);
  await createGoogleDriveWatchChannel({
    id: channelId,
    cursorId: cursor.id,
    integrationId: cursor.integrationId,
    tokenHash: sha256(channelToken),
    expiresAt: requestedExpiry,
    now,
    db: getDb(),
  });
  try {
    const watched = await watchGoogleDriveChanges(context, {
      pageToken,
      driveId: cursor.driveId,
      channelId,
      channelToken,
      address: cursor.webhookAddress,
      expiresAt: requestedExpiry,
    });
    await activateGoogleDriveWatchChannel({
      id: channelId,
      resourceId: watched.resourceId,
      expiresAt: watched.expiresAt,
      db: getDb(),
    });
    // Keep the previous channel alive until its own expiry. Renewal overlap is
    // deliberate: either channel may race a change notification, and the
    // webhook reduces both to the same idempotent cursor wake.
  } catch (error) {
    await stopGoogleDriveWatchChannel(channelId, new Date(), getDb());
    logger.warn("Google Drive watch unavailable; reconciliation polling remains active", {
      event: "opencompany.goat_google_drive_watch_create_failed",
      cursor_id: cursor.id,
      error,
    });
  }
}

async function loadDriveContext(
  env: RunnerEnv,
  integrationId: string,
  userWorkosId: string,
): Promise<GoogleDriveApiContext> {
  const [integration] = await getDb()
    .select({ accountEmail: integrations.accountEmail })
    .from(integrations)
    .where(eq(integrations.id, integrationId))
    .limit(1);
  const account: GoogleApiAccount = {
    integrationId,
    provider: "google_drive",
    accountEmail: integration?.accountEmail ?? null,
  };
  return { env, userWorkosId, account, signal: new AbortController().signal };
}

function selectedBefore(resource: GoogleDriveResourceRef, observedAt: Date) {
  return new Date(resource.selectedAt).getTime() <= observedAt.getTime();
}

function isAllFilesSelectedBefore(allFiles: GoogleDriveAllFilesRef | null, observedAt: Date) {
  return Boolean(allFiles && new Date(allFiles.selectedAt).getTime() <= observedAt.getTime());
}

function cachedDriveMetadata(state: ClaimedFile): GoogleDriveFileMetadata | null {
  const value = state.metadata;
  if (
    typeof value.name !== "string" ||
    typeof value.mimeType !== "string" ||
    typeof value.modifiedTime !== "string"
  ) {
    return null;
  }
  return {
    id: state.fileId,
    name: value.name,
    mimeType: value.mimeType,
    driveId: typeof value.driveId === "string" ? value.driveId : null,
    webViewLink: typeof value.webViewLink === "string" ? value.webViewLink : null,
    parents: Array.isArray(value.parents)
      ? value.parents.filter((parent): parent is string => typeof parent === "string")
      : [],
    modifiedTime: value.modifiedTime,
    version: state.observedVersion,
    trashed: value.trashed === true,
    canDownload: value.canDownload !== false,
    owners: Array.isArray(value.owners)
      ? value.owners.filter((owner): owner is string => typeof owner === "string")
      : [],
    lastModifyingUser: typeof value.lastModifyingUser === "string" ? value.lastModifyingUser : null,
  };
}

function uniqueRoutes(routes: DriveRoute[]) {
  const byBrain = new Map(routes.map((route) => [route.brainRef, route]));
  return [...byBrain.values()];
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}

function retryDelayMs(attempts: number) {
  return Math.min(15 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));
}

function isLostDriveAccess(error: unknown) {
  return (
    error instanceof GoogleApiRequestError &&
    (error.status === 404 ||
      (error.status === 403 &&
        !/rateLimitExceeded|userRateLimitExceeded|backendError/i.test(error.message)))
  );
}

function validDate(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function isPublicHttpsAddress(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1"
    );
  } catch {
    return false;
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown Google Drive sync error.";
}
