import {
  claimGoatGmailSyncState,
  ensureGoatGmailSyncState,
  type GoatGmailMessageEventInsert,
  insertGoatGmailMessageEvents,
  updateGoatGmailSyncCursor,
} from "@opencompany/db/goat-gmail";
import { captureException, createLogger } from "@opencompany/observability";
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import type { RunnerEnv } from "./env";
import {
  fetchGmailMessageMetadata,
  fetchGmailProfile,
  type GmailApiCaller,
  listGmailHistoryMessagesAdded,
} from "./gmail-api";
import { googleApiCall } from "./google-api-auth";
import { rowsFromExecute } from "./sql-exec";

const logger = createLogger({ service: "opencompany-runner", runtime: "goat-gmail-poll" });

// Gmail has no plain webhook (push needs a GCP Pub/Sub topic + watch renewal),
// so new mail is discovered by polling the history API per connected
// integration. The thread flush already batches with a quiet period, so a few
// minutes of poll latency is invisible end to end.
export const GOAT_GMAIL_POLL_INTERVAL_MS = 3 * 60_000;
// A claim stamps last_polled_at; other runner replicas skip integrations
// claimed within the cooldown. The buffer's unique (integration, message id)
// index absorbs any residual double-poll race.
export const GOAT_GMAIL_POLL_COOLDOWN_MS = 2 * 60_000;

// Deterministic noise floor only: everything else (promotions, notifications,
// transactional mail) buffers and is judged by the ingest agent under the
// brain owner's instructions.
const SKIPPED_LABEL_IDS = new Set(["DRAFT", "SPAM", "TRASH", "CHAT"]);

type GmailPollCandidate = {
  integrationId: string;
  userWorkosId: string;
  accountEmail: string | null;
};

export async function listGoatGmailPollCandidates(): Promise<GmailPollCandidate[]> {
  const result = await getDb().execute(sql`
    SELECT
      i.id AS "integrationId",
      i.user_workos_id AS "userWorkosId",
      i.account_email AS "accountEmail"
    FROM goat.integrations i
    WHERE i.provider = 'gmail'
      AND i.status = 'connected'
      AND EXISTS (
        SELECT 1 FROM goat.brain_sources bs
        WHERE bs.integration_id = i.id
          AND bs.provider = 'gmail'
          AND bs.enabled = true
      )
  `);
  return rowsFromExecute<GmailPollCandidate>(result);
}

export async function pollGoatGmailIntegration(input: {
  candidate: GmailPollCandidate;
  env: RunnerEnv;
  signal: AbortSignal;
  cooldownMs?: number;
}): Promise<{ buffered: number } | null> {
  const { candidate } = input;
  const db = getDb();
  await ensureGoatGmailSyncState(
    {
      integrationId: candidate.integrationId,
      userWorkosId: candidate.userWorkosId,
    },
    db,
  );
  const state = await claimGoatGmailSyncState(
    {
      integrationId: candidate.integrationId,
      cooldownMs: input.cooldownMs ?? GOAT_GMAIL_POLL_COOLDOWN_MS,
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
    await updateGoatGmailSyncCursor(
      {
        integrationId: candidate.integrationId,
        historyId: profile.historyId,
        emailAddress: profile.emailAddress,
      },
      db,
    );
    return { buffered: 0 };
  }

  const history = await listGmailHistoryMessagesAdded(call, state.historyId);
  if (history.expired) {
    // Gmail retains history for roughly a week; a cursor older than that can
    // only restart from "now". The interim mail is a documented gap.
    const profile = await fetchGmailProfile(call);
    if (!profile.historyId) throw new Error("Gmail profile returned no historyId.");
    await updateGoatGmailSyncCursor(
      {
        integrationId: candidate.integrationId,
        historyId: profile.historyId,
        emailAddress: profile.emailAddress,
        reset: true,
      },
      db,
    );
    logger.warn("Goat Gmail history cursor expired; reset from profile", {
      event: "opencompany.goat_gmail_history_reset",
      integration_id: candidate.integrationId,
    });
    return { buffered: 0 };
  }

  const inserts: GoatGmailMessageEventInsert[] = [];
  for (const discovered of history.messages) {
    if (discovered.labelIds.some((label) => SKIPPED_LABEL_IDS.has(label))) continue;
    const metadata = await fetchGmailMessageMetadata(call, discovered.id);
    if (!metadata) continue;
    const labelIds = metadata.labelIds.length > 0 ? metadata.labelIds : discovered.labelIds;
    if (labelIds.some((label) => SKIPPED_LABEL_IDS.has(label))) continue;
    inserts.push({
      integrationId: candidate.integrationId,
      userWorkosId: candidate.userWorkosId,
      threadId: metadata.threadId || discovered.threadId,
      messageId: metadata.id,
      direction: labelIds.includes("SENT") ? "sent" : "received",
      subject: metadata.subject,
      fromHeader: metadata.from,
      payload: {
        labelIds,
        ...(metadata.to ? { to: metadata.to } : {}),
        ...(metadata.cc ? { cc: metadata.cc } : {}),
        ...(metadata.snippet ? { snippet: metadata.snippet } : {}),
      },
      eventTime: metadata.internalDate ?? new Date(),
    });
  }

  const buffered = await insertGoatGmailMessageEvents(inserts, db);
  if (history.latestHistoryId) {
    await updateGoatGmailSyncCursor(
      {
        integrationId: candidate.integrationId,
        historyId: history.latestHistoryId,
      },
      db,
    );
  }
  return { buffered };
}

export function startGoatGmailPollWorker(
  env: RunnerEnv,
  options: { pollIntervalMs?: number } = {},
) {
  const pollIntervalMs = Math.max(1_000, options.pollIntervalMs ?? GOAT_GMAIL_POLL_INTERVAL_MS);
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
    if (!env.googleOAuthClientId || !env.googleOAuthClientSecret) {
      logger.info("Goat Gmail poll worker disabled (Google OAuth not configured)", {
        event: "opencompany.goat_gmail_poll_disabled",
      });
      return;
    }
    while (!stopped) {
      try {
        const candidates = await listGoatGmailPollCandidates();
        for (const candidate of candidates) {
          if (stopped) break;
          const polled = await pollGoatGmailIntegration({
            candidate,
            env,
            signal: abort.signal,
          }).catch((error) => {
            captureException(error, {
              event: "opencompany.goat_gmail_poll_failed",
              integration_id: candidate.integrationId,
            });
            logger.error("Goat Gmail integration poll failed", {
              event: "opencompany.goat_gmail_poll_failed",
              integration_id: candidate.integrationId,
              error,
            });
            return null;
          });
          if (polled && polled.buffered > 0) {
            logger.info("Goat Gmail messages buffered", {
              event: "opencompany.goat_gmail_messages_buffered",
              integration_id: candidate.integrationId,
              buffered_count: polled.buffered,
            });
          }
        }
      } catch (error) {
        captureException(error, { event: "opencompany.goat_gmail_poll_worker_failed" });
        logger.error("Goat Gmail poll worker failed", {
          event: "opencompany.goat_gmail_poll_worker_failed",
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
