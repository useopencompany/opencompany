import {
  claimGmailSyncState,
  ensureGmailSyncState,
  GMAIL_EMAIL_RECEIVED_EVENT,
  GMAIL_LABEL_FILTER_ID,
  GMAIL_PROVIDER,
  type GmailMessageEventInsert,
  gmailWorkflowEventContext,
  gmailWorkflowEventDeliveryId,
  insertGmailMessageEvents,
  listEnabledGmailBrainSourceRoutes,
  updateGmailSyncCursor,
} from "@opencompany/db/gmail";
import {
  enqueueWorkflowEventRuns,
  listWorkflowEventTriggerRoutes,
  type WorkflowEventTriggerRoute,
  workflowEventFiltersMatch,
} from "@opencompany/db/workflow-event-routes";
import { captureException, createLogger } from "@opencompany/observability";
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import type { RunnerEnv } from "./env";
import {
  fetchGmailMessageBodyText,
  fetchGmailMessageMetadata,
  fetchGmailProfile,
  type GmailApiCaller,
  type GmailMessageMetadata,
  listGmailHistoryMessagesAdded,
} from "./gmail-api";
import { googleApiCall } from "./google-api-auth";
import { createPollingWorker } from "./polling-worker";
import { rowsFromExecute } from "./sql-exec";

const logger = createLogger({ service: "opencompany-runner", runtime: "goat-gmail-poll" });

// Gmail has no plain webhook (push needs a GCP Pub/Sub topic + watch renewal),
// so new mail is discovered by polling the history API per connected
// integration. The thread flush already batches with a quiet period, so a few
// minutes of poll latency is invisible end to end; a workflow started from an
// arriving email inherits the same delay.
export const GMAIL_POLL_INTERVAL_MS = 5 * 60_000;
// A claim stamps last_polled_at; other runner replicas skip integrations
// claimed within the cooldown. The buffer's unique (integration, message id)
// index and the event inbox's unique (workflow, provider, delivery) index
// absorb any residual double-poll race.
export const GMAIL_POLL_COOLDOWN_MS = 4 * 60_000;

// Deterministic noise floor only: everything else (promotions, notifications,
// transactional mail) buffers and is judged by the ingest agent under the
// brain owner's instructions.
const SKIPPED_LABEL_IDS = new Set(["DRAFT", "SPAM", "TRASH", "CHAT"]);

// How stale an arriving message may be and still start a workflow. A cursor that sat frozen — an
// ingestion source switched off, an event trigger added long after the account was connected —
// would otherwise replay a mailbox's backlog as agent tasks. Older mail still buffers for
// ingestion; it just never fires.
const GMAIL_EVENT_MAX_MESSAGE_AGE_MS = 24 * 60 * 60_000;

// How many messages in one pass may start workflow runs. Meetings are low volume and Granola
// needs no such cap; email is not, and a single pass can legitimately see hundreds of messages.
// Past the cap the remaining matches are dropped rather than queued, because the history cursor
// has to advance for ingestion — so the overrun is logged loudly instead of silently deferred.
const GMAIL_EVENT_MAX_MESSAGES_PER_POLL = 25;

// Enough of the message for a workflow to act without a tool call. The goal composer applies the
// run's own budget on top of this.
const GMAIL_EVENT_MAX_BODY_CHARS = 6_000;

type GmailPollCandidate = {
  integrationId: string;
  userWorkosId: string;
  accountEmail: string | null;
};

export async function listGmailPollCandidates(
  db: Pick<ReturnType<typeof getDb>, "execute"> = getDb(),
): Promise<GmailPollCandidate[]> {
  const result = await db.execute(sql`
    SELECT
      i.id AS "integrationId",
      i.user_workos_id AS "userWorkosId",
      i.account_email AS "accountEmail"
    FROM goat.integrations i
    WHERE i.provider = 'gmail'
      AND i.status = 'connected'
      AND (
        EXISTS (
          SELECT 1 FROM goat.brain_sources bs
          WHERE bs.integration_id = i.id
            AND bs.provider = 'gmail'
            AND bs.enabled = true
        )
        OR EXISTS (
          SELECT 1
          FROM goat.workflows w
          JOIN goat.plugins p
            ON p.workspace_id = w.workspace_id
            AND p.owner_user_id = i.user_workos_id
            AND p.name = 'gmail'
            AND p.status = 'enabled'
            AND p.archived_at IS NULL
            AND p.event_modes->'email.received' = 'true'::jsonb
            AND EXISTS (SELECT 1 FROM jsonb_array_elements(p.events) event
              WHERE event->>'id' = 'email.received')
          JOIN goat.workspace_members member
            ON member.workspace_id = w.workspace_id
            AND member.user_workos_id = i.user_workos_id
          WHERE w.status = 'active'
            AND w.archived_at IS NULL
            -- Event triggers bind to personal connections only.
            AND i.workspace_id IS NULL
            AND (
              (
                w.trigger = 'event'
                AND w.event_user_workos_id = i.user_workos_id
                AND w.event_config->>'provider' = 'gmail'
                AND w.event_config->>'event' = 'email.received'
                AND w.event_config->>'integrationId' = i.id
              )
              OR EXISTS (
                SELECT 1
                FROM jsonb_array_elements(w.automation_triggers) trigger(value)
                WHERE trigger.value->>'type' = 'event'
                  AND trigger.value->>'userWorkosId' = i.user_workos_id
                  AND trigger.value->>'provider' = 'gmail'
                  AND trigger.value->>'event' = 'email.received'
                  AND trigger.value->>'integrationId' = i.id
              )
            )
        )
      )
  `);
  return rowsFromExecute<GmailPollCandidate>(result);
}

