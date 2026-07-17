import { captureGoatIngestionQuotaAnalytics } from "@opencompany/analytics/goat";
import {
  goatAttioEventClaimKey,
  goatAttioEventTypeFor,
  goatAttioRouteMatchesEvent,
  goatAttioSelectedObjectTypes,
  listEnabledGoatAttioBrainSourceRoutes,
  newGoatAttioObjectWindowId,
} from "@opencompany/db/goat-attio";
import {
  attributeGoatBrainSourceEventClaims,
  claimGoatBrainSourceEvents,
} from "@opencompany/db/goat-brain-event-claims";
import {
  GOAT_BRAIN_AGENT_INGEST_JOB_KIND,
  upsertGoatBrainSourceItemAndEnqueue,
} from "@opencompany/db/goat-brain-ingest";
import type {
  GoatAttioEventAction,
  GoatAttioObjectType,
  GoatIntegrationStatus,
} from "@opencompany/db/goat-schema";
import {
  type NormalizedAttioObjectActivity,
  type NormalizedAttioObjectNote,
  type NormalizedAttioObjectSourceItem,
  normalizeAttioObjectWindow,
} from "@opencompany/goat-brain";
import { captureException, createLogger } from "@opencompany/observability";
import { sql } from "drizzle-orm";
import {
  AttioAuthError,
  type AttioRecordSnapshot,
  fetchAttioAttributeTitles,
  fetchAttioNotes,
  fetchAttioRecordSnapshot,
  loadAttioApiKey,
  markAttioNeedsReauth,
} from "./attio-api";
import { getDb } from "./db";
import { wakeGoatBrainIngestWorker } from "./goat-brain-ingest-worker";
import { rowsFromExecute } from "./sql-exec";

const logger = createLogger({ service: "opencompany-runner", runtime: "goat-attio-flush" });
type DbLike = any;

// A window flushes after the CRM record has been quiet for the quiet period,
// or once its oldest buffered event has waited out the max wait — whichever
// comes first. One agent ingest session then covers the whole window. A CRM
// edit session touches many attributes in a quick burst, then the record goes
// quiet for days, so a HubSpot-sized quiet period captures the whole burst.
export const GOAT_ATTIO_QUIET_PERIOD_MS = 15 * 60_000;
export const GOAT_ATTIO_MAX_WAIT_MS = 4 * 60 * 60_000;
export const GOAT_ATTIO_MAX_WINDOW_EVENTS = 200;
export const GOAT_ATTIO_MAX_NOTES_PER_WINDOW = 5;
const GOAT_ATTIO_FLUSH_POLL_INTERVAL_MS = 60_000;

export type GoatAttioDueWindow = {
  integrationId: string;
  userWorkosId: string;
  workspaceId: string;
  objectType: GoatAttioObjectType;
  recordId: string;
};

type BufferedAttioEventRow = {
  id: string;
  deliveryId: string;
  action: GoatAttioEventAction;
  attributeId: string | null;
  noteId: string | null;
  payload: Record<string, unknown>;
  eventTime: string | Date;
};

export async function listDueGoatAttioObjectWindows(input: {
  now?: Date;
  quietPeriodMs?: number;
  maxWaitMs?: number;
}): Promise<GoatAttioDueWindow[]> {
  const now = input.now ?? new Date();
  const quietCutoff = new Date(now.getTime() - (input.quietPeriodMs ?? GOAT_ATTIO_QUIET_PERIOD_MS));
  const maxWaitCutoff = new Date(now.getTime() - (input.maxWaitMs ?? GOAT_ATTIO_MAX_WAIT_MS));
  const result = await getDb().execute(sql`
    SELECT
      integration_id AS "integrationId",
      user_workos_id AS "userWorkosId",
      workspace_id AS "workspaceId",
      object_type AS "objectType",
      record_id AS "recordId"
    FROM goat.attio_object_events
    WHERE source_item_id IS NULL
    GROUP BY 1, 2, 3, 4, 5
    HAVING max(received_at) < ${quietCutoff} OR min(received_at) < ${maxWaitCutoff}
  `);
  return rowsFromExecute<GoatAttioDueWindow>(result);
}

type AttioWindowEnrichment = {
  snapshot: AttioRecordSnapshot | null;
  attributeTitles: Map<string, string>;
  notes: NormalizedAttioObjectNote[];
  routingEnabled: boolean;
};

