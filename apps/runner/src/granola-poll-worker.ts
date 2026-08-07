import { captureIngestionQuotaAnalytics } from "@opencompany/analytics/app";
import { normalizeGranolaMeetingNote } from "@opencompany/brain";
import {
  attributeBrainSourceEventClaims,
  claimBrainSourceEvents,
  listBrainSourceEventClaimedBrainRefs,
} from "@opencompany/db/brain-event-claims";
import {
  BRAIN_AGENT_INGEST_JOB_KIND,
  upsertBrainSourceItemAndEnqueue,
} from "@opencompany/db/brain-ingest";
import {
  claimGranolaSyncState,
  completeGranolaSyncPages,
  ensureGranolaSyncState,
  GRANOLA_CREDENTIAL_KIND,
  GRANOLA_PROVIDER,
  granolaEventClaimKey,
  listEnabledGranolaBrainSourceRoutes,
  updateGranolaSyncCursor,
  updateGranolaSyncPage,
} from "@opencompany/db/granola";
import { loadIntegrationCredential, markIntegrationStatus } from "@opencompany/db/integrations";
import { captureException, createLogger } from "@opencompany/observability";
import { sql } from "drizzle-orm";
import { wakeBrainIngestWorker } from "./brain-ingest-worker";
import { getDb } from "./db";
import {
  fetchGranolaNote,
  type GranolaNoteSummary,
  isGranolaAuthError,
  listGranolaNotes,
} from "./granola-api";
import { rowsFromExecute } from "./sql-exec";

const logger = createLogger({ service: "opencompany-runner", runtime: "goat-granola-poll" });

// Granola has no webhooks, so new meeting notes are discovered by polling
// GET /v1/notes per connected integration with an updated_after cursor. Notes
// only surface once Granola finishes their AI summary and transcript, so
// updated_at (not created_at) is the watermark that never skips a
// late-finishing note.
export const GRANOLA_POLL_INTERVAL_MS = 5 * 60_000;
// A claim stamps last_polled_at; other runner replicas skip integrations
// claimed within the cooldown. Brain event claims absorb any residual
// double-poll race.
export const GRANOLA_POLL_COOLDOWN_MS = 4 * 60_000;
// Runaway guard on cursor pagination within one poll pass. Meetings are
// low-volume; anything beyond this is drained by later polls because the
// cursor only advances past processed notes.
const GRANOLA_MAX_PAGES_PER_POLL = 5;

type GranolaPollCandidate = {
  integrationId: string;
  userWorkosId: string;
};

export async function listGranolaPollCandidates(): Promise<GranolaPollCandidate[]> {
  const result = await getDb().execute(sql`
    SELECT
      i.id AS "integrationId",
      i.user_workos_id AS "userWorkosId"
    FROM goat.integrations i
    WHERE i.provider = 'granola'
      AND i.status = 'connected'
      AND EXISTS (
        SELECT 1 FROM goat.brain_sources bs
        WHERE bs.integration_id = i.id
          AND bs.provider = 'granola'
          AND bs.enabled = true
      )
  `);
  return rowsFromExecute<GranolaPollCandidate>(result);
}

