import { loadConvexWebhookSecret } from "@opencompany/agent/integrations/convex-log-stream";
import {
  CONVEX_WEBHOOK_SIGNATURE_HEADER,
  verifyConvexWebhookSignature,
} from "@opencompany/agent/integrations/convex-webhook-auth";
import {
  CONVEX_EVENT_MAX_AGE_MS,
  CONVEX_FAILURE_GROUP_LIMIT,
  CONVEX_FUNCTION_FAILED_EVENT,
  CONVEX_FUNCTION_TYPE_FILTER_ID,
  CONVEX_PROVIDER,
  convexFunctionFailureGroups,
  convexFunctionFailures,
  convexFunctionTypeScope,
  convexWorkflowEventContext,
  findConvexEventConnection,
  markConvexEventsDelivered,
} from "@opencompany/db/convex-events";
import {
  enqueueWorkflowEventRuns,
  listWorkflowEventTriggerRoutes,
  type WorkflowEventIntegration,
  type WorkflowEventTriggerRoute,
  workflowEventFiltersMatch,
} from "@opencompany/db/workflow-event-routes";
import { createLogger } from "@opencompany/observability";

const logger = createLogger({ service: "opencompany-api", runtime: "convex-ingress" });

type DbLike = any;

// Provider ingress for Convex's webhook log stream. opencompany creates the stream itself through
// the Convex deployment API, so unlike Jamie there is nothing for the user to paste; what arrives
// here is a JSON array of log events signed with the HMAC secret Convex returned at creation.
export type ConvexIngressService = {
  webhook(endpointId: string, request: Request): Promise<Response>;
};

export function createConvexIngress(input: { db: DbLike }): ConvexIngressService {
  return { webhook: (endpointId, request) => handleWebhook(input.db, endpointId, request) };
}

// An unknown endpoint and a bad signature are reported identically, so an unauthenticated caller
// cannot use the response to discover which connections exist.
const UNAUTHORIZED = { error: "Invalid Convex log stream signature." };

async function handleWebhook(db: DbLike, endpointId: string, request: Request): Promise<Response> {
  const signature = request.headers.get(CONVEX_WEBHOOK_SIGNATURE_HEADER);
  if (!signature) return Response.json(UNAUTHORIZED, { status: 401 });

  try {
    // One indexed read on the connection's own id rejects a probe before any credential is
    // decrypted.
    const connection = await findConvexEventConnection(endpointId, db);
    if (!connection) return Response.json(UNAUTHORIZED, { status: 401 });

    const secret = await loadConvexWebhookSecret({
      userWorkosId: connection.userWorkosId,
      integrationId: connection.id,
      db,
    }).catch(() => null);

    // Convex signs the exact bytes it sent, so the signature has to be checked against the raw
    // body before it is parsed.
    const body = await request.text();
    if (!verifyConvexWebhookSignature({ body, signature, secret })) {
      return Response.json(UNAUTHORIZED, { status: 401 });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return Response.json({ error: "Invalid JSON payload." }, { status: 400 });
    }
    return Response.json(await handleConvexEvents(db, payload, connection));
  } catch (error) {
    logger.error("Failed to process Convex log stream delivery", {
      event: "goat.convex_event_failed",
      integration_id: endpointId,
      error_message: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { error: "Convex event processing failed; retry this delivery." },
      { status: 503 },
    );
  }
}

async function handleConvexEvents(
  db: DbLike,
  payload: unknown,
  connection: WorkflowEventIntegration,
) {
  const now = new Date();
  // The signature verified, so the stream works even when the delivery carries nothing
  // opencompany routes — the verification event Convex sends at creation, or a batch of successful
  // executions. Recording the delivery is what lets the settings UI confirm the stream is live.
  await markConvexEventsDelivered({ integrationId: connection.id, now }, db);

  // Convex delivers best-effort and can lag or duplicate. A batch describing failures from long
  // ago is not worth waking an agent for, and it is also what a replay of a captured signed body
  // would look like.
  const failures = convexFunctionFailures(payload).filter(
    (failure) => now.getTime() - failure.at.getTime() <= CONVEX_EVENT_MAX_AGE_MS,
  );
  if (failures.length === 0) return { ok: true, workflowRuns: 0 };

  const routes = (
    await listWorkflowEventTriggerRoutes(
      { provider: CONVEX_PROVIDER, integrations: [connection] },
      db,
    )
  ).filter((route) => route.event === CONVEX_FUNCTION_FAILED_EVENT);
  if (routes.length === 0) return { ok: true, workflowRuns: 0 };

  // Groups arrive loudest first, and each route takes at most CONVEX_FAILURE_GROUP_LIMIT of the
  // ones it matches. Capping per route rather than per delivery is what stops a trigger filtered to
  // one function type from losing its incident to noisier groups it was never going to match.
  let workflowRuns = 0;
  const enqueuedPerRoute = new Map<WorkflowEventTriggerRoute, number>();
  for (const group of convexFunctionFailureGroups(failures)) {
    const matched = routes.filter(
      (route) =>
        (enqueuedPerRoute.get(route) ?? 0) < CONVEX_FAILURE_GROUP_LIMIT &&
        workflowEventFiltersMatch(route, {
          [CONVEX_FUNCTION_TYPE_FILTER_ID]: convexFunctionTypeScope(group.failure),
        }),
    );
    if (matched.length === 0) continue;
    workflowRuns += await enqueueWorkflowEventRuns(
      {
        routes: matched,
        deliveryId: group.deliveryId,
        eventAt: group.eventAt,
        context: convexWorkflowEventContext(group),
      },
      db,
    );
    for (const route of matched) {
      enqueuedPerRoute.set(route, (enqueuedPerRoute.get(route) ?? 0) + 1);
    }
  }
  return { ok: true, workflowRuns };
}