export async function pollGmailIntegration(input: {
  candidate: GmailPollCandidate;
  env: RunnerEnv;
  signal: AbortSignal;
  cooldownMs?: number;
  now?: Date;
}): Promise<{ buffered: number; workflowRuns: number } | null> {
  const { candidate } = input;
  const db = getDb();
  await ensureGmailSyncState(
    {
      integrationId: candidate.integrationId,
      userWorkosId: candidate.userWorkosId,
    },
    db,
  );
  const state = await claimGmailSyncState(
    {
      integrationId: candidate.integrationId,
      cooldownMs: input.cooldownMs ?? GMAIL_POLL_COOLDOWN_MS,
    },
    db,
  );
  if (!state) return null;

  const call: GmailApiCaller = (method, url) =>
    googleApiCall({
      env: input.env,
      userWorkosId: candidate.userWorkosId,
      account: {
        integrationId: candidate.integrationId,
        provider: "gmail",
        accountEmail: candidate.accountEmail,
      },
      method,
      url,
      signal: input.signal,
    });

  // First poll after connect: anchor the cursor at "now" — no backfill.
  if (!state.historyId) {
    const profile = await fetchGmailProfile(call);
    if (!profile.historyId) throw new Error("Gmail profile returned no historyId.");
    await updateGmailSyncCursor(
      {
        integrationId: candidate.integrationId,
        historyId: profile.historyId,
        emailAddress: profile.emailAddress,
      },
      db,
    );
    return { buffered: 0, workflowRuns: 0 };
  }

  const history = await listGmailHistoryMessagesAdded(call, state.historyId);
  if (history.expired) {
    // Gmail retains history for roughly a week; a cursor older than that can
    // only restart from "now". The interim mail is a documented gap.
    const profile = await fetchGmailProfile(call);
    if (!profile.historyId) throw new Error("Gmail profile returned no historyId.");
    await updateGmailSyncCursor(
      {
        integrationId: candidate.integrationId,
        historyId: profile.historyId,
        emailAddress: profile.emailAddress,
        reset: true,
      },
      db,
    );
    logger.warn("opencompany Gmail history cursor expired; reset from profile", {
      event: "opencompany.goat_gmail_history_reset",
      integration_id: candidate.integrationId,
    });
    return { buffered: 0, workflowRuns: 0 };
  }

  // Both consumers are authorized per pass, not per message: an ingestion source can be switched
  // off and a workflow, its event opt-in, or the connection can all change between polls. An
  // event-only account has no brain source to buffer for, and a buffered row nothing will ever
  // flush is waste, so the two are resolved independently. Most passes see no new mail at all,
  // which is why neither read happens before the history listing has something to route.
  const [brainRoutes, workflowRoutes] =
    history.messages.length === 0
      ? [[], []]
      : await Promise.all([
          listEnabledGmailBrainSourceRoutes([candidate.integrationId], db),
          listGmailWorkflowEventRoutes(candidate, db),
        ]);

  const now = input.now ?? new Date();
  const inserts: GmailMessageEventInsert[] = [];
  let routedMessages = 0;
  let workflowRuns = 0;
  let cappedMessages = 0;
  for (const discovered of history.messages) {
    if (discovered.labelIds.some((label) => SKIPPED_LABEL_IDS.has(label))) continue;
    const metadata = await fetchGmailMessageMetadata(call, discovered.id);
    if (!metadata) continue;
    const labelIds = metadata.labelIds.length > 0 ? metadata.labelIds : discovered.labelIds;
    if (labelIds.some((label) => SKIPPED_LABEL_IDS.has(label))) continue;
    const direction = labelIds.includes("SENT") ? "sent" : "received";
    const threadId = metadata.threadId || discovered.threadId;
    const eventTime = metadata.internalDate ?? now;

    // `email.received` never fires on mail this mailbox sent, which is also what keeps a workflow
    // that replies by email from re-triggering itself.
    const routes =
      direction === "received"
        ? workflowRoutes.filter((route) =>
            workflowEventFiltersMatch(route, { [GMAIL_LABEL_FILTER_ID]: labelIds }),
          )
        : [];
    if (
      routes.length > 0 &&
      now.getTime() - eventTime.getTime() <= GMAIL_EVENT_MAX_MESSAGE_AGE_MS
    ) {
      if (routedMessages >= GMAIL_EVENT_MAX_MESSAGES_PER_POLL) {
        cappedMessages += 1;
      } else {
        routedMessages += 1;
        workflowRuns += await enqueueGmailWorkflowEventRuns({
          routes,
          integrationId: candidate.integrationId,
          call,
          metadata,
          threadId,
          eventAt: eventTime,
          db,
        });
      }
    }

    if (brainRoutes.length === 0) continue;
    inserts.push({
      integrationId: candidate.integrationId,
      userWorkosId: candidate.userWorkosId,
      threadId,
      messageId: metadata.id,
      rfc822MessageId: metadata.rfc822MessageId,
      direction,
      subject: metadata.subject,
      fromHeader: metadata.from,
      payload: {
        labelIds,
        ...(metadata.to ? { to: metadata.to } : {}),
        ...(metadata.cc ? { cc: metadata.cc } : {}),
        ...(metadata.snippet ? { snippet: metadata.snippet } : {}),
      },
      eventTime,
    });
  }

  if (cappedMessages > 0) {
    logger.warn("opencompany Gmail event routing hit the per-pass cap; matches were dropped", {
      event: "opencompany.goat_gmail_event_cap_reached",
      integration_id: candidate.integrationId,
      routed_count: routedMessages,
      dropped_count: cappedMessages,
    });
  }

  const buffered = await insertGmailMessageEvents(inserts, db);
  if (history.latestHistoryId) {
    await updateGmailSyncCursor(
      {
        integrationId: candidate.integrationId,
        historyId: history.latestHistoryId,
      },
      db,
    );
  }
  return { buffered, workflowRuns };
}

