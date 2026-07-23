import { captureGoatIngestionQuotaAnalytics } from "@opencompany/analytics/goat";
import {
  attributeGoatBrainSourceEventClaims,
  claimGoatBrainSourceEvents,
} from "@opencompany/db/goat-brain-event-claims";
import {
  GOAT_BRAIN_AGENT_INGEST_JOB_KIND,
  upsertGoatBrainSourceItemAndEnqueue,
} from "@opencompany/db/goat-brain-ingest";
import {
  goatGitHubEnabledEventTypes,
  goatGitHubSelectedRepoIds,
  listEnabledGoatGitHubBrainSourceRoutes,
  newGoatGitHubPullRequestWindowId,
} from "@opencompany/db/goat-github";
import type {
  GoatGitHubPullRequestEventType,
  GoatIntegrationStatus,
} from "@opencompany/db/goat-schema";
import {
  type NormalizedGitHubActivitySourceItem,
  normalizeGitHubActivityWebhook,
  normalizeGitHubPullRequestWindow,
} from "@opencompany/goat-brain";
import { captureException, createLogger } from "@opencompany/observability";
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import { wakeGoatBrainIngestWorker } from "./goat-brain-ingest-worker";
import { rowsFromExecute } from "./sql-exec";

const logger = createLogger({ service: "opencompany-runner", runtime: "goat-github-flush" });

// Pull-request activity flushes after 45 minutes of quiet, or once the oldest
// event has waited four hours. This collapses the common open -> discussion ->
// merge lifecycle without leaving an active PR invisible indefinitely.
export const GOAT_GITHUB_QUIET_PERIOD_MS = 45 * 60_000;
export const GOAT_GITHUB_MAX_WAIT_MS = 4 * 60 * 60_000;
export const GOAT_GITHUB_MAX_WINDOW_EVENTS = 200;
const GOAT_GITHUB_FLUSH_POLL_INTERVAL_MS = 60_000;

export type GoatGitHubDueWindow = {
  integrationId: string;
  userWorkosId: string;
  installationId: string;
  repositoryId: string;
  pullRequestNumber: number;
};

export type BufferedGitHubPullRequestEventRow = {
  id: string;
  deliveryId: string;
  eventType: GoatGitHubPullRequestEventType;
  payload: Record<string, unknown>;
  eventTime: string | Date;
  receivedAt: string | Date;
};

export async function listDueGoatGitHubPullRequestWindows(input: {
  now?: Date;
  quietPeriodMs?: number;
  maxWaitMs?: number;
}): Promise<GoatGitHubDueWindow[]> {
  const now = input.now ?? new Date();
  const quietCutoff = new Date(
    now.getTime() - (input.quietPeriodMs ?? GOAT_GITHUB_QUIET_PERIOD_MS),
  );
  const maxWaitCutoff = new Date(now.getTime() - (input.maxWaitMs ?? GOAT_GITHUB_MAX_WAIT_MS));
  const result = await getDb().execute(sql`
    SELECT
      integration_id AS "integrationId",
      user_workos_id AS "userWorkosId",
      installation_id AS "installationId",
      repository_id AS "repositoryId",
      pull_request_number AS "pullRequestNumber"
    FROM goat.github_pull_request_events
    WHERE source_item_id IS NULL
    GROUP BY 1, 2, 3, 4, 5
    HAVING max(received_at) < ${quietCutoff} OR min(received_at) < ${maxWaitCutoff}
  `);
  return rowsFromExecute<GoatGitHubDueWindow>(result);
}

