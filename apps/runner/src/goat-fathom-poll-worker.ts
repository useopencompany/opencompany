import { captureGoatIngestionQuotaAnalytics } from "@opencompany/analytics/goat";
import {
  attributeGoatBrainSourceEventClaims,
  claimGoatBrainSourceEvents,
  listGoatBrainSourceEventClaimedBrainRefs,
} from "@opencompany/db/goat-brain-event-claims";
import {
  GOAT_BRAIN_AGENT_INGEST_JOB_KIND,
  upsertGoatBrainSourceItemAndEnqueue,
} from "@opencompany/db/goat-brain-ingest";
import {
  claimGoatFathomSyncState,
  completeGoatFathomSyncPages,
  ensureGoatFathomSyncState,
  GOAT_FATHOM_CREDENTIAL_KIND,
  GOAT_FATHOM_PROVIDER,
  goatFathomEventClaimKey,
  listEnabledGoatFathomBrainSourceRoutes,
  updateGoatFathomSyncCursor,
  updateGoatFathomSyncPage,
} from "@opencompany/db/goat-fathom";
import {
  loadGoatIntegrationCredential,
  markGoatIntegrationStatus,
} from "@opencompany/db/goat-integrations";
import { normalizeFathomMeeting } from "@opencompany/goat-brain";
import { captureException, createLogger } from "@opencompany/observability";
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import { type FathomMeetingSummary, isFathomAuthError, listFathomMeetings } from "./fathom-api";
import { wakeGoatBrainIngestWorker } from "./goat-brain-ingest-worker";
import { rowsFromExecute } from "./sql-exec";

const logger = createLogger({ service: "opencompany-runner", runtime: "goat-fathom-poll" });

// Fathom has no webhooks for these per-user API keys, so new meetings are
// discovered by polling GET /external/v1/meetings per connected integration
// with a created_after cursor. A meeting is listed as soon as the recording
// exists, potentially before Fathom finishes its transcript and summary, so
// each pass caps the window at now minus a processing lag and only advances
// the cursor to that bound — a meeting is never ingested younger than the lag.
export const GOAT_FATHOM_POLL_INTERVAL_MS = 5 * 60_000;
// A claim stamps last_polled_at; other runner replicas skip integrations
// claimed within the cooldown. Brain event claims absorb any residual
// double-poll race.
export const GOAT_FATHOM_POLL_COOLDOWN_MS = 4 * 60_000;
// Recordings surface with their transcript and summary within a few minutes
// of a meeting ending; this lag keeps the window comfortably behind that.
export const GOAT_FATHOM_PROCESSING_LAG_MS = 15 * 60_000;
// Runaway guard on cursor pagination within one poll pass. Meetings are
// low-volume; anything beyond this is drained by later polls because the
// cursor only advances past processed windows.
const GOAT_FATHOM_MAX_PAGES_PER_POLL = 5;

type FathomPollCandidate = {
  integrationId: string;
  userWorkosId: string;
};

export async function listGoatFathomPollCandidates(): Promise<FathomPollCandidate[]> {
  const result = await getDb().execute(sql`
    SELECT
      i.id AS "integrationId",
      i.user_workos_id AS "userWorkosId"
    FROM goat.integrations i
    WHERE i.provider = 'fathom'
      AND i.status = 'connected'
      AND EXISTS (
        SELECT 1 FROM goat.brain_sources bs
        WHERE bs.integration_id = i.id
          AND bs.provider = 'fathom'
          AND bs.enabled = true
      )
  `);
  return rowsFromExecute<FathomPollCandidate>(result);
}

