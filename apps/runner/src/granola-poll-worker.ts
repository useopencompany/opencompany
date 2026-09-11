import { captureProductIngestionQuotaAnalytics } from "@opencompany/analytics/product";
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
  GRANOLA_MEETING_NOTES_READY_EVENT,
  GRANOLA_PROVIDER,
  granolaEventClaimKey,
  granolaWorkflowEventContext,
  granolaWorkflowEventDeliveryId,
  listEnabledGranolaBrainSourceRoutes,
  updateGranolaSyncCursor,
  updateGranolaSyncPage,
} from "@opencompany/db/granola";
import { loadIntegrationCredential, markIntegrationStatus } from "@opencompany/db/integrations";
import {
  attributeWikiSourceEventClaims,
  claimWikiSourceEvents,
  listWikiSourceEventClaimedWorkspaceIds,
} from "@opencompany/db/wiki-event-claims";
import { upsertWikiSourceItemAndEnqueue } from "@opencompany/db/wiki-ingest";
import { listEnabledWikiSourcesForIntegration } from "@opencompany/db/wiki-sources";
import {
  enqueueWorkflowEventRuns,
  listWorkflowEventTriggerRoutes,
  type WorkflowEventTriggerRoute,
  workflowEventFiltersMatch,
} from "@opencompany/db/workflow-event-routes";
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
import { createPollingWorker } from "./polling-worker";
import { rowsFromExecute } from "./sql-exec";
import { wakeWikiIngestWorker } from "./wiki-ingest-worker";

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
// How stale a finished note may be and still count as an event worth starting a task for. Normal
// notes arrive minutes old; this leaves room for an outage without turning a resumed connection's
// backlog into a burst of agent tasks. Notes older than this are ingested but never fire.
const GRANOLA_EVENT_MAX_NOTE_AGE_MS = 24 * 60 * 60_000;

type GranolaPollCandidate = {
  integrationId: string;
  userWorkosId: string;
};

export async function listGranolaPollCandidates(
  db: Pick<ReturnType<typeof getDb>, "execute"> = getDb(),
): Promise<GranolaPollCandidate[]> {
  const result = await db.execute(sql`
    SELECT
      i.id AS "integrationId",
      i.user_workos_id AS "userWorkosId"
    FROM goat.integrations i
    WHERE i.provider = 'granola'
      AND i.external_id <> 'granola_mcp'
      AND i.status = 'connected'
      -- Event triggers bind to personal connections; Granola only ever creates those.
      AND i.workspace_id IS NULL
      AND (
        EXISTS (
          SELECT 1
          FROM goat.brain_sources bs
          WHERE bs.integration_id = i.id
            AND bs.provider = 'granola'
            AND bs.enabled = true
        )
        OR EXISTS (
          SELECT 1
          FROM goat.wiki_sources ws
          WHERE ws.integration_id = i.id
            AND ws.provider = 'granola'
            AND ws.enabled = true
        )
        OR EXISTS (
          SELECT 1
          FROM goat.workflows w
          WHERE w.trigger = 'event'
            AND w.status = 'active'
            AND w.archived_at IS NULL
            AND w.event_user_workos_id = i.user_workos_id
            AND w.event_config->>'provider' = 'granola'
            AND w.event_config->>'integrationId' = i.id
        )
      )
  `);
  return rowsFromExecute<GranolaPollCandidate>(result);
}