type AttioRoutedEventGroup = {
  events: BufferedAttioEventRow[];
  eventKeys: string[];
  brainRefs: string[];
  eventKeysByBrainRef: Map<string, string[]>;
};

export async function flushGoatAttioObjectWindow(window: GoatAttioDueWindow): Promise<{
  sourceItemId: string;
  eventCount: number;
  enqueued: boolean;
  skipped: boolean;
} | null> {
  const db = getDb();

  // Enrichment happens before the transaction so no network call ever holds
  // row locks. An event that slips in mid-flush stays pending and seeds the
  // next window anyway.
  const preview = selectAttioWindowEventsForFlush(await previewBufferedAttioEvents(window));
  if (preview.length === 0) return null;
  const status = await loadAttioIntegrationStatus(window);
  const enrichment = await enrichAttioWindow(window, preview, status);

  const flushedAt = new Date();
  const result = await db.transaction(async (tx) => {
    const claimed = rowsFromExecute<BufferedAttioEventRow>(
      await tx.execute(sql`
        SELECT
          id,
          delivery_id AS "deliveryId",
          action,
          attribute_id AS "attributeId",
          note_id AS "noteId",
          payload,
          event_time AS "eventTime"
        FROM goat.attio_object_events
        WHERE id IN (${sql.join(
          preview.map((row) => sql`${row.id}`),
          sql`, `,
        )})
          AND source_item_id IS NULL
        ORDER BY event_time ASC, id ASC
        FOR UPDATE SKIP LOCKED
      `),
    );
    // Another sweeper may have claimed the same due window first.
    if (claimed.length === 0) return null;
    // Keep the pre-fetched snapshot aligned with the exact flushed window.
    if (claimed.length !== preview.length) return null;

    // Routing is re-resolved at flush time: the user may have deselected the
    // object type or disabled the source since the events were buffered. A
    // revoked integration still flushes (persisting the window) with no jobs,
    // so the buffer never wedges on a dead key.
    // Enrichment can discover a revoked key and mark the integration
    // needs_reauth. Re-read inside the transaction so that status change (or a
    // concurrent disconnect) prevents this incomplete window from being
    // routed and billed.
    const currentStatus = enrichment.routingEnabled
      ? await loadAttioIntegrationStatus(window, tx)
      : status;
    const routes = canRouteAttioWindow(currentStatus, enrichment.routingEnabled)
      ? await listEnabledGoatAttioBrainSourceRoutes([window.integrationId], tx)
      : [];
    const routableRoutes = hasUsableAttioRecordIdentity(enrichment.snapshot)
      ? routes.filter((route) => {
          const selected = goatAttioSelectedObjectTypes(route.config);
          if (selected.size === 0) return false;
          return selected.has(window.objectType);
        })
      : [];

    // Cross-member dedup: Attio delivers separately to each member's webhook,
    // so claim keys derive from event content (note ids, record creation,
    // short update-time buckets) rather than a shared delivery id. A brain whose claims
    // all lose (record window already ingested via another member's
    // integration) is skipped — no job, no billing.
    const eventKeys = claimed.map((row) =>
      goatAttioEventClaimKey({
        workspaceId: window.workspaceId,
        objectType: window.objectType,
        recordId: window.recordId,
        action: row.action,
        attributeId: row.attributeId,
        noteId: row.noteId,
        eventTime: eventTimeDate(row.eventTime),
      }),
    );
    const eventKeyByEventId = new Map(claimed.map((row, index) => [row.id, eventKeys[index]!]));
    const groups = new Map<string, AttioRoutedEventGroup>();
    for (const route of routableRoutes) {
      const matchingEventKeys = claimed.flatMap((row, index) =>
        goatAttioRouteMatchesEvent(route.config, goatAttioEventTypeFor(row.action), {
          actorType: attioActorType(row),
        })
          ? [eventKeys[index]!]
          : [],
      );
      if (matchingEventKeys.length === 0) continue;
      const { claimedEventKeys } = await claimGoatBrainSourceEvents({
        brainRef: route.brainRef,
        sourceProvider: "attio",
        eventKeys: matchingEventKeys,
        db: tx,
      });
      if (claimedEventKeys.length === 0) continue;
      const claimedKeySet = new Set(claimedEventKeys);
      const groupEventKeys = [
        ...new Set(eventKeys.filter((eventKey) => claimedKeySet.has(eventKey))),
      ];
      const groupKey = JSON.stringify(groupEventKeys);
      const existing = groups.get(groupKey);
      if (existing) {
        existing.brainRefs.push(route.brainRef);
        existing.eventKeysByBrainRef.set(route.brainRef, groupEventKeys);
        continue;
      }
      groups.set(groupKey, {
        events: claimed.filter((_row, index) => claimedKeySet.has(eventKeys[index]!)),
        eventKeys: groupEventKeys,
        brainRefs: [route.brainRef],
        eventKeysByBrainRef: new Map([[route.brainRef, groupEventKeys]]),
      });
    }

    // A single integration can feed multiple Brains with different event
    // selections. Persist one normalized item per distinct claimed event set
    // so a Brain subscribed only to notes never sees an update that another
    // Brain explicitly opted into.
    const sourceItemIdByEventId = new Map<string, string>();
    const upsertedGroups: Array<Awaited<ReturnType<typeof upsertGoatBrainSourceItemAndEnqueue>>> =
      [];
    for (const group of groups.values()) {
      const upserted = await upsertGoatBrainSourceItemAndEnqueue({
        userWorkosId: window.userWorkosId,
        sourceConnectionId: window.integrationId,
        integrationId: window.integrationId,
        item: buildAttioObjectWindowItem({
          window,
          events: group.events,
          enrichment,
          flushedAt,
        }),
        rawPayload: { eventIds: group.events.map((row) => row.id) },
        rawEventCount: group.eventKeys.length,
        rawEventKeysByBrainRef: group.eventKeysByBrainRef,
        kind: GOAT_BRAIN_AGENT_INGEST_JOB_KIND,
        brainRefs: group.brainRefs,
        skipReason: null,
        now: flushedAt,
        db: tx,
      });
      upsertedGroups.push(upserted);
      for (const event of group.events) {
        if (!sourceItemIdByEventId.has(event.id)) {
          sourceItemIdByEventId.set(event.id, upserted.sourceItemId);
        }
      }
      for (const brainRef of group.brainRefs) {
        await attributeGoatBrainSourceEventClaims({
          brainRef,
          sourceProvider: "attio",
          eventKeys: group.eventKeysByBrainRef.get(brainRef) ?? [],
          sourceItemId: upserted.sourceItemId,
          db: tx,
        });
      }
    }

    // Persist filtered or unroutable events as evidence without enqueueing a
    // Brain job, and use source_item_id as the durable flushed marker.
    const unrouted = claimed.filter((row) => !sourceItemIdByEventId.has(row.id));
    if (unrouted.length > 0) {
      const upserted = await upsertGoatBrainSourceItemAndEnqueue({
        userWorkosId: window.userWorkosId,
        sourceConnectionId: window.integrationId,
        integrationId: window.integrationId,
        item: buildAttioObjectWindowItem({ window, events: unrouted, enrichment, flushedAt }),
        rawPayload: { eventIds: unrouted.map((row) => row.id) },
        rawEventCount: new Set(unrouted.map((row) => eventKeyByEventId.get(row.id)!)).size,
        rawEventKeysByBrainRef: new Map(),
        kind: GOAT_BRAIN_AGENT_INGEST_JOB_KIND,
        brainRefs: [],
        skipReason: null,
        now: flushedAt,
        db: tx,
      });
      upsertedGroups.push(upserted);
      for (const event of unrouted) sourceItemIdByEventId.set(event.id, upserted.sourceItemId);
    }

    const eventIdsBySourceItemId = new Map<string, string[]>();
    for (const row of claimed) {
      const sourceItemId = sourceItemIdByEventId.get(row.id);
      if (!sourceItemId) throw new Error(`Attio event ${row.id} was not persisted.`);
      const ids = eventIdsBySourceItemId.get(sourceItemId) ?? [];
      ids.push(row.id);
      eventIdsBySourceItemId.set(sourceItemId, ids);
    }
    for (const [sourceItemId, eventIds] of eventIdsBySourceItemId) {
      await tx.execute(sql`
        UPDATE goat.attio_object_events
        SET source_item_id = ${sourceItemId}
        WHERE id IN (${sql.join(
          eventIds.map((eventId) => sql`${eventId}`),
          sql`, `,
        )})
      `);
    }

    const firstSourceItemId = sourceItemIdByEventId.get(claimed[0]!.id);
    if (!firstSourceItemId) throw new Error("Attio flush did not persist its first event.");
    return {
      sourceItemId: firstSourceItemId,
      eventCount: claimed.length,
      enqueued: upsertedGroups.some((upserted) => upserted.enqueued),
      skipped: upsertedGroups.every((upserted) => upserted.skipped),
      quotaUpdates: upsertedGroups.flatMap((upserted) => upserted.quotaUpdates ?? []),
    };
  });

  captureGoatIngestionQuotaAnalytics(result?.quotaUpdates);
  if (result?.enqueued) wakeGoatBrainIngestWorker();
  return result;
}

