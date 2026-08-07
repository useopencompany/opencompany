import { captureGoatIngestionQuotaAnalytics } from "@opencompany/analytics/goat";
import { type NormalizedGmailThreadMessage, normalizeGmailThreadWindow } from "@opencompany/brain";
import {
  attributeGoatBrainSourceEventClaims,
  claimGoatBrainSourceEvents,
} from "@opencompany/db/brain-event-claims";
import {
  GOAT_BRAIN_AGENT_INGEST_JOB_KIND,
  upsertGoatBrainSourceItemAndEnqueue,
} from "@opencompany/db/brain-ingest";
import {
  goatGmailEventClaimKey,
  goatGmailEventTypeForDirection,
  goatGmailRouteMatchesEvent,
  listEnabledGoatGmailBrainSourceRoutes,
  newGoatGmailThreadWindowId,
} from "@opencompany/db/gmail";
import type { GoatGmailMessageDirection, GoatIntegrationStatus } from "@opencompany/db/schema";
import { captureException, createLogger } from "@opencompany/observability";
import { sql } from "drizzle-orm";
import { wakeGoatBrainIngestWorker } from "./brain-ingest-worker";
import { getDb } from "./db";
import type { RunnerEnv } from "./env";
import { fetchGmailThreadSnapshot, type GmailThreadSnapshot } from "./gmail-api";
import { googleApiCall } from "./google-api-auth";
import { rowsFromExecute } from "./sql-exec";

const logger = createLogger({ service: "opencompany-runner", runtime: "goat-gmail-flush" });

// A window flushes after the thread has been quiet for the quiet period, or
// once its oldest buffered message has waited out the max wait — whichever
// comes first. One agent ingest session then covers the whole window. Email
// threads move in slow bursts like Linear issues, so the windows match.
export const GOAT_GMAIL_QUIET_PERIOD_MS = 15 * 60_000;
export const GOAT_GMAIL_MAX_WAIT_MS = 2 * 60 * 60_000;
export const GOAT_GMAIL_MAX_WINDOW_EVENTS = 100;
const GOAT_GMAIL_FLUSH_POLL_INTERVAL_MS = 60_000;

export type GoatGmailDueWindow = {
  integrationId: string;
  userWorkosId: string;
  threadId: string;
};

type BufferedGmailMessageRow = {
  id: string;
  messageId: string;
  rfc822MessageId: string | null;
  direction: GoatGmailMessageDirection;
  subject: string | null;
  fromHeader: string | null;
  payload: Record<string, unknown>;
  eventTime: string | Date;
};

export async function listDueGoatGmailThreadWindows(input: {
  now?: Date;
  quietPeriodMs?: number;
  maxWaitMs?: number;
}): Promise<GoatGmailDueWindow[]> {
  const now = input.now ?? new Date();
  const quietCutoff = new Date(now.getTime() - (input.quietPeriodMs ?? GOAT_GMAIL_QUIET_PERIOD_MS));
  const maxWaitCutoff = new Date(now.getTime() - (input.maxWaitMs ?? GOAT_GMAIL_MAX_WAIT_MS));
  const result = await getDb().execute(sql`
    SELECT
      integration_id AS "integrationId",
      user_workos_id AS "userWorkosId",
      thread_id AS "threadId"
    FROM goat.gmail_message_events
    WHERE source_item_id IS NULL
    GROUP BY 1, 2, 3
    HAVING max(received_at) < ${quietCutoff} OR min(received_at) < ${maxWaitCutoff}
  `);
  return rowsFromExecute<GoatGmailDueWindow>(result);
}