export async function pollGranolaIntegration(input: {
  candidate: GranolaPollCandidate;
  signal: AbortSignal;
  cooldownMs?: number;
}): Promise<{ enqueued: number; seen: number } | null> {
  const { candidate } = input;
  const db = getDb();
  await ensureGranolaSyncState(
    {
      integrationId: candidate.integrationId,
      userWorkosId: candidate.userWorkosId,
    },
    db,
  );
  const state = await claimGranolaSyncState(
    {
      integrationId: candidate.integrationId,
      cooldownMs: input.cooldownMs ?? GRANOLA_POLL_COOLDOWN_MS,
    },
    db,
  );
  if (!state) return null;

  // First poll after connect: anchor the cursor at "now" — no backfill.
  if (!state.updatedAfterCursor) {
    await updateGranolaSyncCursor(
      { integrationId: candidate.integrationId, updatedAfterCursor: new Date() },
      db,
    );
    return { enqueued: 0, seen: 0 };
  }

  const credential = await loadIntegrationCredential({
    userWorkosId: candidate.userWorkosId,
    integrationId: candidate.integrationId,
    provider: GRANOLA_PROVIDER,
    kind: GRANOLA_CREDENTIAL_KIND,
  });
  const apiKey =
    credential && typeof credential.payload.apiKey === "string" ? credential.payload.apiKey : null;
  if (!apiKey) {
    await markGranolaNeedsReauth(candidate, "The saved Granola API key could not be loaded.");
    return null;
  }

  let batch: GranolaNotesBatch;
  try {
    batch = await listGranolaNotesSince({
      apiKey,
      updatedAfter: state.updatedAfterCursor.toISOString(),
      ...(state.pageCursor ? { cursor: state.pageCursor } : {}),
      signal: input.signal,
    });
  } catch (error) {
    if (isGranolaAuthError(error)) {
      await markGranolaNeedsReauth(candidate, "Granola rejected the saved API key.");
      return null;
    }
    throw error;
  }
  const { notes } = batch;

  const routes = await listEnabledGranolaBrainSourceRoutes([candidate.integrationId], db);
  const routedBrainRefs = [...new Set(routes.map((route) => route.brainRef))];

  let enqueued = 0;
  for (const note of notes) {
    if (input.signal.aborted) throw new Error("Granola poll aborted.");
    const result = await ingestGranolaNote({
      candidate,
      apiKey,
      note,
      routedBrainRefs,
      signal: input.signal,
    });
    if (result.enqueued) enqueued += 1;
  }

  // The timestamp watermark only advances after the final page. When a pass
  // reaches its page cap, persist Granola's opaque continuation cursor and the
  // highest timestamp seen so far; a later poll resumes without skipping the
  // pages that have not been processed yet.
  const batchMaxUpdatedAt = notes.reduce<Date | null>((max, note) => {
    if (!note.updatedAt) return max;
    const updatedAt = new Date(note.updatedAt);
    if (Number.isNaN(updatedAt.getTime())) return max;
    return !max || updatedAt > max ? updatedAt : max;
  }, null);
  const pendingUpdatedAfterCursor = latestDate(state.pendingUpdatedAfterCursor, batchMaxUpdatedAt);
  if (batch.nextCursor) {
    await updateGranolaSyncPage(
      {
        integrationId: candidate.integrationId,
        expectedUpdatedAfterCursor: state.updatedAfterCursor,
        expectedPageCursor: state.pageCursor,
        pageCursor: batch.nextCursor,
        pendingUpdatedAfterCursor,
      },
      db,
    );
  } else {
    await completeGranolaSyncPages(
      {
        integrationId: candidate.integrationId,
        expectedUpdatedAfterCursor: state.updatedAfterCursor,
        expectedPageCursor: state.pageCursor,
        updatedAfterCursor: pendingUpdatedAfterCursor ?? state.updatedAfterCursor,
      },
      db,
    );
  }
  return { enqueued, seen: notes.length };
}

type GranolaNotesBatch = {
  notes: GranolaNoteSummary[];
  nextCursor: string | null;
};

export async function listGranolaNotesSince(input: {
  apiKey: string;
  updatedAfter: string;
  cursor?: string;
  signal: AbortSignal;
  listNotes?: typeof listGranolaNotes;
}): Promise<GranolaNotesBatch> {
  const notes: GranolaNoteSummary[] = [];
  const callListNotes = input.listNotes ?? listGranolaNotes;
  let cursor = input.cursor;
  const seenCursors = new Set(cursor ? [cursor] : []);
  for (let page = 0; page < GRANOLA_MAX_PAGES_PER_POLL; page += 1) {
    const result = await callListNotes({
      apiKey: input.apiKey,
      updatedAfter: input.updatedAfter,
      ...(cursor ? { cursor } : {}),
      signal: input.signal,
    });
    notes.push(...result.notes);
    if (!result.hasMore) return { notes, nextCursor: null };
    if (!result.cursor || seenCursors.has(result.cursor)) {
      throw new Error("Granola pagination did not return a new continuation cursor.");
    }
    seenCursors.add(result.cursor);
    cursor = result.cursor;
  }
  logger.info("Goat Granola poll hit the page cap; saved continuation for next poll", {
    event: "opencompany.goat_granola_poll_page_cap",
    note_count: notes.length,
  });
  return { notes, nextCursor: cursor ?? null };
}

function latestDate(left: Date | null, right: Date | null) {
  if (!left) return right;
  if (!right) return left;
  return left > right ? left : right;
}