export async function pollGoatFathomIntegration(input: {
  candidate: FathomPollCandidate;
  signal: AbortSignal;
  cooldownMs?: number;
  processingLagMs?: number;
}): Promise<{ enqueued: number; seen: number } | null> {
  const { candidate } = input;
  const db = getDb();
  await ensureGoatFathomSyncState(
    {
      integrationId: candidate.integrationId,
      userWorkosId: candidate.userWorkosId,
    },
    db,
  );
  const state = await claimGoatFathomSyncState(
    {
      integrationId: candidate.integrationId,
      cooldownMs: input.cooldownMs ?? GOAT_FATHOM_POLL_COOLDOWN_MS,
    },
    db,
  );
  if (!state) return null;

  // First poll after connect: anchor the cursor at "now" — no backfill.
  if (!state.createdAfterCursor) {
    await updateGoatFathomSyncCursor(
      { integrationId: candidate.integrationId, createdAfterCursor: new Date() },
      db,
    );
    return { enqueued: 0, seen: 0 };
  }

  // Continuation cursors are only valid for the filters they were minted with,
  // so a resumed pass reuses the persisted window bound; a fresh pass lags
  // "now" to give Fathom time to finish transcripts and summaries.
  const processingLagMs = input.processingLagMs ?? GOAT_FATHOM_PROCESSING_LAG_MS;
  const createdBefore =
    (state.pageCursor ? state.pendingCreatedBeforeCursor : null) ??
    new Date(Date.now() - processingLagMs);
  if (createdBefore <= state.createdAfterCursor) return { enqueued: 0, seen: 0 };

  const credential = await loadGoatIntegrationCredential({
    userWorkosId: candidate.userWorkosId,
    integrationId: candidate.integrationId,
    provider: GOAT_FATHOM_PROVIDER,
    kind: GOAT_FATHOM_CREDENTIAL_KIND,
  });
  const apiKey =
    credential && typeof credential.payload.apiKey === "string" ? credential.payload.apiKey : null;
  if (!apiKey) {
    await markFathomNeedsReauth(candidate, "The saved Fathom API key could not be loaded.");
    return null;
  }

  let batch: FathomMeetingsBatch;
  try {
    batch = await listFathomMeetingsWindow({
      apiKey,
      createdAfter: state.createdAfterCursor.toISOString(),
      createdBefore: createdBefore.toISOString(),
      ...(state.pageCursor ? { cursor: state.pageCursor } : {}),
      signal: input.signal,
    });
  } catch (error) {
    if (isFathomAuthError(error)) {
      await markFathomNeedsReauth(candidate, "Fathom rejected the saved API key.");
      return null;
    }
    throw error;
  }
  const { meetings } = batch;

  const routes = await listEnabledGoatFathomBrainSourceRoutes([candidate.integrationId], db);
  const routedBrainRefs = [...new Set(routes.map((route) => route.brainRef))];

  let enqueued = 0;
  for (const meeting of meetings) {
    if (input.signal.aborted) throw new Error("Fathom poll aborted.");
    const result = await ingestFathomMeeting({
      candidate,
      meeting,
      routedBrainRefs,
    });
    if (result.enqueued) enqueued += 1;
  }

  // The timestamp watermark only advances after the final page. When a pass
  // reaches its page cap, persist Fathom's opaque continuation cursor along
  // with the window bound it was minted for; a later poll resumes without
  // skipping the pages that have not been processed yet.
  if (batch.nextCursor) {
    await updateGoatFathomSyncPage(
      {
        integrationId: candidate.integrationId,
        expectedCreatedAfterCursor: state.createdAfterCursor,
        expectedPageCursor: state.pageCursor,
        pageCursor: batch.nextCursor,
        pendingCreatedBeforeCursor: createdBefore,
      },
      db,
    );
  } else {
    // The whole (created_after, created_before] window was listed, so the
    // bound is safe to advance to even when the window held no meetings.
    await completeGoatFathomSyncPages(
      {
        integrationId: candidate.integrationId,
        expectedCreatedAfterCursor: state.createdAfterCursor,
        expectedPageCursor: state.pageCursor,
        createdAfterCursor: createdBefore,
      },
      db,
    );
  }
  return { enqueued, seen: meetings.length };
}

type FathomMeetingsBatch = {
  meetings: FathomMeetingSummary[];
  nextCursor: string | null;
};

