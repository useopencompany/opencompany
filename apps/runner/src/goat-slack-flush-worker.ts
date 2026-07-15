import { captureGoatIngestionQuotaAnalytics } from "@opencompany/analytics/goat";
import {
  attributeGoatBrainSourceEventClaims,
  claimGoatBrainSourceEvents,
} from "@opencompany/db/goat-brain-event-claims";
import {
  GOAT_BRAIN_AGENT_INGEST_JOB_KIND,
  upsertGoatBrainSourceItemAndEnqueue,
} from "@opencompany/db/goat-brain-ingest";
import { loadGoatIntegrationCredential } from "@opencompany/db/goat-integrations";
import type { GoatIntegrationStatus, GoatSlackChannelType } from "@opencompany/db/goat-schema";
import {
  goatSlackSelectedConversationIds,
  listEnabledGoatSlackBrainSourceRoutes,
  newGoatSlackConversationWindowId,
} from "@opencompany/db/goat-slack";
import {
  type NormalizedSlackConversationMessage,
  normalizeSlackConversationWindow,
} from "@opencompany/goat-brain";
import { captureException, createLogger } from "@opencompany/observability";
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import { wakeGoatBrainIngestWorker } from "./goat-brain-ingest-worker";
import {
  fetchSlackConversationContext,
  getSlackConversationLabel,
  resolveSlackUserNames,
} from "./slack-api";
import { rowsFromExecute } from "./sql-exec";

const logger = createLogger({ service: "opencompany-runner", runtime: "goat-slack-flush" });

// A window flushes after the channel has been quiet for the quiet period, or
// once its oldest buffered message has waited out the max wait — whichever
// comes first. One agent ingest session then covers the whole window.
export const GOAT_SLACK_QUIET_PERIOD_MS = 12 * 60_000;
export const GOAT_SLACK_MAX_WAIT_MS = 60 * 60_000;
export const GOAT_SLACK_MAX_WINDOW_MESSAGES = 200;
const GOAT_SLACK_FLUSH_POLL_INTERVAL_MS = 60_000;

export type GoatSlackDueWindow = {
  integrationId: string;
  userWorkosId: string;
  teamId: string;
  channelId: string;
  channelType: GoatSlackChannelType;
};

type BufferedSlackMessageRow = {
  id: string;
  messageTs: string;
  threadTs: string | null;
  slackUserId: string | null;
  subtype: string | null;
  text: string;
  payload: Record<string, unknown>;
};

export async function listDueGoatSlackConversationWindows(input: {
  now?: Date;
  quietPeriodMs?: number;
  maxWaitMs?: number;
}): Promise<GoatSlackDueWindow[]> {
  const now = input.now ?? new Date();
  const quietCutoff = new Date(now.getTime() - (input.quietPeriodMs ?? GOAT_SLACK_QUIET_PERIOD_MS));
  const maxWaitCutoff = new Date(now.getTime() - (input.maxWaitMs ?? GOAT_SLACK_MAX_WAIT_MS));
  const result = await getDb().execute(sql`
    SELECT
      integration_id AS "integrationId",
      user_workos_id AS "userWorkosId",
      team_id AS "teamId",
      channel_id AS "channelId",
      channel_type AS "channelType"
    FROM goat.slack_message_events
    WHERE source_item_id IS NULL
    GROUP BY 1, 2, 3, 4, 5
    HAVING max(received_at) < ${quietCutoff} OR min(received_at) < ${maxWaitCutoff}
  `);
  return rowsFromExecute<GoatSlackDueWindow>(result);
}