async function listGmailWorkflowEventRoutes(
  candidate: GmailPollCandidate,
  db: ReturnType<typeof getDb>,
): Promise<WorkflowEventTriggerRoute[]> {
  const routes = await listWorkflowEventTriggerRoutes(
    {
      provider: GMAIL_PROVIDER,
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
  return routes.filter((route) => route.event === GMAIL_EMAIL_RECEIVED_EVENT);
}

// The body is read only once a route has matched, so an unfiltered mailbox does not pay a full
// message read per arriving message. A body that cannot be read still starts the workflow: the
// composer falls back to the snippet the metadata already carries.
async function enqueueGmailWorkflowEventRuns(input: {
  routes: readonly WorkflowEventTriggerRoute[];
  integrationId: string;
  call: GmailApiCaller;
  metadata: GmailMessageMetadata;
  threadId: string;
  eventAt: Date;
  db: ReturnType<typeof getDb>;
}): Promise<number> {
  const bodyText = await fetchGmailMessageBodyText(input.call, input.metadata.id, {
    maxBodyChars: GMAIL_EVENT_MAX_BODY_CHARS,
  });
  return enqueueWorkflowEventRuns(
    {
      routes: input.routes,
      deliveryId: gmailWorkflowEventDeliveryId({
        integrationId: input.integrationId,
        messageId: input.metadata.id,
      }),
      eventAt: input.eventAt,
      context: gmailWorkflowEventContext({
        messageId: input.metadata.id,
        threadId: input.threadId,
        subject: input.metadata.subject,
        from: input.metadata.from,
        to: input.metadata.to,
        cc: input.metadata.cc,
        receivedAt: input.metadata.internalDate,
        bodyText,
        snippet: input.metadata.snippet,
      }),
    },
    input.db,
  );
}

export function startGmailPollWorker(env: RunnerEnv, options: { pollIntervalMs?: number } = {}) {
  const pollIntervalMs = Math.max(1_000, options.pollIntervalMs ?? GMAIL_POLL_INTERVAL_MS);
  const enabled = Boolean(env.googleOAuthClientId && env.googleOAuthClientSecret);
  if (!enabled) {
    logger.info("opencompany Gmail poll worker disabled (Google OAuth not configured)", {
      event: "opencompany.goat_gmail_poll_disabled",
    });
  }
  return createPollingWorker({
    pollIntervalMs,
    poll: async ({ signal, stopping }) => {
      if (!enabled) return;
      signal.throwIfAborted();
      const candidates = await listGmailPollCandidates();
      for (const candidate of candidates) {
        if (stopping()) break;
        const polled = await pollGmailIntegration({ candidate, env, signal }).catch((error) => {
          if (signal.aborted) throw error;
          captureException(error, {
            event: "opencompany.goat_gmail_poll_failed",
            integration_id: candidate.integrationId,
          });
          logger.error("opencompany Gmail integration poll failed", {
            event: "opencompany.goat_gmail_poll_failed",
            integration_id: candidate.integrationId,
            error,
          });
          return null;
        });
        if (polled && (polled.buffered > 0 || polled.workflowRuns > 0)) {
          logger.info("opencompany Gmail poll buffered messages or started workflow runs", {
            event: "opencompany.goat_gmail_messages_buffered",
            integration_id: candidate.integrationId,
            buffered_count: polled.buffered,
            workflow_run_count: polled.workflowRuns,
          });
        }
      }
    },
    onError: (error) => {
      captureException(error, { event: "opencompany.goat_gmail_poll_worker_failed" });
      logger.error("opencompany Gmail poll worker failed", {
        event: "opencompany.goat_gmail_poll_worker_failed",
        error,
      });
    },
  });
}
