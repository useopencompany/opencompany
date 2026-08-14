import { getAppUrl } from "@opencompany/agent/app-url";
import {
  appendHubspotIngestStatus,
  buildHubspotAuthorizationUrl,
  createHubspotIngestState,
  exchangeHubspotCode,
  fetchHubspotIdentity,
  isHubspotIngestConfigured,
  verifyHubspotIngestState,
} from "@opencompany/agent/integrations/hubspot-ingest";
import { verifyHubspotWebhookSignature } from "@opencompany/agent/integrations/hubspot-signature";
import {
  type HubspotObjectEventInsert,
  hubspotEventTypeFor,
  hubspotRouteMatchesEvent,
  hubspotSelectedObjectTypes,
  insertHubspotObjectEvents,
  listEnabledHubspotBrainSourceRoutes,
  listHubspotIntegrationsForPortal,
} from "@opencompany/db/hubspot";
import { connectHubspotIntegration } from "@opencompany/db/integrations";
import type { HubspotEventAction, HubspotObjectType } from "@opencompany/db/product-schema";
import { createLogger } from "@opencompany/observability";
import type { ApiIdentityVerifier } from "./auth";
import { type IngressSession, resolveIngressSession, sessionRedirect } from "./ingress-session";

const logger = createLogger({ service: "opencompany-api", runtime: "hubspot-ingress" });

type DbLike = any;

// Provider ingress composition for the HubSpot Brain-ingestion connection: the
// OAuth connect flow and the webhook that buffers CRM object events for the
// runner's flush worker.
export type HubspotIngressService = {
  start(request: Request): Promise<Response>;
  callback(request: Request): Promise<Response>;
  webhook(request: Request): Promise<Response>;
};

export function createHubspotIngress(input: {
  db: DbLike;
  identify: ApiIdentityVerifier;
}): HubspotIngressService {
  return {
    start: (request) => handleStart(input, request),
    callback: (request) => handleCallback(input, request),
    webhook: (request) => handleWebhook(input, request),
  };
}

type IngressInput = { db: DbLike; identify: ApiIdentityVerifier };

// Property changes that carry no durable knowledge on their own: system
// bookkeeping, analytics rollups, and activity counters HubSpot rewrites on
// nearly every touch. Events for these properties are dropped at the door.
const NOISE_PROPERTY_PREFIXES = [
  "hs_analytics_",
  "hs_email_",
  "hs_sales_email_",
  "hs_time_in_",
  "hs_latest_source",
  "hs_v2_",
  "hs_date_entered_",
  "hs_date_exited_",
];
const NOISE_PROPERTY_NAMES = new Set([
  "hs_lastmodifieddate",
  "lastmodifieddate",
  "hs_object_source_detail_1",
  "notes_last_updated",
  "notes_last_contacted",
  "notes_next_activity_date",
  "num_notes",
  "num_contacted_notes",
  "hs_last_sales_activity_timestamp",
  "hs_last_sales_activity_date",
  "hs_lead_status_source",
]);

type HubspotWebhookEvent = {
  eventId?: number | string;
  subscriptionId?: number;
  portalId?: number;
  occurredAt?: number;
  subscriptionType?: string;
  attemptNumber?: number;
  objectId?: number | string;
  changeSource?: string;
  propertyName?: string;
  propertyValue?: unknown;
  sourceId?: string;
};

async function handleStart(input: IngressInput, request: Request): Promise<Response> {
  const session = await resolveIngressSession(input, request);
  if (session.kind === "redirect") return session.response;
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo") ?? "/settings";

  if (!isHubspotIngestConfigured()) {
    return statusRedirect(session, returnTo, "error", "not_configured");
  }

  const state = createHubspotIngestState({
    userWorkosId: session.userId,
    returnTo,
  });
  return sessionRedirect(session, buildHubspotAuthorizationUrl(state));
}