export async function flushGoatSlackConversationWindow(window: GoatSlackDueWindow): Promise<{
  sourceItemId: string;
  messageCount: number;
  enqueued: boolean;
} | null> {
  const db = getDb();

  // Enrichment happens before the transaction so no network call ever holds
  // row locks. Names are resolved for the authors visible right now; a message
  // that slips in mid-flush stays pending and seeds the next window anyway.
  const preview = await previewBufferedSlackMessages(window);
  if (preview.length === 0) return null;
  const integration = await loadSlackIntegrationContext(window);
  const enrichment = integration.accessToken
    ? await enrichSlackWindow(window, preview, integration.accessToken)
    : { channelName: null, userNames: new Map<string, string>() };
  const currentMessages = preview.map((row) => toNormalizedMessage(row, enrichment.userNames));
  const context = integration.accessToken
    ? await fetchSlackConversationContext({
        token: integration.accessToken,
        teamId: window.teamId,
        channelId: window.channelId,
        windowStartTs: currentMessages[0]!.ts,
        currentMessages,
      })
    : undefined;

  const flushedAt = new Date();
  const result = await db.transaction(async (tx) => {
    const claimed = rowsFromExecute<BufferedSlackMessageRow>(
      await tx.execute(sql`
        SELECT
          id,
          message_ts AS "messageTs",
          thread_ts AS "threadTs",
          slack_user_id AS "slackUserId",
          subtype,
          text,
          payload
        FROM goat.slack_message_events
        WHERE id IN (${sql.join(
          preview.map((row) => sql`${row.id}`),
          sql`, `,
        )})
          AND source_item_id IS NULL
        ORDER BY message_ts ASC
        FOR UPDATE SKIP LOCKED
      `),
    );
    // Another sweeper may have claimed the same due window first.
    if (claimed.length === 0) return null;
    // Keep pre-fetched context aligned with the exact flushed window.
    if (claimed.length !== preview.length) return null;

    const item = normalizeSlackConversationWindow({
      windowId: newGoatSlackConversationWindowId(),
      teamId: window.teamId,
      ...(integration.teamDomain ? { teamDomain: integration.teamDomain } : {}),
      channelId: window.channelId,
      channelName: enrichment.channelName ?? window.channelId,
      channelType: window.channelType,
      messages: claimed.map((row) => toNormalizedMessage(row, enrichment.userNames)),
      ...(context ? { context } : {}),
      flushedAt: flushedAt.toISOString(),
    });

    // Routing is re-resolved at flush time: the user may have deselected the
    // channel or disabled the source since the messages were buffered. A
    // revoked integration still flushes (persisting the window) with no jobs,
    // so the buffer never wedges on a dead token.
    const routes =
      integration.status === "connected"
        ? await listEnabledGoatSlackBrainSourceRoutes([window.integrationId], tx)
        : [];
    const candidateBrainRefs = routes
      .filter((route) => goatSlackSelectedConversationIds(route.config).has(window.channelId))
      .map((route) => route.brainRef);

    // Cross-member dedup: several members' integrations can watch the same
    // team channel for the same brain. Each message claims its provider-native
    // identity per brain; a brain whose claims all lose (every message already
    // ingested via another member's window) is skipped — no job, no billing.
    const eventKeys = claimed.map((row) => `${window.teamId}:${window.channelId}:${row.messageTs}`);
    const brainRefs: string[] = [];
    for (const brainRef of new Set(candidateBrainRefs)) {
      const { claimedCount } = await claimGoatBrainSourceEvents({
        brainRef,
        sourceProvider: "slack",
        eventKeys,
        db: tx,
      });
      if (claimedCount > 0) brainRefs.push(brainRef);
    }

    const upserted = await upsertGoatBrainSourceItemAndEnqueue({
      userWorkosId: window.userWorkosId,
      sourceConnectionId: window.integrationId,
      integrationId: window.integrationId,
      item,
      rawPayload: { eventIds: claimed.map((row) => row.id) },
      rawEventCount: claimed.length,
      kind: GOAT_BRAIN_AGENT_INGEST_JOB_KIND,
      brainRefs,
      now: flushedAt,
      db: tx,
    });

    await tx.execute(sql`
      UPDATE goat.slack_message_events
      SET source_item_id = ${upserted.sourceItemId}
      WHERE id IN (${sql.join(
        claimed.map((row) => sql`${row.id}`),
        sql`, `,
      )})
    `);
    for (const brainRef of brainRefs) {
      await attributeGoatBrainSourceEventClaims({
        brainRef,
        sourceProvider: "slack",
        eventKeys,
        sourceItemId: upserted.sourceItemId,
        db: tx,
      });
    }

    return {
      sourceItemId: upserted.sourceItemId,
      messageCount: claimed.length,
      enqueued: upserted.enqueued,
      ...(upserted.quotaUpdates ? { quotaUpdates: upserted.quotaUpdates } : {}),
    };
  });

  captureGoatIngestionQuotaAnalytics(result?.quotaUpdates);
  if (result?.enqueued) wakeGoatBrainIngestWorker();
  return result;
}

async function previewBufferedSlackMessages(window: GoatSlackDueWindow) {
  return rowsFromExecute<BufferedSlackMessageRow>(
    await getDb().execute(sql`
      SELECT
        id,
        message_ts AS "messageTs",
        thread_ts AS "threadTs",
        slack_user_id AS "slackUserId",
        subtype,
        text,
        payload
      FROM goat.slack_message_events
      WHERE integration_id = ${window.integrationId}
        AND channel_id = ${window.channelId}
        AND source_item_id IS NULL
      ORDER BY message_ts ASC
      LIMIT ${GOAT_SLACK_MAX_WINDOW_MESSAGES}
    `),
  );
}

