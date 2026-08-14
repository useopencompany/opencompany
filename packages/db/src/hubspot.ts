import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "./client";
import {
  brainSources,
  type HubspotEventAction,
  type HubspotObjectType,
  hubspotObjectEvents,
  type IntegrationStatus,
  integrations,
} from "./product-schema";

type DbLike = any;

export const HUBSPOT_OBJECT_TYPES = ["contact", "company", "deal"] as const;

export type HubspotObjectTypeRef = {
  id: HubspotObjectType;
};

export const HUBSPOT_EVENT_TYPES = [
  "object_created",
  "object_updated",
  "object_stage_changed",
] as const;

export type HubspotEventType = (typeof HUBSPOT_EVENT_TYPES)[number];

export type HubspotEventRef = {
  id: HubspotEventType;
};

// Deal/ticket-style stage properties: a property change on one of these is a
// pipeline move rather than an ordinary field edit.
const HUBSPOT_STAGE_PROPERTY_NAMES = new Set(["dealstage", "hs_pipeline_stage", "lifecyclestage"]);

// The routing contract between the object-type picker, the events webhook, and
// the flush worker: CRM activity is buffered/ingested only when its object
// type and derived event type appear in the enabled brain-source config for
// the integration.
export type HubspotBrainSourceConfig = {
  objectTypes?: HubspotObjectTypeRef[];
  events?: HubspotEventRef[];
};

export type HubspotIntegrationForPortal = {
  id: string;
  userWorkosId: string;
  status: IntegrationStatus;
};

export type HubspotBrainSourceRoute = {
  integrationId: string;
  brainRef: string;
  config: HubspotBrainSourceConfig;
};

export type HubspotObjectEventInsert = {
  integrationId: string;
  userWorkosId: string;
  portalId: string;
  objectType: HubspotObjectType;
  objectId: string;
  deliveryId: string;
  action: HubspotEventAction;
  propertyName?: string | null;
  payload: Record<string, unknown>;
  eventTime: Date;
};

export function parseHubspotBrainSourceConfig(value: unknown): HubspotBrainSourceConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const objectTypes = parseObjectTypeRefs(record.objectTypes);
  const events = parseEventRefs(record.events);
  return {
    ...(objectTypes ? { objectTypes } : {}),
    ...(events ? { events } : {}),
  };
}

export function hubspotSelectedObjectTypes(
  config: HubspotBrainSourceConfig,
): Set<HubspotObjectType> {
  const ids = new Set<HubspotObjectType>();
  for (const ref of config.objectTypes ?? []) ids.add(ref.id);
  return ids;
}

export function hubspotSelectedEventTypes(
  config: HubspotBrainSourceConfig,
): Set<HubspotEventType> | null {
  if (!config.events) return null;
  return new Set(config.events.map((ref) => ref.id));
}

export function hubspotRouteMatchesEvent(
  config: HubspotBrainSourceConfig,
  eventType: HubspotEventType,
) {
  const selected = hubspotSelectedEventTypes(config);
  return selected === null || selected.has(eventType);
}

export function hubspotEventTypeFor(input: {
  action: HubspotEventAction;
  propertyName?: string | null;
}): HubspotEventType {
  if (input.action === "create") return "object_created";
  return input.propertyName && HUBSPOT_STAGE_PROPERTY_NAMES.has(input.propertyName)
    ? "object_stage_changed"
    : "object_updated";
}

export function isHubspotObjectType(value: unknown): value is HubspotObjectType {
  return typeof value === "string" && (HUBSPOT_OBJECT_TYPES as readonly string[]).includes(value);
}

export async function listHubspotIntegrationsForPortal(
  portalId: string,
  db: DbLike = getDb(),
): Promise<HubspotIntegrationForPortal[]> {
  return await db
    .select({
      id: integrations.id,
      userWorkosId: integrations.userWorkosId,
      status: integrations.status,
    })
    .from(integrations)
    .where(
      and(
        eq(integrations.provider, "hubspot"),
        // Integration rows key external_id on the HubSpot portal (hub) id, so
        // inbound webhooks route by payload portalId.
        eq(integrations.externalId, portalId),
      ),
    );
}

export async function listEnabledHubspotBrainSourceRoutes(
  integrationIds: readonly string[],
  db: DbLike = getDb(),
): Promise<HubspotBrainSourceRoute[]> {
  if (integrationIds.length === 0) return [];
  const rows = await db
    .select({
      integrationId: brainSources.integrationId,
      brainRef: brainSources.brainId,
      config: brainSources.config,
    })
    .from(brainSources)
    .where(
      and(
        eq(brainSources.provider, "hubspot"),
        eq(brainSources.enabled, true),
        inArray(brainSources.integrationId, [...integrationIds]),
      ),
    );

  return rows.map((row: { integrationId: string; brainRef: string; config: unknown }) => ({
    integrationId: row.integrationId,
    brainRef: row.brainRef,
    config: parseHubspotBrainSourceConfig(row.config),
  }));
}

export async function insertHubspotObjectEvents(
  events: readonly HubspotObjectEventInsert[],
  db: DbLike = getDb(),
): Promise<number> {
  if (events.length === 0) return 0;
  // HubSpot redelivers webhooks on retry; the unique (integration, delivery id)
  // index makes redeliveries no-ops.
  const rows = await db
    .insert(hubspotObjectEvents)
    .values(
      events.map((event) => ({
        id: newHubspotObjectEventId(),
        integrationId: event.integrationId,
        userWorkosId: event.userWorkosId,
        portalId: event.portalId,
        objectType: event.objectType,
        objectId: event.objectId,
        deliveryId: event.deliveryId,
        action: event.action,
        propertyName: event.propertyName ?? null,
        payload: event.payload,
        eventTime: event.eventTime,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: hubspotObjectEvents.id });
  return rows.length;
}

export function newHubspotObjectEventId() {
  return `ghubevt_${randomUUID().replace(/-/g, "")}`;
}

export function newHubspotObjectWindowId() {
  return `ghubwin_${randomUUID().replace(/-/g, "")}`;
}

function parseObjectTypeRefs(value: unknown): HubspotObjectTypeRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<HubspotObjectType>();
  const refs = value.flatMap((entry) => {
    const id =
      typeof entry === "string"
        ? entry
        : entry && typeof entry === "object" && !Array.isArray(entry)
          ? (entry as Record<string, unknown>).id
          : null;
    if (!isHubspotObjectType(id) || seen.has(id)) return [];
    seen.add(id);
    return [{ id }];
  });
  return refs.length > 0 ? refs : undefined;
}

function parseEventRefs(value: unknown): HubspotEventRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<HubspotEventType>();
  const refs = value.flatMap((entry) => {
    const id =
      typeof entry === "string"
        ? entry
        : entry && typeof entry === "object" && !Array.isArray(entry)
          ? (entry as Record<string, unknown>).id
          : null;
    if (!isHubspotEventType(id) || seen.has(id)) return [];
    seen.add(id);
    return [{ id }];
  });
  return refs;
}

function isHubspotEventType(value: unknown): value is HubspotEventType {
  return typeof value === "string" && (HUBSPOT_EVENT_TYPES as readonly string[]).includes(value);
}