async function handleCallback(input: IngressInput, request: Request): Promise<Response> {
  const session = await resolveIngressSession(input, request);
  if (session.kind === "redirect") return session.response;
  const url = new URL(request.url);
  const stateValue = url.searchParams.get("state") ?? "";

  let state: ReturnType<typeof verifyHubspotIngestState>;
  try {
    state = verifyHubspotIngestState(stateValue);
  } catch {
    return sessionRedirect(
      session,
      new URL("/settings?integration=hubspot&setup=error&reason=invalid_state", getAppUrl()),
    );
  }

  if (state.userWorkosId !== session.userId) {
    return statusRedirect(session, state.returnTo, "error", "session_mismatch");
  }
  if (!isHubspotIngestConfigured()) {
    return statusRedirect(session, state.returnTo, "error", "not_configured");
  }
  if (url.searchParams.get("error")) {
    return statusRedirect(session, state.returnTo, "error", "hubspot_denied");
  }
  const code = url.searchParams.get("code");
  if (!code) {
    return statusRedirect(session, state.returnTo, "error", "missing_code");
  }

  try {
    const oauth = await exchangeHubspotCode(code);
    const identity = await fetchHubspotIdentity(oauth.accessToken);

    await connectHubspotIntegration({
      userWorkosId: session.userId,
      portalId: identity.portalId,
      hubDomain: identity.hubDomain,
      userEmail: identity.userEmail,
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt: oauth.expiresAt,
      scopes: identity.scopes,
      db: input.db,
    });

    return statusRedirect(session, state.returnTo, "connected");
  } catch (error) {
    logger.warn("HubSpot connection failed", {
      event: "goat.hubspot_callback_failed",
      error_message: error instanceof Error ? error.message : String(error),
    });
    return statusRedirect(session, state.returnTo, "error", "connection_sync_failed");
  }
}

async function handleWebhook(input: IngressInput, request: Request): Promise<Response> {
  const rawBody = await request.text();

  // HubSpot v3 signatures cover the exact URI it delivered to. The registered
  // event URL stays on the web origin, whose relay forwards here, so the
  // observed request URL is the API origin and the canonical web URL is the
  // URI HubSpot actually signed. Keep both as candidates.
  const requestUrl = new URL(request.url);
  const canonicalUrl = new URL(
    `/api/webhooks/hubspot/events${requestUrl.search}`,
    getAppUrl(),
  ).toString();
  // The relay also records the host it actually received the delivery on;
  // reconstructing that candidate keeps verification working if the registered
  // webhook host ever diverges from the canonical app URL.
  const forwardedHost = request.headers.get("x-forwarded-host")?.trim();
  const forwardedProto = request.headers.get("x-forwarded-proto")?.trim() || "https";
  const forwardedUrl = forwardedHost
    ? `${forwardedProto}://${forwardedHost}/api/webhooks/hubspot/events${requestUrl.search}`
    : null;
  const candidateUris = [
    ...new Set([request.url, canonicalUrl, ...(forwardedUrl ? [forwardedUrl] : [])]),
  ];
  const verified = verifyHubspotWebhookSignature({
    method: "POST",
    candidateUris,
    rawBody,
    signature: request.headers.get("x-hubspot-signature-v3"),
    timestampHeader: request.headers.get("x-hubspot-request-timestamp"),
  });
  if (!verified) {
    return Response.json({ error: "Invalid HubSpot signature." }, { status: 401 });
  }

  let events: HubspotWebhookEvent[];
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    events = Array.isArray(parsed) ? (parsed as HubspotWebhookEvent[]) : [];
  } catch {
    return Response.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  // Delivery ids make retries idempotent. Surface transient routing or storage
  // failures so HubSpot redelivers instead of silently losing CRM activity.
  try {
    return Response.json(await handleHubspotEvents(input.db, events));
  } catch (error) {
    logger.error("Failed to process HubSpot events", {
      event: "goat.hubspot_events_failed",
      event_count: events.length,
      error_message: error instanceof Error ? error.message : String(error),
    });
    return Response.json({ error: "Unable to buffer HubSpot events." }, { status: 503 });
  }
}

