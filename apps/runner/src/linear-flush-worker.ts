import { captureProductIngestionQuotaAnalytics } from "@opencompany/analytics/product";
import {
  type NormalizedLinearIssueActivity,
  type NormalizedLinearIssueComment,
  type NormalizedLinearIssueSourceItem,
  normalizeLinearIssueWindow,
} from "@opencompany/brain";
import {
  attributeBrainSourceEventClaims,
  claimBrainSourceEvents,
} from "@opencompany/db/brain-event-claims";
import {
  BRAIN_AGENT_INGEST_JOB_KIND,
  upsertBrainSourceItemAndEnqueue,
} from "@opencompany/db/brain-ingest";
import { loadIntegrationCredential } from "@opencompany/db/integrations";
import {
  type LinearBrainSourceRoute,
  type LinearWikiSourceRoute,
  linearEventTypeFor,
  linearRouteMatchesEvent,
  linearSelectedTeamIds,
  listEnabledLinearBrainSourceRoutes,
  listEnabledLinearWikiSourceRoutes,
  newLinearIssueWindowId,
} from "@opencompany/db/linear";
import type {
  IntegrationStatus,
  LinearEventAction,
  LinearEventEntityType,
} from "@opencompany/db/product-schema";
import {
  attributeWikiSourceEventClaims,
  claimWikiSourceEvents,
} from "@opencompany/db/wiki-event-claims";
import { upsertWikiSourceItemAndEnqueue } from "@opencompany/db/wiki-ingest";
import { captureException, createLogger } from "@opencompany/observability";
import { sql } from "drizzle-orm";
import { wakeBrainIngestWorker } from "./brain-ingest-worker";
import { getDb } from "./db";
import { fetchLinearIssueSnapshot, type LinearIssueSnapshot } from "./linear-api";
import { createPollingWorker } from "./polling-worker";
import { rowsFromExecute } from "./sql-exec";
import { wakeWikiIngestWorker } from "./wiki-ingest-worker";

const logger = createLogger({ service: "opencompany-runner", runtime: "goat-linear-flush" });

// A window flushes after the issue has been quiet for the quiet period, or
// once its oldest buffered event has waited out the max wait — whichever comes
// first. One agent ingest session then covers the whole window. Issues change
// in slower bursts than chat, so the windows are wider than Slack's.
export const LINEAR_QUIET_PERIOD_MS = 15 * 60_000;
export const LINEAR_MAX_WAIT_MS = 2 * 60 * 60_000;
export const LINEAR_MAX_WINDOW_EVENTS = 200;
const LINEAR_FLUSH_POLL_INTERVAL_MS = 60_000;

export type LinearDueWindow = {
  integrationId: string;
  userWorkosId: string;
  organizationId: string;
  issueId: string;
};

export type BufferedLinearEventRow = {
  id: string;
  deliveryId: string;
  teamId: string | null;
  entityType: LinearEventEntityType;
  action: LinearEventAction;
  issueTitle: string | null;
  actorName: string | null;
  payload: Record<string, unknown>;
  eventTime: string | Date;
};

export async function listDueLinearIssueWindows(input: {
  now?: Date;
  quietPeriodMs?: number;
  maxWaitMs?: number;
}): Promise<LinearDueWindow[]> {
  const now = input.now ?? new Date();
  const quietCutoff = new Date(now.getTime() - (input.quietPeriodMs ?? LINEAR_QUIET_PERIOD_MS));
  const maxWaitCutoff = new Date(now.getTime() - (input.maxWaitMs ?? LINEAR_MAX_WAIT_MS));
  const result = await getDb().execute(sql`
    SELECT
      integration_id AS "integrationId",
      user_workos_id AS "userWorkosId",
      organization_id AS "organizationId",
      issue_id AS "issueId"
    FROM goat.linear_issue_events
    WHERE source_item_id IS NULL
    GROUP BY 1, 2, 3, 4
    HAVING max(received_at) < ${quietCutoff} OR min(received_at) < ${maxWaitCutoff}
  `);
  return rowsFromExecute<LinearDueWindow>(result);
}