async function enrichAttioWindow(
  window: GoatAttioDueWindow,
  events: readonly BufferedAttioEventRow[],
  status: GoatIntegrationStatus | "unknown",
): Promise<AttioWindowEnrichment> {
  const empty: AttioWindowEnrichment = {
    snapshot: null,
    attributeTitles: new Map(),
    notes: [],
    routingEnabled: false,
  };
  if (status !== "connected") return empty;
  const apiKey = await loadAttioApiKey({
    userWorkosId: window.userWorkosId,
    integrationId: window.integrationId,
  });
  if (!apiKey) return empty;

  try {
    const hasUpdates = events.some((row) => row.action === "update" && row.attributeId);
    const noteIds = [
      ...new Set(
        events.flatMap((row) => (row.action === "note" && row.noteId ? [row.noteId] : [])),
      ),
    ];
    const [snapshot, attributeTitles, notes] = await Promise.all([
      fetchAttioRecordSnapshot({
        apiKey,
        objectType: window.objectType,
        recordId: window.recordId,
      }),
      hasUpdates
        ? fetchAttioAttributeTitles({ apiKey, objectType: window.objectType })
        : Promise.resolve(new Map<string, string>()),
      noteIds.length > 0 ? fetchAttioNotes({ apiKey, noteIds }) : Promise.resolve([]),
    ]);
    return { snapshot, attributeTitles, notes, routingEnabled: true };
  } catch (error) {
    if (error instanceof AttioAuthError) {
      await markAttioNeedsReauth(window, "Attio rejected the saved API key.");
      return empty;
    }
    logger.warn("Attio window enrichment failed", {
      event: "opencompany.goat_attio_enrichment_failed",
      integration_id: window.integrationId,
      record_id: window.recordId,
      error,
    });
    return empty;
  }
}