export async function pollGranolaIntegration(input: {
  candidate: GranolaPollCandidate;
  signal: AbortSignal;
  cooldownMs?: number;
}): Promise<{ enqueued: number; seen: number; workflowRuns: number } | null> {
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
    return { enqueued: 0, seen: 0, workflowRuns: 0 };
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
  const wikiSources = await listEnabledWikiSourcesForIntegration(candidate.integrationId, db);
  const routedWikiWorkspaceIds = [
    ...new Set(
      wikiSources
        .filter((source) => source.provider === GRANOLA_PROVIDER)
        .map((source) => source.workspaceId),
    ),
  ];
  // Event routing is authorized per pass, not per note: the plugin event toggle, the workflow
  // status, and the connection can all change between polls. The declared event carries no
  // filters, so a route that somehow stored one is dropped rather than fired unfiltered.
  const workflowRoutes =
    notes.length === 0
      ? []
      : (
          await listWorkflowEventTriggerRoutes(
            {
              provider: GRANOLA_PROVIDER,
              integrations: [
                {
                  id: candidate.integrationId,
                  workspaceId: null,
                  userWorkosId: candidate.userWorkosId,
                  status: "connected",
                },
              ],
            },
            db,
          )
        ).filter(
          (route) =>
            route.event === GRANOLA_MEETING_NOTES_READY_EVENT &&
            workflowEventFiltersMatch(route, {}),
        );

  let enqueued = 0;
  let workflowRuns = 0;
  for (const note of notes) {
    if (input.signal.aborted) throw new Error("Granola poll aborted.");
    const result = await ingestGranolaNote({
      candidate,
      apiKey,
      note,
      routedBrainRefs,
      routedWikiWorkspaceIds,
      workflowRoutes,
      signal: input.signal,
    });
    if (result.enqueued) enqueued += 1;
    workflowRuns += result.workflowRuns;
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
  return { enqueued, seen: notes.length, workflowRuns };
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
  logger.info("opencompany Granola poll hit the page cap; saved continuation for next poll", {
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

export async function ingestGranolaNote(input: {
  candidate: GranolaPollCandidate;
  apiKey: string;
  note: GranolaNoteSummary;
  routedBrainRefs: readonly string[];
  routedWikiWorkspaceIds: readonly string[];
  workflowRoutes?: readonly WorkflowEventTriggerRoute[];
  now?: Date;
  signal: AbortSignal;
  fetchNote?: typeof fetchGranolaNote;
}): Promise<{ enqueued: boolean; workflowRuns: number }> {
  const { candidate, note } = input;
  const db = getDb();
  const eventKey = granolaEventClaimKey(note.id);

  // Cheap pre-check before the transcript fetch: a note every routed brain and
  // wiki workspace has already claimed (an earlier poll, another member's
  // connection, or an edit bumping updated_at) is a no-op.
  const [alreadyClaimedBrainRefs, alreadyClaimedWikiWorkspaceIds] = await Promise.all([
    listBrainSourceEventClaimedBrainRefs({
      brainRefs: input.routedBrainRefs,
      sourceProvider: GRANOLA_PROVIDER,
      eventKey,
      db,
    }),
    listWikiSourceEventClaimedWorkspaceIds({
      workspaceIds: input.routedWikiWorkspaceIds,
      sourceProvider: GRANOLA_PROVIDER,
      eventKey,
      db,
    }),
  ]);
  const pendingBrainRefs = input.routedBrainRefs.filter(
    (brainRef) => !alreadyClaimedBrainRefs.has(brainRef),
  );
  const pendingWikiWorkspaceIds = input.routedWikiWorkspaceIds.filter(
    (workspaceId) => !alreadyClaimedWikiWorkspaceIds.has(workspaceId),
  );
  const workflowRoutes = input.workflowRoutes ?? [];
  if (
    pendingBrainRefs.length === 0 &&
    pendingWikiWorkspaceIds.length === 0 &&
    workflowRoutes.length === 0
  ) {
    return { enqueued: false, workflowRuns: 0 };
  }

  const payload = await (input.fetchNote ?? fetchGranolaNote)({
    apiKey: input.apiKey,
    noteId: note.id,
    signal: input.signal,
  });

  const workflowRuns = await enqueueGranolaWorkflowEventRuns({
    routes: workflowRoutes,
    note,
    payload,
    now: input.now ?? new Date(),
    db,
  });

  if (pendingBrainRefs.length === 0 && pendingWikiWorkspaceIds.length === 0) {
    return { enqueued: false, workflowRuns };
  }
  const item = normalizeGranolaMeetingNote(payload, { capturedAt: new Date().toISOString() });

  let brainEnqueued = false;
  if (pendingBrainRefs.length > 0) {
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

    captureProductIngestionQuotaAnalytics(result?.quotaUpdates);
    brainEnqueued = Boolean(result?.enqueued);
    if (brainEnqueued) wakeBrainIngestWorker();
  }

  let wikiEnqueued = false;
  for (const workspaceId of pendingWikiWorkspaceIds) {
    const result = await db.transaction(async (tx: any) => {
      const claim = await claimWikiSourceEvents({
        workspaceId,
        sourceProvider: GRANOLA_PROVIDER,
        eventKeys: [eventKey],
        db: tx,
      });
      if (claim.claimedCount === 0) return null;

      const upserted = await upsertWikiSourceItemAndEnqueue({
        workspaceId,
        sourceConnectionId: candidate.integrationId,
        integrationId: candidate.integrationId,
        item,
        rawPayload: payload,
        db: tx,
      });
      await attributeWikiSourceEventClaims({
        workspaceId,
        sourceProvider: GRANOLA_PROVIDER,
        eventKeys: claim.claimedEventKeys,
        sourceItemId: upserted.sourceItemId,
        db: tx,
      });
      return upserted;
    });
    wikiEnqueued = wikiEnqueued || Boolean(result?.enqueued);
  }
  if (wikiEnqueued) wakeWikiIngestWorker();

  return { enqueued: brainEnqueued || wikiEnqueued, workflowRuns };
}

// The list endpoint only returns notes Granola has finished summarizing, but a note whose summary
// is still missing or empty is not "ready": skipping it keeps the note id free so a later poll —
// the summary lands and bumps updated_at — is the delivery that starts the workflow. This matches
// normalizeGranolaMeetingNote, which rejects the same payload.
async function enqueueGranolaWorkflowEventRuns(input: {
  routes: readonly WorkflowEventTriggerRoute[];
  note: GranolaNoteSummary;
  payload: Record<string, unknown>;
  now: Date;
  db: ReturnType<typeof getDb>;
}): Promise<number> {
  if (input.routes.length === 0) return 0;
  if (!hasGranolaSummary(input.payload)) return 0;
  const updatedAt = input.note.updatedAt ? new Date(input.note.updatedAt) : null;
  const eventAt = updatedAt && !Number.isNaN(updatedAt.getTime()) ? updatedAt : input.now;
  // Ingestion is happy to catch up on a backlog; starting an agent task per historical meeting is
  // not. A connection whose cursor froze while it had no routes — an ingestion source was
  // disabled, an event trigger added months later — would otherwise replay every note it missed.
  if (input.now.getTime() - eventAt.getTime() > GRANOLA_EVENT_MAX_NOTE_AGE_MS) return 0;
  return enqueueWorkflowEventRuns(
    {
      routes: input.routes,
      deliveryId: granolaWorkflowEventDeliveryId(input.note.id),
      eventAt,
      context: granolaWorkflowEventContext(input.payload),
    },
    input.db,
  );
}

function hasGranolaSummary(payload: Record<string, unknown>) {
  return [payload.summary_markdown, payload.summary_text].some(
    (value) => typeof value === "string" && value.trim() !== "",
  );
}

async function markGranolaNeedsReauth(candidate: GranolaPollCandidate, reason: string) {
  logger.warn("opencompany Granola integration needs a new API key", {
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
  return createPollingWorker({
    pollIntervalMs,
    poll: async ({ signal, stopping }) => {
      signal.throwIfAborted();
      const candidates = await listGranolaPollCandidates();
      for (const candidate of candidates) {
        if (stopping()) break;
        const polled = await pollGranolaIntegration({ candidate, signal }).catch((error) => {
          if (signal.aborted) throw error;
          captureException(error, {
            event: "opencompany.goat_granola_poll_failed",
            integration_id: candidate.integrationId,
          });
          logger.error("opencompany Granola integration poll failed", {
            event: "opencompany.goat_granola_poll_failed",
            integration_id: candidate.integrationId,
            error,
          });
          return null;
        });
        if (polled && (polled.enqueued > 0 || polled.workflowRuns > 0)) {
          logger.info("opencompany Granola notes enqueued", {
            event: "opencompany.goat_granola_notes_enqueued",
            integration_id: candidate.integrationId,
            enqueued_count: polled.enqueued,
            workflow_run_count: polled.workflowRuns,
            seen_count: polled.seen,
          });
        }
      }
    },
    onError: (error) => {
      captureException(error, { event: "opencompany.goat_granola_poll_worker_failed" });
      logger.error("opencompany Granola poll worker failed", {
        event: "opencompany.goat_granola_poll_worker_failed",
        error,
      });
    },
  });
}