export function startGoatSlackFlushWorker(options: { pollIntervalMs?: number } = {}) {
  const pollIntervalMs = Math.max(
    1_000,
    options.pollIntervalMs ?? GOAT_SLACK_FLUSH_POLL_INTERVAL_MS,
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
        const due = await listDueGoatSlackConversationWindows({});
        for (const window of due) {
          if (stopped) break;
          const flushed = await flushGoatSlackConversationWindow(window).catch((error) => {
            captureException(error, {
              event: "opencompany.goat_slack_flush_failed",
              integration_id: window.integrationId,
              channel_id: window.channelId,
            });
            logger.error("Goat Slack window flush failed", {
              event: "opencompany.goat_slack_flush_failed",
              integration_id: window.integrationId,
              channel_id: window.channelId,
              error,
            });
            return null;
          });
          if (flushed) {
            logger.info("Goat Slack window flushed", {
              event: "opencompany.goat_slack_window_flushed",
              integration_id: window.integrationId,
              channel_id: window.channelId,
              source_item_id: flushed.sourceItemId,
              message_count: flushed.messageCount,
              enqueued: flushed.enqueued,
            });
          }
        }
      } catch (error) {
        captureException(error, { event: "opencompany.goat_slack_flush_worker_failed" });
        logger.error("Goat Slack flush worker failed", {
          event: "opencompany.goat_slack_flush_worker_failed",
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

async function loadSlackIntegrationContext(window: GoatSlackDueWindow): Promise<{
  status: GoatIntegrationStatus | "unknown";
  accessToken: string | null;
  teamDomain: string | null;
}> {
  const statusRows = rowsFromExecute<{ status: GoatIntegrationStatus }>(
    await getDb().execute(sql`
      SELECT status FROM goat.integrations WHERE id = ${window.integrationId}
    `),
  );
  const status = statusRows[0]?.status ?? "unknown";

  const credential =
    status === "connected"
      ? await loadGoatIntegrationCredential({
          userWorkosId: window.userWorkosId,
          integrationId: window.integrationId,
          provider: "slack",
          kind: "oauth_token",
        }).catch((error) => {
          logger.warn("Goat Slack credential load failed", {
            event: "opencompany.goat_slack_credential_load_failed",
            integration_id: window.integrationId,
            error,
          });
          return null;
        })
      : null;

  const accessToken = credential?.payload.access_token;
  const teamDomain = credential?.payload.team_domain;
  return {
    status,
    accessToken: typeof accessToken === "string" && accessToken ? accessToken : null,
    teamDomain: typeof teamDomain === "string" && teamDomain ? teamDomain : null,
  };
}

async function enrichSlackWindow(
  window: GoatSlackDueWindow,
  messages: readonly BufferedSlackMessageRow[],
  accessToken: string,
) {
  const [channelName, userNames] = await Promise.all([
    getSlackConversationLabel({
      token: accessToken,
      teamId: window.teamId,
      channelId: window.channelId,
      channelType: window.channelType,
    }),
    resolveSlackUserNames({
      token: accessToken,
      teamId: window.teamId,
      userIds: messages.flatMap((row) => (row.slackUserId ? [row.slackUserId] : [])),
    }),
  ]);
  return { channelName, userNames };
}

function toNormalizedMessage(
  row: BufferedSlackMessageRow,
  userNames: Map<string, string>,
): NormalizedSlackConversationMessage {
  const files = Array.isArray(row.payload.files)
    ? row.payload.files.flatMap((file) => {
        if (!file || typeof file !== "object") return [];
        const record = file as Record<string, unknown>;
        if (typeof record.name !== "string" || !record.name) return [];
        return [
          {
            name: record.name,
            ...(typeof record.mimetype === "string" ? { mimetype: record.mimetype } : {}),
          },
        ];
      })
    : [];
  const userId = row.slackUserId ?? "unknown";
  const userName = userNames.get(userId);
  return {
    ts: row.messageTs,
    ...(row.threadTs ? { threadTs: row.threadTs } : {}),
    userId,
    ...(userName ? { userName } : {}),
    text: row.text,
    ...(row.subtype ? { subtype: row.subtype } : {}),
    ...(files.length > 0 ? { files } : {}),
  };
}