export function buildAttioObjectWindowItem(input: {
  window: GoatAttioDueWindow;
  events: readonly BufferedAttioEventRow[];
  enrichment: AttioWindowEnrichment;
  flushedAt: Date;
}): NormalizedAttioObjectSourceItem {
  const { window, events, enrichment } = input;
  const selectedNoteIds = new Set(
    events.flatMap((row) => (row.action === "note" && row.noteId ? [row.noteId] : [])),
  );
  const notes = enrichment.notes.filter((note) => selectedNoteIds.has(note.noteId));
  const notesById = new Map(notes.map((note) => [note.noteId, note]));
  const activity = events.map((row) =>
    toNormalizedActivity(row, enrichment.attributeTitles, notesById),
  );

  return normalizeAttioObjectWindow({
    windowId: newGoatAttioObjectWindowId(),
    workspaceId: window.workspaceId,
    objectType: window.objectType,
    recordId: window.recordId,
    name: enrichment.snapshot?.name ?? window.recordId,
    activity,
    flushedAt: input.flushedAt.toISOString(),
    ...(enrichment.snapshot
      ? {
          ...(enrichment.snapshot.url ? { url: enrichment.snapshot.url } : {}),
          ...(enrichment.snapshot.stage ? { stage: enrichment.snapshot.stage } : {}),
          properties: enrichment.snapshot.properties,
          ...(enrichment.snapshot.createdAt ? { createdAt: enrichment.snapshot.createdAt } : {}),
        }
      : { snapshotStale: true }),
    ...(notes.length > 0 ? { notes } : {}),
  });
}

export function selectAttioWindowEventsForFlush<T extends { action: GoatAttioEventAction }>(
  events: readonly T[],
  maxNotes = GOAT_ATTIO_MAX_NOTES_PER_WINDOW,
): T[] {
  const selected: T[] = [];
  let selectedNotes = 0;
  for (const event of events) {
    if (event.action === "note") {
      if (selectedNotes >= maxNotes) continue;
      selectedNotes += 1;
    }
    selected.push(event);
  }
  return selected;
}

