import { captureProductIngestionQuotaAnalytics } from "@opencompany/analytics/product";
import {
  type NormalizedHubspotObjectActivity,
  type NormalizedHubspotObjectSourceItem,
  normalizeHubspotObjectWindow,
} from "@opencompany/brain";
import {
  attributeBrainSourceEventClaims,
  claimBrainSourceEvents,
} from "@opencompany/db/brain-event-claims";
import {
  BRAIN_AGENT_INGEST_JOB_KIND,
  upsertBrainSourceItemAndEnqueue,
} from "@opencompany/db/brain-ingest";
import {
  hubspotEventTypeFor,
  hubspotRouteMatchesEvent,
  hubspotSelectedObjectTypes,
  listEnabledHubspotBrainSourceRoutes,
  newHubspotObjectWindowId,
} from "@opencompany/db/hubspot";
import type {
  HubspotEventAction,
  HubspotObjectType,
  IntegrationStatus,
} from "@opencompany/db/product-schema";
import { captureException, createLogger } from "@opencompany/observability";
import { sql } from "drizzle-orm";
import { wakeBrainIngestWorker } from "./brain-ingest-worker";
import { getDb } from "./db";
import type { RunnerEnv } from "./env";
import {
  fetchHubspotObjectSnapshot,
  getHubspotAccessToken,
  type HubspotObjectSnapshot,
} from "./hubspot-api";
import { createPollingWorker } from "./polling-worker";
import { rowsFromExecute } from "./sql-exec";

const logger = createLogger({
  service: "opencompany-runner",
  runtime: "goat-hubspot-flush",
});

// A window flushes after the CRM object has been quiet for the quiet period,
// or once its oldest buffered event has waited out the max wait — whichever
// comes first. One agent ingest session then covers the whole window. A CRM
// edit session touches many properties in a quick burst, then the record goes
// quiet for days, so a Linear-sized quiet period captures the whole burst.
export const HUBSPOT_QUIET_PERIOD_MS = 15 * 60_000;
export const HUBSPOT_MAX_WAIT_MS = 4 * 60 * 60_000;
export const HUBSPOT_MAX_WINDOW_EVENTS = 200;
const HUBSPOT_FLUSH_POLL_INTERVAL_MS = 60_000;

const ACTIVITY_PROPERTY_VALUE_MAX_CHARS = 500;

// Name-carrying properties, newest buffered value wins when the live snapshot
// is unavailable.
const NAME_PROPERTIES: Record<HubspotObjectType, readonly string[]> = {
  contact: ["firstname", "lastname", "email"],
  company: ["name", "domain"],
  deal: ["dealname"],
};

export type HubspotDueWindow = {
  integrationId: string;
  userWorkosId: string;
  portalId: string;
  objectType: HubspotObjectType;
  objectId: string;
};

type BufferedHubspotEventRow = {
  id: string;
  deliveryId: string;
  action: HubspotEventAction;
  propertyName: string | null;
  payload: Record<string, unknown>;
  eventTime: string | Date;
};

export async function listDueHubspotObjectWindows(input: {
  now?: Date;
  quietPeriodMs?: number;
  maxWaitMs?: number;
}): Promise<HubspotDueWindow[]> {
  const now = input.now ?? new Date();
  const quietCutoff = new Date(now.getTime() - (input.quietPeriodMs ?? HUBSPOT_QUIET_PERIOD_MS));
  const maxWaitCutoff = new Date(now.getTime() - (input.maxWaitMs ?? HUBSPOT_MAX_WAIT_MS));
  const result = await getDb().execute(sql`
    SELECT
      integration_id AS "integrationId",
      user_workos_id AS "userWorkosId",
      portal_id AS "portalId",
      object_type AS "objectType",
      object_id AS "objectId"
    FROM goat.hubspot_object_events
    WHERE source_item_id IS NULL
    GROUP BY 1, 2, 3, 4, 5
    HAVING max(received_at) < ${quietCutoff} OR min(received_at) < ${maxWaitCutoff}
  `);
  return rowsFromExecute<HubspotDueWindow>(result);
}