export async function flushGoatGitHubPullRequestWindow(window: GoatGitHubDueWindow): Promise<{
  sourceItemId: string;
  eventCount: number;
  enqueued: boolean;
} | null> {
  const db = getDb();
  const preview = await previewBufferedGitHubPullRequestEvents(window);
  if (preview.length === 0) return null;
  const status = await loadGitHubIntegrationStatus(window.integrationId);

  const flushedAt = new Date();
  const result = await db.transaction(async (tx) => {
    const claimed = rowsFromExecute<BufferedGitHubPullRequestEventRow>(
      await tx.execute(sql`
        SELECT
          id,
          delivery_id AS "deliveryId",
          event_type AS "eventType",
          payload,
          event_time AS "eventTime",
          received_at AS "receivedAt"
        FROM goat.github_pull_request_events
        WHERE id IN (${sql.join(
          preview.map((row) => sql`${row.id}`),
          sql`, `,
        )})
          AND source_item_id IS NULL
        ORDER BY event_time ASC, id ASC
        FOR UPDATE SKIP LOCKED
      `),
    );
    // Another sweeper may have claimed the same due window first. If it
    // claimed only part of our preview, leave the remainder for the next poll
    // so the source item always matches the exact locked event set.
    if (claimed.length === 0) return null;
    if (claimed.length !== preview.length) return null;

    const item = buildGitHubPullRequestWindowItem({
      window,
      events: claimed,
      flushedAt,
    });

    // Re-resolve routing at flush time in case a repo/event selection changed
    // while the PR was buffered. Disconnected integrations still drain to a
    // persisted source item with no jobs so stale buffers cannot wedge.
    const routes =
      status === "connected"
        ? await listEnabledGoatGitHubBrainSourceRoutes([window.integrationId], tx)
        : [];
    const eventTypes = new Set(claimed.map((row) => row.eventType));
    const candidateBrainRefs = routes
      .filter((route) => {
        if (!goatGitHubSelectedRepoIds(route.config).has(window.repositoryId)) return false;
        const enabled = goatGitHubEnabledEventTypes(route.config);
        return [...eventTypes].some((eventType) => enabled.has(eventType));
      })
      .map((route) => route.brainRef);

    // A GitHub App delivery fans out to every integration bound to its
    // installation. Claim the provider delivery per brain so overlapping
    // member routes do not create duplicate jobs or billing reservations.
    const eventKeys = claimed.map(
      (row) =>
        `${window.installationId}:${window.repositoryId}:${window.pullRequestNumber}:${row.deliveryId}`,
    );
    const brainRefs: string[] = [];
    const claimedEventKeysByBrainRef = new Map<string, string[]>();
    const newlyClaimedEventKeys = new Set<string>();
    for (const brainRef of new Set(candidateBrainRefs)) {
      const { claimedEventKeys } = await claimGoatBrainSourceEvents({
        brainRef,
        sourceProvider: "github",
        eventKeys,
        db: tx,
      });
      if (claimedEventKeys.length === 0) continue;
      brainRefs.push(brainRef);
      claimedEventKeysByBrainRef.set(brainRef, claimedEventKeys);
      for (const eventKey of claimedEventKeys) newlyClaimedEventKeys.add(eventKey);
    }

    const upserted = await upsertGoatBrainSourceItemAndEnqueue({
      userWorkosId: window.userWorkosId,
      sourceConnectionId: window.integrationId,
      integrationId: window.integrationId,
      item,
      rawPayload: { eventIds: claimed.map((row) => row.id) },
      rawEventCount: brainRefs.length > 0 ? newlyClaimedEventKeys.size : claimed.length,
      rawEventKeysByBrainRef: claimedEventKeysByBrainRef,
      kind: GOAT_BRAIN_AGENT_INGEST_JOB_KIND,
      brainRefs,
      now: flushedAt,
      db: tx,
    });

    await tx.execute(sql`
      UPDATE goat.github_pull_request_events
      SET source_item_id = ${upserted.sourceItemId}
      WHERE id IN (${sql.join(
        claimed.map((row) => sql`${row.id}`),
        sql`, `,
      )})
    `);
    for (const brainRef of brainRefs) {
      await attributeGoatBrainSourceEventClaims({
        brainRef,
        sourceProvider: "github",
        eventKeys: claimedEventKeysByBrainRef.get(brainRef) ?? [],
        sourceItemId: upserted.sourceItemId,
        db: tx,
      });
    }

    return {
      sourceItemId: upserted.sourceItemId,
      eventCount: claimed.length,
      enqueued: upserted.enqueued,
      ...(upserted.quotaUpdates ? { quotaUpdates: upserted.quotaUpdates } : {}),
    };
  });

  captureGoatIngestionQuotaAnalytics(result?.quotaUpdates);
  if (result?.enqueued) wakeGoatBrainIngestWorker();
  return result;
}