export async function flushGoatGmailThreadWindow(
  window: GoatGmailDueWindow,
  env: RunnerEnv,
  signal: AbortSignal,
): Promise<{
  sourceItemId: string;
  eventCount: number;
  enqueued: boolean;
} | null> {
  const db = getDb();

  // Enrichment happens before the transaction so no network call ever holds
  // row locks. A message that slips in mid-flush stays pending and seeds the
  // next window anyway.
  const preview = await previewBufferedGmailMessages(window);
  if (preview.length === 0) return null;
  const integration = await loadGmailIntegrationContext(window);
  const snapshot =
    integration.status === "connected"
      ? await fetchGmailThreadSnapshot(
          (method, url) =>
            googleApiCall({
              env,
              userWorkosId: window.userWorkosId,
              account: {
                integrationId: window.integrationId,
                provider: "gmail",
                accountEmail: integration.accountEmail,
              },
              method,
              url,
              signal,
            }),
          window.threadId,
        ).catch((error) => {
          logger.warn("Goat Gmail thread snapshot fetch failed", {
            event: "opencompany.goat_gmail_snapshot_failed",
            integration_id: window.integrationId,
            thread_id: window.threadId,
            error,
          });
          return null;
        })
      : null;

  const flushedAt = new Date();
  const result = await db.transaction(async (tx) => {
    const claimed = rowsFromExecute<BufferedGmailMessageRow>(
      await tx.execute(sql`
        SELECT
          id,
          message_id AS "messageId",
          rfc822_message_id AS "rfc822MessageId",
          direction,
          subject,
          from_header AS "fromHeader",
          payload,
          event_time AS "eventTime"
        FROM goat.gmail_message_events
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

    const item = buildGmailThreadWindowItem({
      window,
      events: claimed,
      snapshot,
      accountEmail: integration.accountEmail,
      flushedAt,
    });

    // Routing is re-resolved at flush time: the user may have changed the
    // event selection or disabled the source since the messages were buffered.
    // A revoked integration still flushes (persisting the window) with no
    // jobs, so the buffer never wedges on a dead token.
    const routes =
      integration.status === "connected"
        ? await listEnabledGoatGmailBrainSourceRoutes([window.integrationId], tx)
        : [];
    const directions = new Set(claimed.map((row) => row.direction));
    const candidateBrainRefs = routes
      .filter((route) =>
        [...directions].some((direction) =>
          goatGmailRouteMatchesEvent(route.config, goatGmailEventTypeForDirection(direction)),
        ),
      )
      .map((route) => route.brainRef);

    // Cross-member dedup: two members on the same thread each buffer their
    // mailbox's copy of every email. The RFC822 Message-ID is the identity
    // shared across mailboxes; a brain whose claims all lose (thread already
    // ingested via another member's window) is skipped — no job, no billing.
    const eventKeys = claimed.map((row) =>
      goatGmailEventClaimKey({
        rfc822MessageId: row.rfc822MessageId,
        integrationId: window.integrationId,
        gmailMessageId: row.messageId,
      }),
    );
    const brainRefs: string[] = [];
    const claimedEventKeysByBrainRef = new Map<string, string[]>();
    const newlyClaimedEventKeys = new Set<string>();
    for (const brainRef of new Set(candidateBrainRefs)) {
      const { claimedEventKeys } = await claimGoatBrainSourceEvents({
        brainRef,
        sourceProvider: "gmail",
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
      UPDATE goat.gmail_message_events
      SET source_item_id = ${upserted.sourceItemId}
      WHERE id IN (${sql.join(
        claimed.map((row) => sql`${row.id}`),
        sql`, `,
      )})
    `);
    for (const brainRef of brainRefs) {
      await attributeGoatBrainSourceEventClaims({
        brainRef,
        sourceProvider: "gmail",
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

export function buildGmailThreadWindowItem(input: {
  window: GoatGmailDueWindow;
  events: readonly BufferedGmailMessageRow[];
  snapshot: GmailThreadSnapshot | null;
  accountEmail: string | null;
  flushedAt: Date;
}) {
  const { window, events, snapshot } = input;
  const directionByMessageId = new Map(events.map((row) => [row.messageId, row.direction]));

  // With a live snapshot the item carries the whole thread (bodies included),
  // matching the pointer-copy rule's "snapshot emails into evidence" and giving
  // the ingest agent the exchange's full context — earlier messages may predate
  // the connection or an earlier flush. Without one, buffered metadata (headers
  // + snippet) is all that survives.
  const snapshotMessages: NormalizedGmailThreadMessage[] = (snapshot?.messages ?? [])
    .filter((message) => !message.labelIds.includes("DRAFT"))
    .map((message) => ({
      messageId: message.id,
      direction:
        directionByMessageId.get(message.id) ??
        (message.labelIds.includes("SENT") ? ("sent" as const) : ("received" as const)),
      from: message.from ?? "(unknown sender)",
      ...(message.to ? { to: message.to } : {}),
      ...(message.cc ? { cc: message.cc } : {}),
      sentAt: (message.internalDate ?? input.flushedAt).toISOString(),
      bodyText: message.bodyText,
      ...(message.snippet ? { snippet: message.snippet } : {}),
    }));
  const bufferedMessages: NormalizedGmailThreadMessage[] = events.map((row) => ({
    messageId: row.messageId,
    direction: row.direction,
    from: row.fromHeader ?? "(unknown sender)",
    ...(asString(row.payload?.to) ? { to: asString(row.payload?.to) as string } : {}),
    ...(asString(row.payload?.cc) ? { cc: asString(row.payload?.cc) as string } : {}),
    sentAt: coerceDate(row.eventTime).toISOString(),
    bodyText: asString(row.payload?.snippet) ?? "",
    ...(asString(row.payload?.snippet)
      ? { snippet: asString(row.payload?.snippet) as string }
      : {}),
  }));
  const useSnapshot = snapshotMessages.length > 0;
  const messages = useSnapshot ? snapshotMessages : bufferedMessages;

  const subject =
    snapshot?.messages.find((message) => message.subject)?.subject ??
    [...events].reverse().find((row) => row.subject)?.subject ??
    undefined;

  return normalizeGmailThreadWindow({
    windowId: newGoatGmailThreadWindowId(),
    threadId: window.threadId,
    ...(subject ? { subject } : {}),
    messages,
    flushedAt: input.flushedAt.toISOString(),
    ...(input.accountEmail ? { accountEmail: input.accountEmail } : {}),
    ...(useSnapshot ? {} : { snapshotStale: true }),
  });
}

export function startGoatGmailFlushWorker(
  env: RunnerEnv,
  options: { pollIntervalMs?: number } = {},
) {
  const pollIntervalMs = Math.max(
    1_000,
    options.pollIntervalMs ?? GOAT_GMAIL_FLUSH_POLL_INTERVAL_MS,
  );
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
        const due = await listDueGoatGmailThreadWindows({});
        for (const window of due) {
          if (stopped) break;
          const flushed = await flushGoatGmailThreadWindow(window, env, abort.signal).catch(
            (error) => {
              captureException(error, {
                event: "opencompany.goat_gmail_flush_failed",
                integration_id: window.integrationId,
                thread_id: window.threadId,
              });
              logger.error("Goat Gmail window flush failed", {
                event: "opencompany.goat_gmail_flush_failed",
                integration_id: window.integrationId,
                thread_id: window.threadId,
                error,
              });
              return null;
            },
          );
          if (flushed) {
            logger.info("Goat Gmail window flushed", {
              event: "opencompany.goat_gmail_window_flushed",
              integration_id: window.integrationId,
              thread_id: window.threadId,
              source_item_id: flushed.sourceItemId,
              event_count: flushed.eventCount,
              enqueued: flushed.enqueued,
            });
          }
        }
      } catch (error) {
        captureException(error, { event: "opencompany.goat_gmail_flush_worker_failed" });
        logger.error("Goat Gmail flush worker failed", {
          event: "opencompany.goat_gmail_flush_worker_failed",
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

async function previewBufferedGmailMessages(window: GoatGmailDueWindow) {
  return rowsFromExecute<BufferedGmailMessageRow>(
    await getDb().execute(sql`
      SELECT
        id,
        message_id AS "messageId",
        rfc822_message_id AS "rfc822MessageId",
        direction,
        subject,
        from_header AS "fromHeader",
        payload,
        event_time AS "eventTime"
      FROM goat.gmail_message_events
      WHERE integration_id = ${window.integrationId}
        AND thread_id = ${window.threadId}
        AND source_item_id IS NULL
      ORDER BY event_time ASC, id ASC
      LIMIT ${GOAT_GMAIL_MAX_WINDOW_EVENTS}
    `),
  );
}

async function loadGmailIntegrationContext(window: GoatGmailDueWindow): Promise<{
  status: GoatIntegrationStatus | "unknown";
  accountEmail: string | null;
}> {
  const rows = rowsFromExecute<{ status: GoatIntegrationStatus; accountEmail: string | null }>(
    await getDb().execute(sql`
      SELECT status, account_email AS "accountEmail"
      FROM goat.integrations
      WHERE id = ${window.integrationId}
    `),
  );
  return {
    status: rows[0]?.status ?? "unknown",
    accountEmail: rows[0]?.accountEmail ?? null,
  };
}

// Raw db.execute skips Drizzle's column mapping, so timestamptz comes back as
// a string; coerce before formatting.
function coerceDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