export async function flushHubspotObjectWindow(
  window: HubspotDueWindow,
  env: RunnerEnv,
): Promise<{
  sourceItemId: string;
  eventCount: number;
  enqueued: boolean;
  skipped: boolean;
} | null> {
  const db = getDb();

  // Enrichment happens before the transaction so no network call ever holds
  // row locks. An event that slips in mid-flush stays pending and seeds the
  // next window anyway.
  const preview = await previewBufferedHubspotEvents(window);
  if (preview.length === 0) return null;
  const status = await loadHubspotIntegrationStatus(window);
  const accessToken =
    status === "connected"
      ? await getHubspotAccessToken({
          env,
          userWorkosId: window.userWorkosId,
          integrationId: window.integrationId,
        })
      : null;
  const snapshot = accessToken
    ? await fetchHubspotObjectSnapshot({
        token: accessToken,
        portalId: window.portalId,
        objectType: window.objectType,
        objectId: window.objectId,
      })
    : null;

  const flushedAt = new Date();
  const result = await db.transaction(async (tx) => {
    const claimed = rowsFromExecute<BufferedHubspotEventRow>(
      await tx.execute(sql`
        SELECT
          id,
          delivery_id AS "deliveryId",
          action,
          property_name AS "propertyName",
          payload,
          event_time AS "eventTime"
        FROM goat.hubspot_object_events
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

    const item = buildHubspotObjectWindowItem({
      window,
      events: claimed,
      snapshot,
      flushedAt,
    });
    const ingestDecision = classifyHubspotObjectWindowForIngest(item);

    // Routing is re-resolved at flush time: the user may have deselected the
    // object type or disabled the source since the events were buffered. A
    // revoked integration still flushes (persisting the window) with no jobs,
    // so the buffer never wedges on a dead token.
    const routes =
      status === "connected"
        ? await listEnabledHubspotBrainSourceRoutes([window.integrationId], tx)
        : [];
    const candidateBrainRefs = routes
      .filter((route) => {
        const selected = hubspotSelectedObjectTypes(route.config);
        if (selected.size === 0) return false;
        if (!selected.has(window.objectType)) return false;
        return eventsMatchHubspotRoute(route.config, claimed);
      })
      .map((route) => route.brainRef);

    // Cross-member dedup: one webhook delivery buffers once per integration of
    // the same HubSpot portal, so the delivery id is the identity shared
    // across members. A brain whose claims all lose (object window already
    // ingested via another member's integration) is skipped — no job, no billing.
    const eventKeys = claimed.map(
      (row) => `${window.portalId}:${window.objectType}:${window.objectId}:${row.deliveryId}`,
    );
    const brainRefs: string[] = [];
    const claimedEventKeysByBrainRef = new Map<string, string[]>();
    const newlyClaimedEventKeys = new Set<string>();
    for (const brainRef of new Set(candidateBrainRefs)) {
      const { claimedEventKeys } = await claimBrainSourceEvents({
        brainRef,
        sourceProvider: "hubspot",
        eventKeys,
        db: tx,
      });
      if (claimedEventKeys.length === 0) continue;
      brainRefs.push(brainRef);
      claimedEventKeysByBrainRef.set(brainRef, claimedEventKeys);
      for (const eventKey of claimedEventKeys) newlyClaimedEventKeys.add(eventKey);
    }

    const upserted = await upsertBrainSourceItemAndEnqueue({
      userWorkosId: window.userWorkosId,
      sourceConnectionId: window.integrationId,
      integrationId: window.integrationId,
      item,
      rawPayload: { eventIds: claimed.map((row) => row.id) },
      rawEventCount: brainRefs.length > 0 ? newlyClaimedEventKeys.size : claimed.length,
      rawEventKeysByBrainRef: claimedEventKeysByBrainRef,
      kind: BRAIN_AGENT_INGEST_JOB_KIND,
      brainRefs,
      skipReason: ingestDecision.action === "skip" ? ingestDecision.reason : null,
      now: flushedAt,
      db: tx,
    });

    await tx.execute(sql`
      UPDATE goat.hubspot_object_events
      SET source_item_id = ${upserted.sourceItemId}
      WHERE id IN (${sql.join(
        claimed.map((row) => sql`${row.id}`),
        sql`, `,
      )})
    `);
    for (const brainRef of brainRefs) {
      await attributeBrainSourceEventClaims({
        brainRef,
        sourceProvider: "hubspot",
        eventKeys: claimedEventKeysByBrainRef.get(brainRef) ?? [],
        sourceItemId: upserted.sourceItemId,
        db: tx,
      });
    }

    return {
      sourceItemId: upserted.sourceItemId,
      eventCount: claimed.length,
      enqueued: upserted.enqueued,
      skipped: upserted.skipped,
      ...(upserted.quotaUpdates ? { quotaUpdates: upserted.quotaUpdates } : {}),
    };
  });

  captureProductIngestionQuotaAnalytics(result?.quotaUpdates);
  if (result?.enqueued) wakeBrainIngestWorker();
  return result;
}

export function buildHubspotObjectWindowItem(input: {
  window: HubspotDueWindow;
  events: readonly BufferedHubspotEventRow[];
  snapshot: HubspotObjectSnapshot | null;
  flushedAt: Date;
}): NormalizedHubspotObjectSourceItem {
  const { window, events, snapshot } = input;
  const activity = events.map((row) => toNormalizedActivity(row));

  return normalizeHubspotObjectWindow({
    windowId: newHubspotObjectWindowId(),
    portalId: window.portalId,
    objectType: window.objectType,
    objectId: window.objectId,
    name: snapshot?.name ?? nameFromBufferedEvents(window.objectType, events) ?? window.objectId,
    activity,
    flushedAt: input.flushedAt.toISOString(),
    ...(snapshot
      ? {
          url: snapshot.url,
          ...(snapshot.lifecycleStage ? { lifecycleStage: snapshot.lifecycleStage } : {}),
          ...(snapshot.stage ? { stage: snapshot.stage } : {}),
          ...(snapshot.pipeline ? { pipeline: snapshot.pipeline } : {}),
          ...(snapshot.amount ? { amount: snapshot.amount } : {}),
          ...(snapshot.closeDate ? { closeDate: snapshot.closeDate } : {}),
          properties: snapshot.properties,
          ...(snapshot.associatedCompanies
            ? { associatedCompanies: snapshot.associatedCompanies }
            : {}),
          ...(snapshot.associatedContacts
            ? { associatedContacts: snapshot.associatedContacts }
            : {}),
          ...(snapshot.createdAt ? { createdAt: snapshot.createdAt } : {}),
          ...(snapshot.updatedAt ? { updatedAt: snapshot.updatedAt } : {}),
        }
      : { snapshotStale: true }),
  });
}

export function startHubspotFlushWorker(env: RunnerEnv, options: { pollIntervalMs?: number } = {}) {
  const pollIntervalMs = Math.max(1_000, options.pollIntervalMs ?? HUBSPOT_FLUSH_POLL_INTERVAL_MS);
  return createPollingWorker({
    pollIntervalMs,
    poll: async ({ signal, stopping }) => {
      signal.throwIfAborted();
      const due = await listDueHubspotObjectWindows({});
      for (const window of due) {
        if (stopping()) break;
        const flushed = await flushHubspotObjectWindow(window, env).catch((error) => {
          if (signal.aborted) throw error;
          captureException(error, {
            event: "opencompany.goat_hubspot_flush_failed",
            integration_id: window.integrationId,
            object_type: window.objectType,
            object_id: window.objectId,
          });
          logger.error("opencompany HubSpot window flush failed", {
            event: "opencompany.goat_hubspot_flush_failed",
            integration_id: window.integrationId,
            object_type: window.objectType,
            object_id: window.objectId,
            error,
          });
          return null;
        });
        if (flushed) {
          logger.info("opencompany HubSpot window flushed", {
            event: "opencompany.goat_hubspot_window_flushed",
            integration_id: window.integrationId,
            object_type: window.objectType,
            object_id: window.objectId,
            source_item_id: flushed.sourceItemId,
            event_count: flushed.eventCount,
            enqueued: flushed.enqueued,
            skipped: flushed.skipped,
          });
        }
      }
    },
    onError: (error) => {
      captureException(error, { event: "opencompany.goat_hubspot_flush_worker_failed" });
      logger.error("opencompany HubSpot flush worker failed", {
        event: "opencompany.goat_hubspot_flush_worker_failed",
        error,
      });
    },
  });
}

async function previewBufferedHubspotEvents(window: HubspotDueWindow) {
  return rowsFromExecute<BufferedHubspotEventRow>(
    await getDb().execute(sql`
      SELECT
        id,
        delivery_id AS "deliveryId",
        action,
        property_name AS "propertyName",
        payload,
        event_time AS "eventTime"
      FROM goat.hubspot_object_events
      WHERE integration_id = ${window.integrationId}
        AND object_type = ${window.objectType}
        AND object_id = ${window.objectId}
        AND source_item_id IS NULL
      ORDER BY event_time ASC, id ASC
      LIMIT ${HUBSPOT_MAX_WINDOW_EVENTS}
    `),
  );
}

async function loadHubspotIntegrationStatus(
  window: HubspotDueWindow,
): Promise<IntegrationStatus | "unknown"> {
  const statusRows = rowsFromExecute<{ status: IntegrationStatus }>(
    await getDb().execute(sql`
      SELECT status FROM goat.integrations WHERE id = ${window.integrationId}
    `),
  );
  return statusRows[0]?.status ?? "unknown";
}

// Raw db.execute skips Drizzle's column mapping, so timestamptz comes back as
// a string; coerce before formatting.
function eventTimeIso(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function toNormalizedActivity(row: BufferedHubspotEventRow): NormalizedHubspotObjectActivity {
  const propertyValue = asString(row.payload.propertyValue);
  const changeSource = asString(row.payload.changeSource);
  return {
    occurredAt: eventTimeIso(row.eventTime),
    action: row.action,
    ...(row.propertyName ? { propertyName: row.propertyName } : {}),
    ...(propertyValue
      ? { propertyValue: propertyValue.slice(0, ACTIVITY_PROPERTY_VALUE_MAX_CHARS) }
      : {}),
    ...(changeSource ? { changeSource } : {}),
  };
}

function eventsMatchHubspotRoute(
  config: Parameters<typeof hubspotRouteMatchesEvent>[0],
  events: readonly BufferedHubspotEventRow[],
) {
  return events.some((row) =>
    hubspotRouteMatchesEvent(
      config,
      hubspotEventTypeFor({ action: row.action, propertyName: row.propertyName }),
    ),
  );
}

// Fallback when the live snapshot is unavailable: the buffered property
// changes may carry the record's name; the newest value wins.
function nameFromBufferedEvents(
  objectType: HubspotObjectType,
  events: readonly BufferedHubspotEventRow[],
): string | null {
  const nameProperties = NAME_PROPERTIES[objectType];
  const values = new Map<string, string>();
  for (const row of events) {
    if (!row.propertyName || !nameProperties.includes(row.propertyName)) continue;
    const value = asString(row.payload.propertyValue);
    if (value) values.set(row.propertyName, value);
  }
  if (values.size === 0) return null;
  if (objectType === "contact") {
    const fullName = [values.get("firstname"), values.get("lastname")]
      .filter(Boolean)
      .join(" ")
      .trim();
    return fullName || values.get("email") || null;
  }
  if (objectType === "company") return values.get("name") ?? values.get("domain") ?? null;
  return values.get("dealname") ?? null;
}

export type HubspotObjectWindowIngestDecision =
  | { action: "ingest" }
  | { action: "skip"; reason: "routine_hubspot_property_update" };

// Property updates that are pure CRM bookkeeping: ownership shuffles, counter
// rollups, and system attribution. A window made only of these carries no
// durable knowledge; anything else (creation, stage move, real field edit)
// goes to the agent, whose skip sentinel handles the remaining judgment.
const ROUTINE_HUBSPOT_UPDATE_PROPERTIES = new Set([
  "hubspot_owner_id",
  "hubspot_owner_assigneddate",
  "hubspot_team_id",
  "hs_all_owner_ids",
  "hs_all_team_ids",
  "hs_all_accessible_team_ids",
  "hs_user_ids_of_all_owners",
  "hs_created_by_user_id",
  "hs_updated_by_user_id",
  "hs_object_source",
  "hs_object_source_id",
  "hs_object_source_label",
  "num_associated_contacts",
  "num_associated_deals",
]);

export function classifyHubspotObjectWindowForIngest(
  item: NormalizedHubspotObjectSourceItem,
): HubspotObjectWindowIngestDecision {
  const object = item.content.object;
  for (const activity of object.activity) {
    if (activity.action !== "update") return { action: "ingest" };
    const normalized = activity.propertyName?.toLowerCase();
    if (!normalized || !ROUTINE_HUBSPOT_UPDATE_PROPERTIES.has(normalized)) {
      return { action: "ingest" };
    }
  }
  return { action: "skip", reason: "routine_hubspot_property_update" };
}

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}