async function ingestGranolaNote(input: {
  candidate: GranolaPollCandidate;
  apiKey: string;
  note: GranolaNoteSummary;
  routedBrainRefs: readonly string[];
  signal: AbortSignal;
}): Promise<{ enqueued: boolean }> {
  const { candidate, note } = input;
  const db = getDb();
  const eventKey = granolaEventClaimKey(note.id);

  // Cheap pre-check before the transcript fetch: a note every routed brain has
  // already claimed (an earlier poll, or an edit bumping updated_at) is a no-op.
  const alreadyClaimed = await listBrainSourceEventClaimedBrainRefs({
    brainRefs: input.routedBrainRefs,
    sourceProvider: GRANOLA_PROVIDER,
    eventKey,
    db,
  });
  const pendingBrainRefs = input.routedBrainRefs.filter(
    (brainRef) => !alreadyClaimed.has(brainRef),
  );
  if (pendingBrainRefs.length === 0) return { enqueued: false };

  const payload = await fetchGranolaNote({
    apiKey: input.apiKey,
    noteId: note.id,
    signal: input.signal,
  });
  const item = normalizeGranolaMeetingNote(payload, { capturedAt: new Date().toISOString() });

  const result = await db.transaction(async (tx: any) => {
    const brainRefs: string[] = [];
    const claimedEventKeysByBrainRef = new Map<string, string[]>();
    for (const brainRef of pendingBrainRefs) {
      const { claimedEventKeys } = await claimBrainSourceEvents({
        brainRef,
        sourceProvider: GRANOLA_PROVIDER,
        eventKeys: [eventKey],
        db: tx,
      });
      if (claimedEventKeys.length === 0) continue;
      brainRefs.push(brainRef);
      claimedEventKeysByBrainRef.set(brainRef, claimedEventKeys);
    }
    if (brainRefs.length === 0) return null;

    const upserted = await upsertBrainSourceItemAndEnqueue({
      userWorkosId: candidate.userWorkosId,
      sourceConnectionId: candidate.integrationId,
      integrationId: candidate.integrationId,
      item,
      rawPayload: payload,
      rawEventKeysByBrainRef: claimedEventKeysByBrainRef,
      kind: BRAIN_AGENT_INGEST_JOB_KIND,
      brainRefs,
      db: tx,
    });
    for (const brainRef of brainRefs) {
      await attributeBrainSourceEventClaims({
        brainRef,
        sourceProvider: GRANOLA_PROVIDER,
        eventKeys: claimedEventKeysByBrainRef.get(brainRef) ?? [],
        sourceItemId: upserted.sourceItemId,
        db: tx,
      });
    }
    return upserted;
  });

  captureIngestionQuotaAnalytics(result?.quotaUpdates);
  if (result?.enqueued) wakeBrainIngestWorker();
  return { enqueued: Boolean(result?.enqueued) };
}

async function markGranolaNeedsReauth(candidate: GranolaPollCandidate, reason: string) {
  logger.warn("Goat Granola integration needs a new API key", {
    event: "opencompany.goat_granola_needs_reauth",
    integration_id: candidate.integrationId,
  });
  await markIntegrationStatus({
    userWorkosId: candidate.userWorkosId,
    integrationId: candidate.integrationId,
    provider: GRANOLA_PROVIDER,
    status: "needs_reauth",
    statusReason: reason,
    now: new Date(),
  });
}

export function startGranolaPollWorker(options: { pollIntervalMs?: number } = {}) {
  const pollIntervalMs = Math.max(1_000, options.pollIntervalMs ?? GRANOLA_POLL_INTERVAL_MS);
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
        const candidates = await listGranolaPollCandidates();
        for (const candidate of candidates) {
          if (stopped) break;
          const polled = await pollGranolaIntegration({
            candidate,
            signal: abort.signal,
          }).catch((error) => {
            captureException(error, {
              event: "opencompany.goat_granola_poll_failed",
              integration_id: candidate.integrationId,
            });
            logger.error("Goat Granola integration poll failed", {
              event: "opencompany.goat_granola_poll_failed",
              integration_id: candidate.integrationId,
              error,
            });
            return null;
          });
          if (polled && polled.enqueued > 0) {
            logger.info("Goat Granola notes enqueued", {
              event: "opencompany.goat_granola_notes_enqueued",
              integration_id: candidate.integrationId,
              enqueued_count: polled.enqueued,
              seen_count: polled.seen,
            });
          }
        }
      } catch (error) {
        captureException(error, { event: "opencompany.goat_granola_poll_worker_failed" });
        logger.error("Goat Granola poll worker failed", {
          event: "opencompany.goat_granola_poll_worker_failed",
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
