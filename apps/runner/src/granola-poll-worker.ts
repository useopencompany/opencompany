import { listGranolaFolders } from "@opencompany/agent/integrations/granola";
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
  GRANOLA_FOLDER_FILTER_ID,
  GRANOLA_MEETING_NOTES_READY_EVENT,
  GRANOLA_PROVIDER,
  granolaEventClaimKey,
  granolaNoteFolderScope,
  granolaWorkflowEventContext,
  granolaWorkflowEventDeliveryId,
  listEnabledGranolaBrainSourceRoutes,
  updateGranolaSyncCursor,
  updateGranolaSyncPage,
} from "@opencompany/db/granola";
import { loadIntegrationCredential, markIntegrationStatus } from "@opencompany/db/integrations";
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

const logger = createLogger({ service: "opencompany-runner", runtime: "goat-granola-poll" });

// The plugin declares poll delivery, so new meeting notes are discovered through
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
          FROM goat.workflows w
          JOIN goat.plugins p
            ON p.workspace_id = w.workspace_id
            AND p.owner_user_id = i.user_workos_id
            AND p.name = 'granola'
            AND p.status = 'enabled'
            AND p.archived_at IS NULL
            AND p.event_modes->'meeting.notes_ready' = 'true'::jsonb
            AND EXISTS (SELECT 1 FROM jsonb_array_elements(p.events) event
              WHERE event->>'id' = 'meeting.notes_ready')
          JOIN goat.workspace_members member
            ON member.workspace_id = w.workspace_id
            AND member.user_workos_id = i.user_workos_id
          WHERE w.trigger = 'event'
            AND w.status = 'active'
            AND w.archived_at IS NULL
            AND w.event_user_workos_id = i.user_workos_id
            AND w.event_config->>'provider' = 'granola'
            AND w.event_config->>'event' = 'meeting.notes_ready'
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

  // Recover connections made before cursors were initialized on connect.
  // Anchor at the earliest active subscription so the first poll cannot skip its first note.
  if (!state.updatedAfterCursor) {
    const routes = await listWorkflowEventTriggerRoutes(
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
    );
    const start = new Date(
      Math.min(
        Date.now(),
        ...routes.flatMap((route) => (route.activatedAt ? [route.activatedAt.getTime()] : [])),
      ),
    );
    await updateGranolaSyncCursor(
      { integrationId: candidate.integrationId, updatedAfterCursor: start },
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
  // Event routing is authorized per pass, not per note: the plugin event toggle, the workflow
  // status, and the connection can all change between polls. Declared filters are matched per
  // note, once the note payload that carries its folders has been fetched.
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
        ).filter((route) => route.event === GRANOLA_MEETING_NOTES_READY_EVENT);

  // Read the folder tree once per pass, and only when a route filters on one. A folder filter
  // covers the folder's descendants, and a note's membership entry names only its direct parent.
  let folderParentIds = new Map<string, string | null>();
  if (workflowRoutes.some((route) => route.filters[GRANOLA_FOLDER_FILTER_ID])) {
    const folders = await listGranolaFolders({ apiKey, signal: input.signal });
    if (!folders.ok) {
      if (folders.reason === "unauthorized") {
        await markGranolaNeedsReauth(candidate, "Granola rejected the saved API key.");
        return null;
      }
      // Matching a folder filter against a tree the platform could not read would drop runs
      // silently and then advance the cursor past the notes that should have started them. This
      // failure is retryable, so leave the cursor where it is and take the whole pass again.
      throw new Error("Could not read the Granola folder tree for an event-filtered workflow.");
    }
    if (folders.partial) {
      // The account has more folders than one listing reads, so retrying would never succeed and
      // failing every pass would stop this connection's ingestion for good. Matching falls back to
      // each note's own membership entries, which still reach one level up.
      logger.warn(
        "opencompany Granola folder tree exceeded one listing; filters match less deeply",
        {
          event: "opencompany.goat_granola_folder_tree_truncated",
          integration_id: candidate.integrationId,
          folder_count: folders.folders.length,
        },
      );
    }
    folderParentIds = new Map(
      folders.folders.map((folder) => [folder.id, folder.parentFolderId] as const),
    );
  }

  let enqueued = 0;
  let workflowRuns = 0;
  const noteErrors: unknown[] = [];
  for (const note of notes) {
    if (input.signal.aborted) throw new Error("Granola poll aborted.");
    let result: Awaited<ReturnType<typeof ingestGranolaNote>>;
    try {
      result = await ingestGranolaNote({
        candidate,
        apiKey,
        note,
        routedBrainRefs,
        workflowRoutes,
        folderParentIds,
        signal: input.signal,
      });
    } catch (error) {
      if (isGranolaAuthError(error)) {
        await markGranolaNeedsReauth(candidate, "Granola rejected the saved API key.");
        return null;
      }
      if (input.signal.aborted) throw error;
      noteErrors.push(error);
      continue;
    }
    if (result.enqueued) enqueued += 1;
    workflowRuns += result.workflowRuns;
  }
  // Finish routing other meetings even if one note or its separate Brain ingestion failed.
  // Leave the cursor unchanged on failure so the next pass retries without losing either path.
  if (noteErrors.length > 0) throw noteErrors[0];

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
  workflowRoutes?: readonly WorkflowEventTriggerRoute[];
  folderParentIds?: ReadonlyMap<string, string | null>;
  now?: Date;
  signal: AbortSignal;
  fetchNote?: typeof fetchGranolaNote;
}): Promise<{ enqueued: boolean; workflowRuns: number }> {
  const { candidate, note } = input;
  const db = getDb();
  const eventKey = granolaEventClaimKey(note.id);

  // Skip the transcript fetch when every routed Brain has already claimed the note
  // and no workflow needs it. Edits may bump updated_at without creating a new note.
  const alreadyClaimedBrainRefs = await listBrainSourceEventClaimedBrainRefs({
    brainRefs: input.routedBrainRefs,
    sourceProvider: GRANOLA_PROVIDER,
    eventKey,
    db,
  });
  const pendingBrainRefs = input.routedBrainRefs.filter(
    (brainRef) => !alreadyClaimedBrainRefs.has(brainRef),
  );
  const workflowRoutes = input.workflowRoutes ?? [];
  if (pendingBrainRefs.length === 0 && workflowRoutes.length === 0) {
    return { enqueued: false, workflowRuns: 0 };
  }

  const fetchNote = input.fetchNote ?? fetchGranolaNote;
  // Events only need the summary. Granola rejects inline transcripts that are too large;
  // requesting one here would prevent an otherwise-ready meeting from starting its workflow.
  let payload = await fetchNote({
    apiKey: input.apiKey,
    noteId: note.id,
    includeTranscript: workflowRoutes.length === 0,
    signal: input.signal,
  });

  const workflowRuns = await enqueueGranolaWorkflowEventRuns({
    routes: workflowRoutes,
    note,
    payload,
    folderParentIds: input.folderParentIds ?? new Map(),
    now: input.now ?? new Date(),
    db,
  });

  if (pendingBrainRefs.length === 0) {
    return { enqueued: false, workflowRuns };
  }
  // Save workflow deliveries before fetching the transcript for a separate Brain subscription.
  // If that fetch fails, retries deduplicate the delivery already in the durable event inbox.
  if (workflowRoutes.length > 0) {
    payload = await fetchNote({
      apiKey: input.apiKey,
      noteId: note.id,
      includeTranscript: true,
      signal: input.signal,
    });
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

  return { enqueued: brainEnqueued, workflowRuns };
}

// The list endpoint only returns notes Granola has finished summarizing, but a note whose summary
// is still missing or empty is not "ready": skipping it keeps the note id free so a later poll —
// the summary lands and bumps updated_at — is the delivery that starts the workflow. This matches
// normalizeGranolaMeetingNote, which rejects the same payload.
async function enqueueGranolaWorkflowEventRuns(input: {
  routes: readonly WorkflowEventTriggerRoute[];
  note: GranolaNoteSummary;
  payload: Record<string, unknown>;
  folderParentIds: ReadonlyMap<string, string | null>;
  now: Date;
  db: ReturnType<typeof getDb>;
}): Promise<number> {
  if (input.routes.length === 0) return 0;
  if (!hasGranolaSummary(input.payload)) return 0;
  const folderScope = granolaNoteFolderScope(input.payload, input.folderParentIds);
  const routes = input.routes.filter((route) =>
    workflowEventFiltersMatch(route, { [GRANOLA_FOLDER_FILTER_ID]: folderScope }),
  );
  if (routes.length === 0) return 0;
  const updatedAt = input.note.updatedAt ? new Date(input.note.updatedAt) : null;
  const eventAt = updatedAt && !Number.isNaN(updatedAt.getTime()) ? updatedAt : input.now;
  // Ingestion is happy to catch up on a backlog; starting an agent task per historical meeting is
  // not. A connection whose cursor froze while it had no routes — an ingestion source was
  // disabled, an event trigger added months later — would otherwise replay every note it missed.
  if (input.now.getTime() - eventAt.getTime() > GRANOLA_EVENT_MAX_NOTE_AGE_MS) return 0;
  return enqueueWorkflowEventRuns(
    {
      routes,
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
