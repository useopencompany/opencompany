import {
  isPostHogRegion,
  isValidPostHogApiKey,
  isValidPostHogProjectId,
  type PostHogEventsCredentialPayload,
} from "@opencompany/agent/integrations/posthog-events";
import { loadIntegrationCredential, markIntegrationStatus } from "@opencompany/db/integrations";
import {
  advancePostHogEventCursor,
  claimPostHogEventSyncState,
  ensurePostHogEventSyncState,
  POSTHOG_EVENT_CAPTURED,
  POSTHOG_EVENT_NAME_FILTER_ID,
  POSTHOG_EVENTS_CREDENTIAL_KIND,
  POSTHOG_EVENTS_EXTERNAL_ID,
  POSTHOG_PROVIDER,
  posthogWorkflowEventContext,
  posthogWorkflowEventDeliveryId,
} from "@opencompany/db/posthog-events";
import {
  enqueueWorkflowEventRuns,
  listWorkflowEventTriggerRoutes,
  workflowEventFiltersMatch,
} from "@opencompany/db/workflow-event-routes";
import { captureException, createLogger } from "@opencompany/observability";
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import { createPollingWorker } from "./polling-worker";
import { PostHogAuthError, queryPostHogEvents } from "./posthog-api";
import { rowsFromExecute } from "./sql-exec";

const logger = createLogger({ service: "opencompany-runner", runtime: "posthog-event-poll" });

export const POSTHOG_POLL_INTERVAL_MS = 60_000;
export const POSTHOG_POLL_COOLDOWN_MS = 50_000;
export const POSTHOG_INGESTION_SAFETY_LAG_MS = 60_000;
const POSTHOG_EVENT_PAGE_SIZE = 500;
const POSTHOG_MAX_PAGES_PER_POLL = 5;

type PostHogPollCandidate = { integrationId: string; userWorkosId: string };

export async function listPostHogPollCandidates(
  db: Pick<ReturnType<typeof getDb>, "execute"> = getDb(),
): Promise<PostHogPollCandidate[]> {
  const result = await db.execute(sql`
    SELECT i.id AS "integrationId", i.user_workos_id AS "userWorkosId"
    FROM goat.integrations i
    WHERE i.provider = ${POSTHOG_PROVIDER}
      AND i.external_id = ${POSTHOG_EVENTS_EXTERNAL_ID}
      AND i.status = 'connected'
      AND i.workspace_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM goat.workflows w
        JOIN goat.plugins p
          ON p.workspace_id = w.workspace_id
          AND p.owner_user_id = i.user_workos_id
          AND p.name = ${POSTHOG_PROVIDER}
          AND p.status = 'enabled'
          AND p.archived_at IS NULL
          AND p.event_modes->${POSTHOG_EVENT_CAPTURED} = 'true'::jsonb
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(p.events) event
            WHERE event->>'id' = ${POSTHOG_EVENT_CAPTURED}
          )
        JOIN goat.workspace_members member
          ON member.workspace_id = w.workspace_id
          AND member.user_workos_id = i.user_workos_id
        WHERE w.status = 'active'
          AND w.archived_at IS NULL
          AND (
            (
              w.trigger = 'event'
              AND w.event_user_workos_id = i.user_workos_id
              AND w.event_config->>'provider' = ${POSTHOG_PROVIDER}
              AND w.event_config->>'event' = ${POSTHOG_EVENT_CAPTURED}
              AND w.event_config->>'integrationId' = i.id
            )
            OR EXISTS (
              SELECT 1 FROM jsonb_array_elements(w.automation_triggers) trigger(value)
              WHERE trigger.value->>'type' = 'event'
                AND trigger.value->>'userWorkosId' = i.user_workos_id
                AND trigger.value->>'provider' = ${POSTHOG_PROVIDER}
                AND trigger.value->>'event' = ${POSTHOG_EVENT_CAPTURED}
                AND trigger.value->>'integrationId' = i.id
            )
          )
      )
  `);
  return rowsFromExecute<PostHogPollCandidate>(result);
}