export async function flushLinearIssueWindow(window: LinearDueWindow): Promise<{
  sourceItemId: string;
  eventCount: number;
  enqueued: boolean;
  skipped: boolean;
} | null> {
  const db = getDb();

  // Enrichment happens before the transaction so no network call ever holds
  // row locks. An event that slips in mid-flush stays pending and seeds the
  // next window anyway.
  const preview = await previewBufferedLinearEvents(window);
  if (preview.length === 0) return null;
  const integration = await loadLinearIntegrationContext(window);
  const snapshot = integration.accessToken
    ? await fetchLinearIssueSnapshot({
        token: integration.accessToken,
        issueId: window.issueId,
      })
    : null;

  const flushedAt = new Date();
  let brainEnqueued = false;
  let wikiEnqueued = false;
  const result = await db.transaction(async (tx) => {
    const claimed = rowsFromExecute<BufferedLinearEventRow>(
      await tx.execute(sql`
        SELECT
          id,
          delivery_id AS "deliveryId",
          team_id AS "teamId",
          entity_type AS "entityType",
          action,
          issue_title AS "issueTitle",
          actor_name AS "actorName",
          payload,
          event_time AS "eventTime"
        FROM goat.linear_issue_events
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

    const item = buildLinearIssueWindowItem({
      window,
      events: claimed,
      snapshot,
      organizationUrlKey: integration.organizationUrlKey,
      flushedAt,
    });
    const ingestDecision = classifyLinearIssueWindowForIngest(item);

    // Routing is re-resolved at flush time: the user may have deselected the
    // team or disabled the source since the events were buffered. A revoked
    // integration still flushes (persisting the window) with no jobs, so the
    // buffer never wedges on a dead token.
    const brainRoutes =
      integration.status === "connected"
        ? await listEnabledLinearBrainSourceRoutes([window.integrationId], tx)
        : [];
    const wikiRoutes =
      integration.status === "connected"
        ? await listEnabledLinearWikiSourceRoutes([window.integrationId], tx)
        : [];
    const teamId = snapshot?.teamId ?? claimed.find((row) => row.teamId)?.teamId ?? null;
    const resolvedRoutes = resolveLinearIssueWindowRoutes({
      brainRoutes,
      wikiRoutes,
      teamId,
      events: claimed,
    });

    // Cross-member dedup: one webhook delivery buffers once per integration of
    // the same Linear organization, so the delivery id is the identity shared
    // across members. A brain whose claims all lose (issue window already
    // ingested via another member's integration) is skipped — no job, no billing.
    const eventKeys = claimed.map(
      (row) => `${window.organizationId}:${window.issueId}:${row.deliveryId}`,
    );
    const brainRefs: string[] = [];
    const claimedEventKeysByBrainRef = new Map<string, string[]>();
    const newlyClaimedEventKeys = new Set<string>();
    for (const brainRef of new Set(resolvedRoutes.brainRefs)) {
      const { claimedEventKeys } = await claimBrainSourceEvents({
        brainRef,
        sourceProvider: "linear",
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
    brainEnqueued = upserted.enqueued;

    for (const workspaceId of new Set(resolvedRoutes.wikiWorkspaceIds)) {
      const claim = await claimWikiSourceEvents({
        workspaceId,
        sourceProvider: "linear",
        eventKeys,
        db: tx,
      });
      if (claim.claimedCount === 0) continue;

      const wikiResult = await upsertWikiSourceItemAndEnqueue({
        workspaceId,
        sourceConnectionId: window.integrationId,
        integrationId: window.integrationId,
        item,
        rawPayload: { eventIds: claimed.map((row) => row.id) },
        rawEventCount: claim.claimedCount,
        now: flushedAt,
        db: tx,
      });
      await attributeWikiSourceEventClaims({
        workspaceId,
        sourceProvider: "linear",
        eventKeys: claim.claimedEventKeys,
        sourceItemId: wikiResult.sourceItemId,
        db: tx,
      });
      wikiEnqueued = wikiEnqueued || wikiResult.enqueued;
    }

    await tx.execute(sql`
      UPDATE goat.linear_issue_events
      SET source_item_id = ${upserted.sourceItemId}
      WHERE id IN (${sql.join(
        claimed.map((row) => sql`${row.id}`),
        sql`, `,
      )})
    `);
    for (const brainRef of brainRefs) {
      await attributeBrainSourceEventClaims({
        brainRef,
        sourceProvider: "linear",
        eventKeys: claimedEventKeysByBrainRef.get(brainRef) ?? [],
        sourceItemId: upserted.sourceItemId,
        db: tx,
      });
    }

    return {
      sourceItemId: upserted.sourceItemId,
      eventCount: claimed.length,
      enqueued: upserted.enqueued || wikiEnqueued,
      skipped: upserted.skipped,
      ...(upserted.quotaUpdates ? { quotaUpdates: upserted.quotaUpdates } : {}),
    };
  });

  captureProductIngestionQuotaAnalytics(result?.quotaUpdates);
  if (brainEnqueued) wakeBrainIngestWorker();
  if (wikiEnqueued) wakeWikiIngestWorker();
  return result;
}

export function resolveLinearIssueWindowRoutes(input: {
  brainRoutes: readonly LinearBrainSourceRoute[];
  wikiRoutes: readonly LinearWikiSourceRoute[];
  teamId: string | null;
  events: readonly BufferedLinearEventRow[];
}) {
  const matches = (route: LinearBrainSourceRoute | LinearWikiSourceRoute) => {
    const selected = linearSelectedTeamIds(route.config);
    if (selected.size === 0) return false;
    if (!eventsMatchLinearRoute(route.config, input.events)) return false;
    // Without a resolvable team (deleted issue with team-less buffered
    // comments) the window cannot be routed confidently.
    return input.teamId ? selected.has(input.teamId) : false;
  };
  return {
    brainRefs: input.brainRoutes.filter(matches).map((route) => route.brainRef),
    wikiWorkspaceIds: input.wikiRoutes.filter(matches).map((route) => route.workspaceId),
  };
}

export function buildLinearIssueWindowItem(input: {
  window: LinearDueWindow;
  events: readonly BufferedLinearEventRow[];
  snapshot: LinearIssueSnapshot | null;
  organizationUrlKey: string | null;
  flushedAt: Date;
}) {
  const { window, events, snapshot } = input;
  const activity = events.map((row) => toNormalizedActivity(row));
  const comments = snapshot ? snapshot.comments : commentsFromBufferedEvents(events);
  const lastTitled = [...events].reverse().find((row) => row.issueTitle);

  return normalizeLinearIssueWindow({
    windowId: newLinearIssueWindowId(),
    organizationId: window.organizationId,
    issueId: window.issueId,
    title: snapshot?.title ?? lastTitled?.issueTitle ?? window.issueId,
    activity,
    comments,
    flushedAt: input.flushedAt.toISOString(),
    ...(input.organizationUrlKey ? { organizationUrlKey: input.organizationUrlKey } : {}),
    ...(snapshot
      ? {
          ...(snapshot.identifier ? { identifier: snapshot.identifier } : {}),
          ...(snapshot.url ? { url: snapshot.url } : {}),
          ...(snapshot.description ? { description: snapshot.description } : {}),
          ...(snapshot.state ? { state: snapshot.state } : {}),
          ...(snapshot.stateType ? { stateType: snapshot.stateType } : {}),
          ...(snapshot.priority ? { priority: snapshot.priority } : {}),
          ...(snapshot.assigneeName ? { assigneeName: snapshot.assigneeName } : {}),
          ...(snapshot.creatorName ? { creatorName: snapshot.creatorName } : {}),
          ...(snapshot.projectName ? { projectName: snapshot.projectName } : {}),
          ...(snapshot.labels ? { labels: snapshot.labels } : {}),
          ...(snapshot.dueDate ? { dueDate: snapshot.dueDate } : {}),
          ...(typeof snapshot.estimate === "number" ? { estimate: snapshot.estimate } : {}),
          ...(snapshot.createdAt ? { createdAt: snapshot.createdAt } : {}),
          ...(snapshot.updatedAt ? { updatedAt: snapshot.updatedAt } : {}),
          ...(snapshot.completedAt ? { completedAt: snapshot.completedAt } : {}),
          ...(snapshot.canceledAt ? { canceledAt: snapshot.canceledAt } : {}),
          ...(snapshot.teamId ? { teamId: snapshot.teamId } : {}),
          ...(snapshot.teamKey ? { teamKey: snapshot.teamKey } : {}),
          ...(snapshot.teamName ? { teamName: snapshot.teamName } : {}),
        }
      : {
          snapshotStale: true,
          ...(events.find((row) => row.teamId)?.teamId
            ? { teamId: events.find((row) => row.teamId)!.teamId! }
            : {}),
        }),
  });
}

export function startLinearFlushWorker(options: { pollIntervalMs?: number } = {}) {
  const pollIntervalMs = Math.max(1_000, options.pollIntervalMs ?? LINEAR_FLUSH_POLL_INTERVAL_MS);
  return createPollingWorker({
    pollIntervalMs,
    poll: async ({ signal, stopping }) => {
      signal.throwIfAborted();
      const due = await listDueLinearIssueWindows({});
      for (const window of due) {
        if (stopping()) break;
        const flushed = await flushLinearIssueWindow(window).catch((error) => {
          if (signal.aborted) throw error;
          captureException(error, {
            event: "opencompany.goat_linear_flush_failed",
            integration_id: window.integrationId,
            issue_id: window.issueId,
          });
          logger.error("opencompany Linear window flush failed", {
            event: "opencompany.goat_linear_flush_failed",
            integration_id: window.integrationId,
            issue_id: window.issueId,
            error,
          });
          return null;
        });
        if (flushed) {
          logger.info("opencompany Linear window flushed", {
            event: "opencompany.goat_linear_window_flushed",
            integration_id: window.integrationId,
            issue_id: window.issueId,
            source_item_id: flushed.sourceItemId,
            event_count: flushed.eventCount,
            enqueued: flushed.enqueued,
            skipped: flushed.skipped,
          });
        }
      }
    },
    onError: (error) => {
      captureException(error, { event: "opencompany.goat_linear_flush_worker_failed" });
      logger.error("opencompany Linear flush worker failed", {
        event: "opencompany.goat_linear_flush_worker_failed",
        error,
      });
    },
  });
}

async function previewBufferedLinearEvents(window: LinearDueWindow) {
  return rowsFromExecute<BufferedLinearEventRow>(
    await getDb().execute(sql`
      SELECT
        id,
        team_id AS "teamId",
        entity_type AS "entityType",
        action,
        issue_title AS "issueTitle",
        actor_name AS "actorName",
        payload,
        event_time AS "eventTime"
      FROM goat.linear_issue_events
      WHERE integration_id = ${window.integrationId}
        AND issue_id = ${window.issueId}
        AND source_item_id IS NULL
      ORDER BY event_time ASC, id ASC
      LIMIT ${LINEAR_MAX_WINDOW_EVENTS}
    `),
  );
}

async function loadLinearIntegrationContext(window: LinearDueWindow): Promise<{
  status: IntegrationStatus | "unknown";
  accessToken: string | null;
  organizationUrlKey: string | null;
}> {
  const statusRows = rowsFromExecute<{ status: IntegrationStatus }>(
    await getDb().execute(sql`
      SELECT status FROM goat.integrations WHERE id = ${window.integrationId}
    `),
  );
  const status = statusRows[0]?.status ?? "unknown";

  const credential =
    status === "connected"
      ? await loadIntegrationCredential({
          userWorkosId: window.userWorkosId,
          integrationId: window.integrationId,
          provider: "linear",
          kind: "oauth_token",
        }).catch((error) => {
          logger.warn("opencompany Linear credential load failed", {
            event: "opencompany.goat_linear_credential_load_failed",
            integration_id: window.integrationId,
            error,
          });
          return null;
        })
      : null;

  const accessToken = credential?.payload.access_token;
  const organizationUrlKey = credential?.payload.organization_url_key;
  return {
    status,
    accessToken: typeof accessToken === "string" && accessToken ? accessToken : null,
    organizationUrlKey:
      typeof organizationUrlKey === "string" && organizationUrlKey ? organizationUrlKey : null,
  };
}

// Raw db.execute skips Drizzle's column mapping, so timestamptz comes back as
// a string; coerce before formatting.
function eventTimeIso(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function toNormalizedActivity(row: BufferedLinearEventRow): NormalizedLinearIssueActivity {
  const data = asRecord(row.payload.data);
  const updatedFrom = asRecord(row.payload.updatedFrom);
  const changedFields = updatedFrom
    ? Object.keys(updatedFrom).filter((key) => key !== "updatedAt")
    : [];
  const commentId = row.entityType === "comment" ? asString(data?.id) : null;
  const commentBody = row.entityType === "comment" ? asString(data?.body) : null;
  return {
    occurredAt: eventTimeIso(row.eventTime),
    entityType: row.entityType,
    action: row.action,
    ...(row.actorName ? { actorName: row.actorName } : {}),
    ...(changedFields.length > 0 ? { changedFields } : {}),
    ...(commentId ? { commentId } : {}),
    ...(commentBody ? { commentBody } : {}),
  };
}

function eventsMatchLinearRoute(
  config: Parameters<typeof linearRouteMatchesEvent>[0],
  events: readonly BufferedLinearEventRow[],
) {
  return events.some((row) => {
    const eventType = linearEventTypeFor({
      entityType: row.entityType,
      action: row.action,
      updatedFrom: asRecord(row.payload.updatedFrom),
    });
    return eventType ? linearRouteMatchesEvent(config, eventType) : false;
  });
}

export type LinearIssueWindowIngestDecision =
  | { action: "ingest" }
  | { action: "skip"; reason: "routine_linear_status_change" | "routine_linear_metadata_update" };

const ROUTINE_LINEAR_ISSUE_UPDATE_FIELDS = new Set([
  "assignee",
  "assigneeid",
  "assigneename",
  "canceledat",
  "completedat",
  "cycle",
  "cycleid",
  "estimate",
  "priority",
  "prioritylabel",
  "state",
  "stateid",
  "statetype",
  "status",
  "statusid",
]);

const LINEAR_STATUS_FIELDS = new Set([
  "canceledat",
  "completedat",
  "state",
  "stateid",
  "statetype",
  "status",
  "statusid",
]);

export function classifyLinearIssueWindowForIngest(
  item: NormalizedLinearIssueSourceItem,
): LinearIssueWindowIngestDecision {
  const issue = item.content.issue;
  if (issue.snapshotStale) return { action: "ingest" };
  if (issue.activity.length === 0) {
    return { action: "skip", reason: "routine_linear_metadata_update" };
  }

  let sawStatusField = false;
  for (const activity of issue.activity) {
    if (activity.entityType !== "issue" || activity.action !== "update") {
      return { action: "ingest" };
    }
    const changedFields = activity.changedFields ?? [];
    if (changedFields.length === 0) return { action: "ingest" };
    for (const field of changedFields) {
      const normalized = field.toLowerCase();
      if (!ROUTINE_LINEAR_ISSUE_UPDATE_FIELDS.has(normalized)) {
        return { action: "ingest" };
      }
      if (LINEAR_STATUS_FIELDS.has(normalized)) sawStatusField = true;
    }
  }

  return {
    action: "skip",
    reason: sawStatusField ? "routine_linear_status_change" : "routine_linear_metadata_update",
  };
}

// Fallback when the live snapshot is unavailable: reconstruct the comments the
// window itself carried so the ingest agent still sees the discussion.
function commentsFromBufferedEvents(
  events: readonly BufferedLinearEventRow[],
): NormalizedLinearIssueComment[] {
  const byId = new Map<string, NormalizedLinearIssueComment>();
  for (const row of events) {
    if (row.entityType !== "comment") continue;
    const data = asRecord(row.payload.data);
    const id = asString(data?.id);
    const body = asString(data?.body);
    if (!id || !body) continue;
    const createdAt = asString(data?.createdAt) ?? eventTimeIso(row.eventTime);
    byId.set(id, {
      id,
      body,
      ...(row.actorName ? { authorName: row.actorName } : {}),
      createdAt,
    });
  }
  return [...byId.values()];
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