export function buildGitHubPullRequestWindowItem(input: {
  window: GoatGitHubDueWindow;
  events: readonly BufferedGitHubPullRequestEventRow[];
  flushedAt: Date;
}): NormalizedGitHubActivitySourceItem {
  const normalizedEvents = input.events.map((event) => {
    const eventName =
      event.eventType === "pull_request_commented" ? "issue_comment" : "pull_request";
    const item = normalizeGitHubActivityWebhook(eventName, event.payload, {
      capturedAt: dateIso(event.receivedAt),
    });
    if (
      !item ||
      item.content.activity.kind !== "pull_request" ||
      item.content.activity.repository.id !== input.window.repositoryId ||
      item.content.activity.number !== input.window.pullRequestNumber
    ) {
      throw new Error(
        `Buffered GitHub event ${event.id} no longer matches its pull-request window.`,
      );
    }
    return item;
  });

  return normalizeGitHubPullRequestWindow({
    windowId: newGoatGitHubPullRequestWindowId(),
    events: normalizedEvents,
    flushedAt: input.flushedAt.toISOString(),
  });
}

export function startGoatGitHubFlushWorker(options: { pollIntervalMs?: number } = {}) {
  const pollIntervalMs = Math.max(
    1_000,
    options.pollIntervalMs ?? GOAT_GITHUB_FLUSH_POLL_INTERVAL_MS,
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
        const due = await listDueGoatGitHubPullRequestWindows({});
        for (const window of due) {
          if (stopped) break;
          const flushed = await flushGoatGitHubPullRequestWindow(window).catch((error) => {
            captureException(error, {
              event: "opencompany.goat_github_flush_failed",
              integration_id: window.integrationId,
              repository_id: window.repositoryId,
              pull_request_number: window.pullRequestNumber,
            });
            logger.error("Goat GitHub pull-request window flush failed", {
              event: "opencompany.goat_github_flush_failed",
              integration_id: window.integrationId,
              repository_id: window.repositoryId,
              pull_request_number: window.pullRequestNumber,
              error,
            });
            return null;
          });
          if (flushed) {
            logger.info("Goat GitHub pull-request window flushed", {
              event: "opencompany.goat_github_window_flushed",
              integration_id: window.integrationId,
              repository_id: window.repositoryId,
              pull_request_number: window.pullRequestNumber,
              source_item_id: flushed.sourceItemId,
              event_count: flushed.eventCount,
              enqueued: flushed.enqueued,
            });
          }
        }
      } catch (error) {
        captureException(error, { event: "opencompany.goat_github_flush_worker_failed" });
        logger.error("Goat GitHub flush worker failed", {
          event: "opencompany.goat_github_flush_worker_failed",
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

async function previewBufferedGitHubPullRequestEvents(window: GoatGitHubDueWindow) {
  return rowsFromExecute<BufferedGitHubPullRequestEventRow>(
    await getDb().execute(sql`
      SELECT
        id,
        delivery_id AS "deliveryId",
        event_type AS "eventType",
        payload,
        event_time AS "eventTime",
        received_at AS "receivedAt"
      FROM goat.github_pull_request_events
      WHERE integration_id = ${window.integrationId}
        AND repository_id = ${window.repositoryId}
        AND pull_request_number = ${window.pullRequestNumber}
        AND source_item_id IS NULL
      ORDER BY event_time ASC, id ASC
      LIMIT ${GOAT_GITHUB_MAX_WINDOW_EVENTS}
    `),
  );
}

async function loadGitHubIntegrationStatus(
  integrationId: string,
): Promise<GoatIntegrationStatus | "unknown"> {
  const rows = rowsFromExecute<{ status: GoatIntegrationStatus }>(
    await getDb().execute(sql`
      SELECT status FROM goat.integrations WHERE id = ${integrationId}
    `),
  );
  return rows[0]?.status ?? "unknown";
}

// db.execute returns timestamptz columns as strings while unit builders often
// pass Dates; keep normalization deterministic across both paths.
function dateIso(value: string | Date) {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}