export async function pollPostHogIntegration(input: {
  candidate: PostHogPollCandidate;
  signal: AbortSignal;
  now?: Date;
  cooldownMs?: number;
}) {
  const db = getDb();
  const now = input.now ?? new Date();
  await ensurePostHogEventSyncState({ ...input.candidate, now }, db);
  const state = await claimPostHogEventSyncState(
    {
      integrationId: input.candidate.integrationId,
      cooldownMs: input.cooldownMs ?? POSTHOG_POLL_COOLDOWN_MS,
    },
    db,
  );
  if (!state) return null;

  const routes = (
    await listWorkflowEventTriggerRoutes(
      {
        provider: POSTHOG_PROVIDER,
        integrations: [
          {
            id: input.candidate.integrationId,
            workspaceId: null,
            userWorkosId: input.candidate.userWorkosId,
            status: "connected",
          },
        ],
      },
      db,
    )
  ).filter((route) => route.event === POSTHOG_EVENT_CAPTURED);
  const eventNames = [
    ...new Set(
      routes.flatMap((route) => {
        const value = route.filters[POSTHOG_EVENT_NAME_FILTER_ID]?.id;
        return value ? [value] : [];
      }),
    ),
  ];
  if (eventNames.length === 0) return { seen: 0, workflowRuns: 0 };

  const credentialRecord = await loadIntegrationCredential({
    userWorkosId: input.candidate.userWorkosId,
    integrationId: input.candidate.integrationId,
    provider: POSTHOG_PROVIDER,
    kind: POSTHOG_EVENTS_CREDENTIAL_KIND,
  });
  const credential = credentialRecord?.payload as PostHogEventsCredentialPayload | undefined;
  if (
    !credential ||
    !isValidPostHogApiKey(credential.apiKey) ||
    !isValidPostHogProjectId(credential.projectId) ||
    !isPostHogRegion(credential.region)
  ) {
    await markPostHogNeedsReauth(input.candidate, "The saved PostHog key could not be loaded.");
    return null;
  }

  const upperBound = new Date(now.getTime() - POSTHOG_INGESTION_SAFETY_LAG_MS);
  if (upperBound <= new Date(state.ingestedAtCursor)) return { seen: 0, workflowRuns: 0 };
  let cursorAt = state.ingestedAtCursor;
  let cursorUuid = state.eventUuidCursor;
  let seen = 0;
  let workflowRuns = 0;
  try {
    for (let page = 0; page < POSTHOG_MAX_PAGES_PER_POLL; page += 1) {
      const events = await queryPostHogEvents({
        credential,
        eventNames,
        cursorAt,
        cursorUuid,
        upperBound: upperBound.toISOString(),
        limit: POSTHOG_EVENT_PAGE_SIZE,
        signal: input.signal,
      });
      for (const event of events) {
        const matchingRoutes = routes.filter((route) =>
          workflowEventFiltersMatch(route, { [POSTHOG_EVENT_NAME_FILTER_ID]: event.event }),
        );
        workflowRuns += await enqueueWorkflowEventRuns(
          {
            routes: matchingRoutes,
            deliveryId: posthogWorkflowEventDeliveryId(event.uuid),
            eventAt: new Date(event.createdAt),
            context: posthogWorkflowEventContext(event),
          },
          db,
        );
      }
      seen += events.length;
      const previousAt = cursorAt;
      const previousUuid = cursorUuid;
      const last = events.at(-1);
      cursorAt = last ? last.createdAt : upperBound.toISOString();
      cursorUuid = last ? last.uuid : "";
      const advanced = await advancePostHogEventCursor(
        {
          integrationId: input.candidate.integrationId,
          expectedIngestedAt: previousAt,
          expectedEventUuid: previousUuid,
          ingestedAt: cursorAt,
          eventUuid: cursorUuid,
        },
        db,
      );
      if (!advanced || events.length < POSTHOG_EVENT_PAGE_SIZE) break;
    }
  } catch (error) {
    if (error instanceof PostHogAuthError) {
      await markPostHogNeedsReauth(input.candidate, error.message);
      return null;
    }
    throw error;
  }
  return { seen, workflowRuns };
}

async function markPostHogNeedsReauth(candidate: PostHogPollCandidate, reason: string) {
  await markIntegrationStatus({
    userWorkosId: candidate.userWorkosId,
    integrationId: candidate.integrationId,
    provider: POSTHOG_PROVIDER,
    status: "needs_reauth",
    statusReason: reason,
    now: new Date(),
  });
}

export function startPostHogPollWorker(options: { pollIntervalMs?: number } = {}) {
  return createPollingWorker({
    pollIntervalMs: Math.max(1_000, options.pollIntervalMs ?? POSTHOG_POLL_INTERVAL_MS),
    poll: async ({ signal, stopping }) => {
      signal.throwIfAborted();
      for (const candidate of await listPostHogPollCandidates()) {
        if (stopping()) break;
        const result = await pollPostHogIntegration({ candidate, signal }).catch((error) => {
          if (signal.aborted) throw error;
          captureException(error, {
            event: "opencompany.posthog_event_poll_failed",
            integration_id: candidate.integrationId,
          });
          logger.error("PostHog event poll failed", {
            event: "opencompany.posthog_event_poll_failed",
            integration_id: candidate.integrationId,
            error,
          });
          return null;
        });
        if (result && result.workflowRuns > 0) {
          logger.info("PostHog events started workflows", {
            event: "opencompany.posthog_events_started_workflows",
            integration_id: candidate.integrationId,
            seen_count: result.seen,
            workflow_run_count: result.workflowRuns,
          });
        }
      }
    },
    onError: (error) => {
      captureException(error, { event: "opencompany.posthog_event_poll_worker_failed" });
      logger.error("PostHog event poll worker failed", {
        event: "opencompany.posthog_event_poll_worker_failed",
        error,
      });
    },
  });
}
