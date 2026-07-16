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
  claimGoatGranolaSyncState,
  ensureGoatGranolaSyncState,
  GOAT_GRANOLA_CREDENTIAL_KIND,
  GOAT_GRANOLA_PROVIDER,
  goatGranolaEventClaimKey,
  listEnabledGoatGranolaBrainSourceRoutes,
  updateGoatGranolaSyncCursor,
} from "@opencompany/db/goat-granola";
import {
  loadGoatIntegrationCredential,
  markGoatIntegrationStatus,
} from "@opencompany/db/goat-integrations";
import { normalizeGranolaMeetingNote } from "@opencompany/goat-brain";
import { captureException, createLogger } from "@opencompany/observability";
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import { wakeGoatBrainIngestWorker } from "./goat-brain-ingest-worker";
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
export const GOAT_GRANOLA_POLL_INTERVAL_MS = 5 * 60_000;
// A claim stamps last_polled_at; other runner replicas skip integrations
// claimed within the cooldown. Brain event claims absorb any residual
// double-poll race.
export const GOAT_GRANOLA_POLL_COOLDOWN_MS = 4 * 60_000;
// Runaway guard on cursor pagination within one poll pass. Meetings are
// low-volume; anything beyond this is drained by later polls because the
// cursor only advances past processed notes.
const GOAT_GRANOLA_MAX_PAGES_PER_POLL = 5;

type GranolaPollCandidate = {
  integrationId: string;
  userWorkosId: string;
};

export async function listGoatGranolaPollCandidates(): Promise<GranolaPollCandidate[]> {
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

export async function pollGoatGranolaIntegration(input: {
  candidate: GranolaPollCandidate;
  signal: AbortSignal;
  cooldownMs?: number;
}): Promise<{ enqueued: number; seen: number } | null> {
  const { candidate } = input;
  const db = getDb();
  await ensureGoatGranolaSyncState(
    {
      integrationId: candidate.integrationId,
      userWorkosId: candidate.userWorkosId,
    },
    db,
  );
  const state = await claimGoatGranolaSyncState(
    {
      integrationId: candidate.integrationId,
      cooldownMs: input.cooldownMs ?? GOAT_GRANOLA_POLL_COOLDOWN_MS,
    },
    db,
  );
  if (!state) return null;

  // First poll after connect: anchor the cursor at "now" — no backfill.
  if (!state.updatedAfterCursor) {
    await updateGoatGranolaSyncCursor(
      { integrationId: candidate.integrationId, updatedAfterCursor: new Date() },
      db,
    );
    return { enqueued: 0, seen: 0 };
  }

  const credential = await loadGoatIntegrationCredential({
    userWorkosId: candidate.userWorkosId,
    integrationId: candidate.integrationId,
    provider: GOAT_GRANOLA_PROVIDER,
    kind: GOAT_GRANOLA_CREDENTIAL_KIND,
  });
  const apiKey =
    credential && typeof credential.payload.apiKey === "string" ? credential.payload.apiKey : null;
  if (!apiKey) {
    await markGranolaNeedsReauth(candidate, "The saved Granola API key could not be loaded.");
    return null;
  }

  let notes: GranolaNoteSummary[];
  try {
    notes = await listGranolaNotesSince({
      apiKey,
      updatedAfter: state.updatedAfterCursor.toISOString(),
      signal: input.signal,
    });
  } catch (error) {
    if (isGranolaAuthError(error)) {
      await markGranolaNeedsReauth(candidate, "Granola rejected the saved API key.");
      return null;
    }
    throw error;
  }
  if (notes.length === 0) return { enqueued: 0, seen: 0 };

  const routes = await listEnabledGoatGranolaBrainSourceRoutes([candidate.integrationId], db);
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

  // The cursor only advances once every listed note was processed (ingested or
  // skipped as already claimed); a failed note aborts above and the next poll
  // re-lists from the same watermark.
  const maxUpdatedAt = notes.reduce<Date | null>((max, note) => {
    if (!note.updatedAt) return max;
    const updatedAt = new Date(note.updatedAt);
    if (Number.isNaN(updatedAt.getTime())) return max;
    return !max || updatedAt > max ? updatedAt : max;
  }, null);
  if (maxUpdatedAt) {
    await updateGoatGranolaSyncCursor(
      { integrationId: candidate.integrationId, updatedAfterCursor: maxUpdatedAt },
      db,
    );
  }
  return { enqueued, seen: notes.length };
}

async function listGranolaNotesSince(input: {
  apiKey: string;
  updatedAfter: string;
  signal: AbortSignal;
}): Promise<GranolaNoteSummary[]> {
  const notes: GranolaNoteSummary[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < GOAT_GRANOLA_MAX_PAGES_PER_POLL; page += 1) {
    const result = await listGranolaNotes({
      apiKey: input.apiKey,
      updatedAfter: input.updatedAfter,
      ...(cursor ? { cursor } : {}),
      signal: input.signal,
    });
    notes.push(...result.notes);
    if (!result.hasMore || !result.cursor) return notes;
    cursor = result.cursor;
  }
  logger.warn("Goat Granola poll hit the page cap; remaining notes drain next poll", {
    event: "opencompany.goat_granola_poll_page_cap",
    note_count: notes.length,
  });
  return notes;
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
  const eventKey = goatGranolaEventClaimKey(note.id);

  // Cheap pre-check before the transcript fetch: a note every routed brain has
  // already claimed (an earlier poll, or an edit bumping updated_at) is a no-op.
  const alreadyClaimed = await listGoatBrainSourceEventClaimedBrainRefs({
    brainRefs: input.routedBrainRefs,
    sourceProvider: GOAT_GRANOLA_PROVIDER,
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
      const { claimedEventKeys } = await claimGoatBrainSourceEvents({
        brainRef,
        sourceProvider: GOAT_GRANOLA_PROVIDER,
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
        sourceProvider: GOAT_GRANOLA_PROVIDER,
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

async function markGranolaNeedsReauth(candidate: GranolaPollCandidate, reason: string) {
  logger.warn("Goat Granola integration needs a new API key", {
    event: "opencompany.goat_granola_needs_reauth",
    integration_id: candidate.integrationId,
  });
  await markGoatIntegrationStatus({
    userWorkosId: candidate.userWorkosId,
    integrationId: candidate.integrationId,
    provider: GOAT_GRANOLA_PROVIDER,
    status: "needs_reauth",
    statusReason: reason,
    now: new Date(),
  });
}

export function startGoatGranolaPollWorker(options: { pollIntervalMs?: number } = {}) {
  const pollIntervalMs = Math.max(1_000, options.pollIntervalMs ?? GOAT_GRANOLA_POLL_INTERVAL_MS);
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
        const candidates = await listGoatGranolaPollCandidates();
        for (const candidate of candidates) {
          if (stopped) break;
          const polled = await pollGoatGranolaIntegration({
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