export async function listFathomMeetingsWindow(input: {
  apiKey: string;
  createdAfter: string;
  createdBefore: string;
  cursor?: string;
  signal: AbortSignal;
  listMeetings?: typeof listFathomMeetings;
}): Promise<FathomMeetingsBatch> {
  const meetings: FathomMeetingSummary[] = [];
  const callListMeetings = input.listMeetings ?? listFathomMeetings;
  let cursor = input.cursor;
  const seenCursors = new Set(cursor ? [cursor] : []);
  for (let page = 0; page < GOAT_FATHOM_MAX_PAGES_PER_POLL; page += 1) {
    const result = await callListMeetings({
      apiKey: input.apiKey,
      createdAfter: input.createdAfter,
      createdBefore: input.createdBefore,
      ...(cursor ? { cursor } : {}),
      signal: input.signal,
    });
    meetings.push(...result.meetings);
    if (!result.nextCursor) return { meetings, nextCursor: null };
    if (seenCursors.has(result.nextCursor)) {
      throw new Error("Fathom pagination did not return a new continuation cursor.");
    }
    seenCursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  logger.info("Goat Fathom poll hit the page cap; saved continuation for next poll", {
    event: "opencompany.goat_fathom_poll_page_cap",
    meeting_count: meetings.length,
  });
  return { meetings, nextCursor: cursor ?? null };
}

async function ingestFathomMeeting(input: {
  candidate: FathomPollCandidate;
  meeting: FathomMeetingSummary;
  routedBrainRefs: readonly string[];
}): Promise<{ enqueued: boolean }> {
  const { candidate, meeting } = input;
  const db = getDb();
  const eventKey = goatFathomEventClaimKey(meeting.recordingId);

  // Cheap pre-check before normalization: a meeting every routed brain has
  // already claimed (e.g. an overlapping window replay) is a no-op.
  const alreadyClaimed = await listGoatBrainSourceEventClaimedBrainRefs({
    brainRefs: input.routedBrainRefs,
    sourceProvider: GOAT_FATHOM_PROVIDER,
    eventKey,
    db,
  });
  const pendingBrainRefs = input.routedBrainRefs.filter(
    (brainRef) => !alreadyClaimed.has(brainRef),
  );
  if (pendingBrainRefs.length === 0) return { enqueued: false };

  // The list call already carries transcript, summary, and action items —
  // Fathom needs no per-meeting detail fetch.
  const payload = meeting.raw;
  const item = normalizeFathomMeeting(payload, { capturedAt: new Date().toISOString() });

  const result = await db.transaction(async (tx: any) => {
    const brainRefs: string[] = [];
    const claimedEventKeysByBrainRef = new Map<string, string[]>();
    for (const brainRef of pendingBrainRefs) {
      const { claimedEventKeys } = await claimGoatBrainSourceEvents({
        brainRef,
        sourceProvider: GOAT_FATHOM_PROVIDER,
        eventKeys: [eventKey],
        db: tx,
      });
      if (claimedEventKeys.length === 0) continue;
      brainRefs.push(brainRef);
      claimedEventKeysByBrainRef.set(brainRef, claimedEventKeys);
    }
    if (brainRefs.length === 0) return null;

    const upserted = await upsertGoatBrainSourceItemAndEnqueue({
      userWorkosId: candidate.userWorkosId,
      sourceConnectionId: candidate.integrationId,
      integrationId: candidate.integrationId,
      item,
      rawPayload: payload,
      rawEventKeysByBrainRef: claimedEventKeysByBrainRef,
      kind: GOAT_BRAIN_AGENT_INGEST_JOB_KIND,
      brainRefs,
      db: tx,
    });
    for (const brainRef of brainRefs) {
      await attributeGoatBrainSourceEventClaims({
        brainRef,
        sourceProvider: GOAT_FATHOM_PROVIDER,
        eventKeys: claimedEventKeysByBrainRef.get(brainRef) ?? [],
        sourceItemId: upserted.sourceItemId,
        db: tx,
      });
    }
    return upserted;
  });

  captureGoatIngestionQuotaAnalytics(result?.quotaUpdates);
  if (result?.enqueued) wakeGoatBrainIngestWorker();
  return { enqueued: Boolean(result?.enqueued) };
}

async function markFathomNeedsReauth(candidate: FathomPollCandidate, reason: string) {
  logger.warn("Goat Fathom integration needs a new API key", {
    event: "opencompany.goat_fathom_needs_reauth",
    integration_id: candidate.integrationId,
  });
  await markGoatIntegrationStatus({
    userWorkosId: candidate.userWorkosId,
    integrationId: candidate.integrationId,
    provider: GOAT_FATHOM_PROVIDER,
    status: "needs_reauth",
    statusReason: reason,
    now: new Date(),
  });
}

export function startGoatFathomPollWorker(options: { pollIntervalMs?: number } = {}) {
  const pollIntervalMs = Math.max(1_000, options.pollIntervalMs ?? GOAT_FATHOM_POLL_INTERVAL_MS);
  const abort = new AbortController();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let wake: (() => void) | null = null;

  const sleep = () =>
    new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        wake = null;
        resolve();
      }, pollIntervalMs);
      timer.unref?.();
      wake = () => {
        if (timer) clearTimeout(timer);
        wake = null;
        resolve();
      };
    });

  const loop = (async () => {
    while (!stopped) {
      try {
        const candidates = await listGoatFathomPollCandidates();
        for (const candidate of candidates) {
          if (stopped) break;
          const polled = await pollGoatFathomIntegration({
            candidate,
            signal: abort.signal,
          }).catch((error) => {
            captureException(error, {
              event: "opencompany.goat_fathom_poll_failed",
              integration_id: candidate.integrationId,
            });
            logger.error("Goat Fathom integration poll failed", {
              event: "opencompany.goat_fathom_poll_failed",
              integration_id: candidate.integrationId,
              error,
            });
            return null;
          });
          if (polled && polled.enqueued > 0) {
            logger.info("Goat Fathom meetings enqueued", {
              event: "opencompany.goat_fathom_meetings_enqueued",
              integration_id: candidate.integrationId,
              enqueued_count: polled.enqueued,
              seen_count: polled.seen,
            });
          }
        }
      } catch (error) {
        captureException(error, { event: "opencompany.goat_fathom_poll_worker_failed" });
        logger.error("Goat Fathom poll worker failed", {
          event: "opencompany.goat_fathom_poll_worker_failed",
          error,
        });
      }
      if (stopped) break;
      await sleep();
    }
  })();

  return {
    notify: () => wake?.(),
    stop: async () => {
      stopped = true;
      abort.abort();
      wake?.();
      await loop;
    },
  };
}
