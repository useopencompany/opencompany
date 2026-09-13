import { JAMIE_WEBHOOK_API_KEY_HEADER } from "@opencompany/agent/integrations/jamie-constants";
import { loadJamieWebhookSecret } from "@opencompany/agent/integrations/jamie-events";
import { verifyJamieWebhookKey } from "@opencompany/agent/integrations/jamie-webhook-auth";
import {
  findJamieEventConnection,
  JAMIE_GUESTS_FILTER_ID,
  JAMIE_MEETING_COMPLETED_EVENT,
  JAMIE_PROVIDER,
  jamieMeetingGuestScope,
  jamieWorkflowEventContext,
  jamieWorkflowEventDeliveryId,
  markJamieEventsDelivered,
} from "@opencompany/db/jamie";
import {
  enqueueWorkflowEventRuns,
  listWorkflowEventTriggerRoutes,
  type WorkflowEventIntegration,
  workflowEventFiltersMatch,
} from "@opencompany/db/workflow-event-routes";
import { createLogger } from "@opencompany/observability";

const logger = createLogger({ service: "opencompany-api", runtime: "jamie-ingress" });

type DbLike = any;

// Provider ingress for Jamie's meeting webhook. Jamie has no webhook-management API, so there is no
// OAuth surface here: the user creates the endpoint in Jamie's settings against this connection's
// own URL and saves the key Jamie mints through the plugin's Events section.
export type JamieIngressService = {
  webhook(endpointId: string, request: Request): Promise<Response>;
};

export function createJamieIngress(input: { db: DbLike }): JamieIngressService {
  return { webhook: (endpointId, request) => handleWebhook(input.db, endpointId, request) };
}

type JamieWebhookEnvelope = {
  metadata?: { id?: unknown; event?: unknown; created?: unknown };
  data?: Record<string, unknown>;
};

// An unknown endpoint and a wrong key are reported identically, so an unauthenticated caller
// cannot use the response to discover which connections exist.
const UNAUTHORIZED = { error: "Invalid Jamie webhook credentials." };

async function handleWebhook(db: DbLike, endpointId: string, request: Request): Promise<Response> {
  const presented = request.headers.get(JAMIE_WEBHOOK_API_KEY_HEADER)?.trim();
  if (!presented) return Response.json(UNAUTHORIZED, { status: 401 });

  // A verified delivery is only acknowledged after its durable writes finish. Jamie retries a
  // non-2xx response five times over roughly an hour and the enqueue is idempotent, so a transient
  // database failure must not silently drop a workflow run.
  try {
    // One indexed read on the connection's own id rejects a probe before any credential is
    // decrypted.
    const connection = await findJamieEventConnection(endpointId, db);
    if (!connection) return Response.json(UNAUTHORIZED, { status: 401 });

    const expected = await loadJamieWebhookSecret({
      userWorkosId: connection.userWorkosId,
      integrationId: connection.id,
      db,
    }).catch(() => null);
    if (!verifyJamieWebhookKey({ presented, expected })) {
      return Response.json(UNAUTHORIZED, { status: 401 });
    }

    let envelope: JamieWebhookEnvelope;
    try {
      envelope = (await request.json()) as JamieWebhookEnvelope;
    } catch {
      return Response.json({ error: "Invalid JSON payload." }, { status: 400 });
    }
    return Response.json(await handleJamieEvent(db, envelope, connection));
  } catch (error) {
    logger.error("Failed to process Jamie event", {
      event: "goat.jamie_event_failed",
      integration_id: endpointId,
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
  connection: WorkflowEventIntegration,
) {
  const now = new Date();
  // The key verified, so the connection works even when the payload is one opencompany does not
  // route: recording the delivery is what lets the Events section confirm the setup.
  await markJamieEventsDelivered({ integrationId: connection.id, now }, db);

  const meeting = envelope.data;
  if (envelope.metadata?.event !== JAMIE_MEETING_COMPLETED_EVENT || !meeting) {
    return { ok: true, ignored: true };
  }

  const routes = (
    await listWorkflowEventTriggerRoutes(
      { provider: JAMIE_PROVIDER, integrations: [connection] },
      db,
    )
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