async function handleHubspotEvents(db: DbLike, events: HubspotWebhookEvent[]) {
  const relevant = events.flatMap((event) => {
    const parsed = parseHubspotEvent(event);
    return parsed ? [parsed] : [];
  });
  if (relevant.length === 0) return { ok: true, ignored: true };

  // One delivery batch is always for a single app but may span portals in
  // principle; group by portal so routing stays exact.
  const byPortal = new Map<string, ReturnType<typeof parseHubspotEvent>[]>();
  for (const event of relevant) {
    const bucket = byPortal.get(event!.portalId) ?? [];
    bucket.push(event);
    byPortal.set(event!.portalId, bucket);
  }

  let buffered = 0;
  for (const [portalId, portalEvents] of byPortal) {
    const integrations = await listHubspotIntegrationsForPortal(portalId, db);
    const connected = integrations.filter((integration) => integration.status === "connected");
    if (connected.length === 0) continue;

    const routes = await listEnabledHubspotBrainSourceRoutes(
      connected.map((integration) => integration.id),
      db,
    );

    const inserts: HubspotObjectEventInsert[] = [];
    for (const event of portalEvents) {
      if (!event) continue;
      const eventType = hubspotEventTypeFor({
        action: event.action,
        propertyName: event.propertyName,
      });
      const matchedIntegrationIds = new Set(
        routes
          .filter((route) => {
            const selected = hubspotSelectedObjectTypes(route.config);
            if (selected.size === 0) return false;
            if (!selected.has(event.objectType)) return false;
            return hubspotRouteMatchesEvent(route.config, eventType);
          })
          .map((route) => route.integrationId),
      );
      if (matchedIntegrationIds.size === 0) continue;

      for (const integration of connected) {
        if (!matchedIntegrationIds.has(integration.id)) continue;
        inserts.push({
          integrationId: integration.id,
          userWorkosId: integration.userWorkosId,
          portalId,
          objectType: event.objectType,
          objectId: event.objectId,
          deliveryId: event.deliveryId,
          action: event.action,
          propertyName: event.propertyName,
          payload: event.payload,
          eventTime: event.eventTime,
        });
      }
    }

    buffered += await insertHubspotObjectEvents(inserts, db);
  }

  return { ok: true, buffered };
}

function parseHubspotEvent(event: HubspotWebhookEvent): {
  portalId: string;
  objectType: HubspotObjectType;
  objectId: string;
  deliveryId: string;
  action: HubspotEventAction;
  propertyName: string | null;
  payload: Record<string, unknown>;
  eventTime: Date;
} | null {
  const portalId =
    typeof event.portalId === "number" && Number.isFinite(event.portalId)
      ? String(event.portalId)
      : null;
  const objectId =
    typeof event.objectId === "number" || typeof event.objectId === "string"
      ? String(event.objectId).trim()
      : "";
  const subscription = parseSubscriptionType(event.subscriptionType);
  if (!portalId || !objectId || !subscription) return null;

  const propertyName =
    subscription.action === "update" && typeof event.propertyName === "string"
      ? event.propertyName.trim() || null
      : null;
  if (subscription.action === "update" && isNoiseProperty(propertyName)) return null;

  const eventId =
    typeof event.eventId === "number" || typeof event.eventId === "string"
      ? String(event.eventId).trim()
      : "";
  // eventId is stable across HubSpot's redelivery attempts; the subscription
  // type disambiguates the rare id collision across subscription streams.
  const deliveryId = eventId
    ? `${eventId}:${event.subscriptionType}`
    : `${portalId}:${event.subscriptionType}:${objectId}:${event.occurredAt ?? ""}:${propertyName ?? ""}`;

  const eventTime =
    typeof event.occurredAt === "number" && Number.isFinite(event.occurredAt)
      ? new Date(event.occurredAt)
      : new Date();

  return {
    portalId,
    objectType: subscription.objectType,
    objectId,
    deliveryId,
    action: subscription.action,
    propertyName,
    payload: {
      subscriptionType: event.subscriptionType,
      occurredAt: event.occurredAt,
      ...(event.changeSource ? { changeSource: event.changeSource } : {}),
      ...(event.sourceId ? { sourceId: event.sourceId } : {}),
      ...(propertyName ? { propertyName } : {}),
      ...(event.propertyValue !== undefined ? { propertyValue: event.propertyValue } : {}),
    },
    eventTime: Number.isNaN(eventTime.getTime()) ? new Date() : eventTime,
  };
}

function parseSubscriptionType(value: string | undefined): {
  objectType: HubspotObjectType;
  action: HubspotEventAction;
} | null {
  if (!value) return null;
  const [objectPart, actionPart] = value.split(".");
  const objectType =
    objectPart === "contact" || objectPart === "company" || objectPart === "deal"
      ? objectPart
      : null;
  if (!objectType) return null;
  if (actionPart === "creation") return { objectType, action: "create" };
  if (actionPart === "propertyChange") return { objectType, action: "update" };
  // Deletions, merges, and restores carry no durable knowledge on their own.
  return null;
}

function isNoiseProperty(propertyName: string | null): boolean {
  if (!propertyName) return false;
  const normalized = propertyName.toLowerCase();
  if (NOISE_PROPERTY_NAMES.has(normalized)) return true;
  return NOISE_PROPERTY_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function statusRedirect(
  session: Extract<IngressSession, { kind: "actor" }>,
  returnTo: string,
  status: "connected" | "error",
  reason?: string,
) {
  return sessionRedirect(
    session,
    new URL(appendHubspotIngestStatus(returnTo, status, reason), getAppUrl()),
  );
}
