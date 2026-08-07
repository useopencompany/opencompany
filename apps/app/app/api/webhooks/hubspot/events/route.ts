import {
  type HubspotObjectEventInsert,
  hubspotEventTypeFor,
  hubspotRouteMatchesEvent,
  hubspotSelectedObjectTypes,
  insertHubspotObjectEvents,
  listEnabledHubspotBrainSourceRoutes,
  listHubspotIntegrationsForPortal,
} from "@opencompany/db/hubspot";
import type { HubspotEventAction, HubspotObjectType } from "@opencompany/db/schema";
import { NextResponse } from "next/server";
import { verifyHubspotWebhookSignature } from "@/lib/integrations/hubspot-signature";
import { getAppUrl } from "@/lib/workos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

export async function POST(request: Request) {
  const rawBody = await request.text();

  // HubSpot signs the exact URI it delivered to; behind Vercel's proxy the
  // observed request URL is usually right, with the canonical app URL as the
  // fallback candidate.
  const requestUrl = new URL(request.url);
  const canonicalUrl = new URL(
    `${requestUrl.pathname}${requestUrl.search}`,
    getAppUrl(),
  ).toString();
  const verified = verifyHubspotWebhookSignature({
    method: "POST",
    candidateUris: request.url === canonicalUrl ? [request.url] : [request.url, canonicalUrl],
    rawBody,
    signature: request.headers.get("x-hubspot-signature-v3"),
    timestampHeader: request.headers.get("x-hubspot-request-timestamp"),
  });
  if (!verified) {
    return NextResponse.json({ error: "Invalid HubSpot signature." }, { status: 401 });
  }

  let events: HubspotWebhookEvent[];
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    events = Array.isArray(parsed) ? (parsed as HubspotWebhookEvent[]) : [];
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  // Delivery ids make retries idempotent. Surface transient routing or storage
  // failures so HubSpot redelivers instead of silently losing CRM activity.
  try {
    return NextResponse.json(await handleHubspotEvents(events));
  } catch (error) {
    console.error("[hubspot] Failed to process HubSpot events", {
      eventCount: events.length,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: "Unable to buffer HubSpot events." }, { status: 503 });
  }
}

async function handleHubspotEvents(events: HubspotWebhookEvent[]) {
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
    const integrations = await listHubspotIntegrationsForPortal(portalId);
    const connected = integrations.filter((integration) => integration.status === "connected");
    if (connected.length === 0) continue;

    const routes = await listEnabledHubspotBrainSourceRoutes(
      connected.map((integration) => integration.id),
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

    buffered += await insertHubspotObjectEvents(inserts);
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
