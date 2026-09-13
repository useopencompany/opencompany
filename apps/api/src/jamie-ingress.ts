import { JAMIE_WEBHOOK_API_KEY_HEADER } from "@opencompany/agent/integrations/jamie-constants";
import {
  JAMIE_GUESTS_FILTER_ID,
  JAMIE_MEETING_COMPLETED_EVENT,
  JAMIE_PROVIDER,
  jamieMeetingGuestScope,
  jamieWorkflowEventContext,
  jamieWorkflowEventDeliveryId,
  listJamieEventIntegrationsForApiKey,
  markJamieEventsDelivered,
} from "@opencompany/db/jamie";
import {
  enqueueWorkflowEventRuns,
  listWorkflowEventTriggerRoutes,
  workflowEventFiltersMatch,
} from "@opencompany/db/workflow-event-routes";
import { createLogger } from "@opencompany/observability";

const logger = createLogger({ service: "opencompany-api", runtime: "jamie-ingress" });

type DbLike = any;

// Provider ingress for Jamie's meeting webhook. Jamie has no webhook-management API, so there is
// no connect surface here: the user creates the endpoint in Jamie's settings and saves the key
// Jamie mints through the plugin's Events section. The key presented on a delivery is what
// identifies the connection.
export type JamieIngressService = {
  webhook(request: Request): Promise<Response>;
};

export function createJamieIngress(input: { db: DbLike }): JamieIngressService {
  return { webhook: (request) => handleWebhook(input.db, request) };
}

type JamieWebhookEnvelope = {
  metadata?: { id?: unknown; event?: unknown; created?: unknown };
  data?: Record<string, unknown>;
};

async function handleWebhook(db: DbLike, request: Request): Promise<Response> {
  const apiKey = request.headers.get(JAMIE_WEBHOOK_API_KEY_HEADER)?.trim();
  if (!apiKey) {
    return Response.json({ error: "Missing Jamie webhook key." }, { status: 401 });
  }

  let envelope: JamieWebhookEnvelope;
  try {
    envelope = (await request.json()) as JamieWebhookEnvelope;
  } catch {
    return Response.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  // A verified delivery is only acknowledged after its durable writes finish. Jamie retries a
  // non-2xx response five times over roughly an hour and the enqueue is idempotent, so a transient
  // database failure must not silently drop a workflow run.
  try {
    // The key is a high-entropy secret Jamie mints; opencompany stores only its digest, so this
    // lookup is both the connection binding and the credential check.
    const integrations = await listJamieEventIntegrationsForApiKey(apiKey, db);
    if (integrations.length === 0) {
      return Response.json({ error: "Unknown Jamie webhook key." }, { status: 401 });
    }
    return Response.json(await handleJamieEvent(db, envelope, integrations));
  } catch (error) {
    logger.error("Failed to process Jamie event", {
      event: "goat.jamie_event_failed",
      event_type: typeof envelope.metadata?.event === "string" ? envelope.metadata.event : null,
      error_message: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { error: "Jamie event processing failed; retry this delivery." },
      { status: 503 },
    );
  }
}

async function handleJamieEvent(
  db: DbLike,
  envelope: JamieWebhookEnvelope,
  integrations: Awaited<ReturnType<typeof listJamieEventIntegrationsForApiKey>>,
) {
  const now = new Date();
  // The key was verified, so the connection is real even when the payload is one opencompany does
  // not route: recording the delivery is what lets the Events section confirm the setup works.
  await markJamieEventsDelivered({ integrationIds: integrations.map((row) => row.id), now }, db);

  const meeting = envelope.data;
  if (envelope.metadata?.event !== JAMIE_MEETING_COMPLETED_EVENT || !meeting) {
    return { ok: true, ignored: true };
  }

  const routes = (
    await listWorkflowEventTriggerRoutes({ provider: JAMIE_PROVIDER, integrations }, db)
  ).filter(
    (route) =>
      route.event === JAMIE_MEETING_COMPLETED_EVENT &&
      workflowEventFiltersMatch(route, {
        [JAMIE_GUESTS_FILTER_ID]: jamieMeetingGuestScope(meeting),
      }),
  );
  if (routes.length === 0) return { ok: true, workflowRuns: 0 };

  const workflowRuns = await enqueueWorkflowEventRuns(
    {
      routes,
      deliveryId: jamieWorkflowEventDeliveryId(meeting),
      eventAt: jamieEventTime(envelope.metadata?.created, now),
      context: jamieWorkflowEventContext(meeting),
    },
    db,
  );
  return { ok: true, workflowRuns };
}

// Jamie stamps the delivery with the Unix second at which it finished processing the meeting,
// which is the moment the event describes and what an activation cutoff compares against.
function jamieEventTime(created: unknown, now: Date) {
  if (typeof created !== "number" || !Number.isFinite(created)) return now;
  const createdAt = new Date(created * 1000);
  return Number.isNaN(createdAt.getTime()) ? now : createdAt;
}