export function canRouteAttioWindow(
  status: GoatIntegrationStatus | "unknown",
  enrichmentRoutingEnabled: boolean,
) {
  return enrichmentRoutingEnabled && status === "connected";
}

export function hasUsableAttioRecordIdentity(snapshot: AttioRecordSnapshot | null) {
  return Boolean(snapshot?.name?.trim());
}

function attioActorType(row: BufferedAttioEventRow): string | null {
  return typeof row.payload.actorType === "string" ? row.payload.actorType : null;
}

export function startGoatAttioFlushWorker(options: { pollIntervalMs?: number } = {}) {
  const pollIntervalMs = Math.max(
    1_000,
    options.pollIntervalMs ?? GOAT_ATTIO_FLUSH_POLL_INTERVAL_MS,
  );
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
        const due = await listDueGoatAttioObjectWindows({});
        for (const window of due) {
          if (stopped) break;
          const flushed = await flushGoatAttioObjectWindow(window).catch((error) => {
            captureException(error, {
              event: "opencompany.goat_attio_flush_failed",
              integration_id: window.integrationId,
              object_type: window.objectType,
              record_id: window.recordId,
            });
            logger.error("Goat Attio window flush failed", {
              event: "opencompany.goat_attio_flush_failed",
              integration_id: window.integrationId,
              object_type: window.objectType,
              record_id: window.recordId,
              error,
            });
            return null;
          });
          if (flushed) {
            logger.info("Goat Attio window flushed", {
              event: "opencompany.goat_attio_window_flushed",
              integration_id: window.integrationId,
              object_type: window.objectType,
              record_id: window.recordId,
              source_item_id: flushed.sourceItemId,
              event_count: flushed.eventCount,
              enqueued: flushed.enqueued,
              skipped: flushed.skipped,
            });
          }
        }
      } catch (error) {
        captureException(error, { event: "opencompany.goat_attio_flush_worker_failed" });
        logger.error("Goat Attio flush worker failed", {
          event: "opencompany.goat_attio_flush_worker_failed",
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
      wake?.();
      await loop;
    },
  };
}

async function previewBufferedAttioEvents(window: GoatAttioDueWindow) {
  return rowsFromExecute<BufferedAttioEventRow>(
    await getDb().execute(sql`
      SELECT
        id,
        delivery_id AS "deliveryId",
        action,
        attribute_id AS "attributeId",
        note_id AS "noteId",
        payload,
        event_time AS "eventTime"
      FROM goat.attio_object_events
      WHERE integration_id = ${window.integrationId}
        AND object_type = ${window.objectType}
        AND record_id = ${window.recordId}
        AND source_item_id IS NULL
      ORDER BY event_time ASC, id ASC
      LIMIT ${GOAT_ATTIO_MAX_WINDOW_EVENTS}
    `),
  );
}

async function loadAttioIntegrationStatus(
  window: GoatAttioDueWindow,
  db: DbLike = getDb(),
): Promise<GoatIntegrationStatus | "unknown"> {
  const statusRows = rowsFromExecute<{ status: GoatIntegrationStatus }>(
    await db.execute(sql`
      SELECT status FROM goat.integrations WHERE id = ${window.integrationId}
    `),
  );
  return statusRows[0]?.status ?? "unknown";
}

// Raw db.execute skips Drizzle's column mapping, so timestamptz comes back as
// a string; coerce before formatting.
function eventTimeDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

function toNormalizedActivity(
  row: BufferedAttioEventRow,
  attributeTitles: ReadonlyMap<string, string>,
  notesById: ReadonlyMap<string, NormalizedAttioObjectNote>,
): NormalizedAttioObjectActivity {
  const actorType =
    typeof row.payload.actorType === "string" && row.payload.actorType
      ? row.payload.actorType
      : null;
  const attributeName =
    row.action === "update" && row.attributeId
      ? (attributeTitles.get(row.attributeId) ?? null)
      : null;
  const noteTitle = row.action === "note" && row.noteId ? notesById.get(row.noteId)?.title : null;
  return {
    occurredAt: eventTimeDate(row.eventTime).toISOString(),
    action: row.action,
    ...(attributeName ? { attributeName } : {}),
    ...(noteTitle ? { noteTitle } : {}),
    ...(actorType ? { actorType } : {}),
  };
}
