import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "./client";
import {
  type GoatHubspotEventAction,
  type GoatHubspotObjectType,
  type GoatIntegrationStatus,
  goatBrainSources,
  goatHubspotObjectEvents,
  goatIntegrations,
} from "./schema";

type DbLike = any;

export const GOAT_HUBSPOT_OBJECT_TYPES = ["contact", "company", "deal"] as const;

export type GoatHubspotObjectTypeRef = {
  id: GoatHubspotObjectType;
};

export const GOAT_HUBSPOT_EVENT_TYPES = [
  "object_created",
  "object_updated",
  "object_stage_changed",
] as const;

export type GoatHubspotEventType = (typeof GOAT_HUBSPOT_EVENT_TYPES)[number];

export type GoatHubspotEventRef = {
  id: GoatHubspotEventType;
};

// Deal/ticket-style stage properties: a property change on one of these is a
// pipeline move rather than an ordinary field edit.
const HUBSPOT_STAGE_PROPERTY_NAMES = new Set(["dealstage", "hs_pipeline_stage", "lifecyclestage"]);

// The routing contract between the object-type picker, the events webhook, and
// the flush worker: CRM activity is buffered/ingested only when its object
// type and derived event type appear in the enabled brain-source config for
// the integration.
export type GoatHubspotBrainSourceConfig = {
  objectTypes?: GoatHubspotObjectTypeRef[];
  events?: GoatHubspotEventRef[];
};

export type GoatHubspotIntegrationForPortal = {
  id: string;
  userWorkosId: string;
  status: GoatIntegrationStatus;
};

export type GoatHubspotBrainSourceRoute = {
  integrationId: string;
  brainRef: string;
  config: GoatHubspotBrainSourceConfig;
};

export type GoatHubspotObjectEventInsert = {
  integrationId: string;
  userWorkosId: string;
  portalId: string;
  objectType: GoatHubspotObjectType;
  objectId: string;
  deliveryId: string;
  action: GoatHubspotEventAction;
  propertyName?: string | null;
  payload: Record<string, unknown>;
  eventTime: Date;
};

export function parseGoatHubspotBrainSourceConfig(value: unknown): GoatHubspotBrainSourceConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const objectTypes = parseObjectTypeRefs(record.objectTypes);
  const events = parseEventRefs(record.events);
  return {
    ...(objectTypes ? { objectTypes } : {}),
    ...(events ? { events } : {}),
  };
}

export function goatHubspotSelectedObjectTypes(
  config: GoatHubspotBrainSourceConfig,
): Set<GoatHubspotObjectType> {
  const ids = new Set<GoatHubspotObjectType>();
  for (const ref of config.objectTypes ?? []) ids.add(ref.id);
  return ids;
}

export function goatHubspotSelectedEventTypes(
  config: GoatHubspotBrainSourceConfig,
): Set<GoatHubspotEventType> | null {
  if (!config.events) return null;
  return new Set(config.events.map((ref) => ref.id));
}

export function goatHubspotRouteMatchesEvent(
  config: GoatHubspotBrainSourceConfig,
  eventType: GoatHubspotEventType,
) {
  const selected = goatHubspotSelectedEventTypes(config);
  return selected === null || selected.has(eventType);
}

export function goatHubspotEventTypeFor(input: {
  action: GoatHubspotEventAction;
  propertyName?: string | null;
}): GoatHubspotEventType {
  if (input.action === "create") return "object_created";
  return input.propertyName && HUBSPOT_STAGE_PROPERTY_NAMES.has(input.propertyName)
    ? "object_stage_changed"
    : "object_updated";
}

export function isGoatHubspotObjectType(value: unknown): value is GoatHubspotObjectType {
  return (
    typeof value === "string" && (GOAT_HUBSPOT_OBJECT_TYPES as readonly string[]).includes(value)
  );
}

export async function listGoatHubspotIntegrationsForPortal(
  portalId: string,
  db: DbLike = getDb(),
): Promise<GoatHubspotIntegrationForPortal[]> {
  return await db
    .select({
      id: goatIntegrations.id,
      userWorkosId: goatIntegrations.userWorkosId,
      status: goatIntegrations.status,
    })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.provider, "hubspot"),
        // Integration rows key external_id on the HubSpot portal (hub) id, so
        // inbound webhooks route by payload portalId.
        eq(goatIntegrations.externalId, portalId),
      ),
    );
}

export async function listEnabledGoatHubspotBrainSourceRoutes(
  integrationIds: readonly string[],
  db: DbLike = getDb(),
): Promise<GoatHubspotBrainSourceRoute[]> {
  if (integrationIds.length === 0) return [];
  const rows = await db
    .select({
      integrationId: goatBrainSources.integrationId,
      brainRef: goatBrainSources.brainId,
      config: goatBrainSources.config,
    })
    .from(goatBrainSources)
    .where(
      and(
        eq(goatBrainSources.provider, "hubspot"),
        eq(goatBrainSources.enabled, true),
        inArray(goatBrainSources.integrationId, [...integrationIds]),
      ),
    );

  return rows.map((row: { integrationId: string; brainRef: string; config: unknown }) => ({
    integrationId: row.integrationId,
    brainRef: row.brainRef,
    config: parseGoatHubspotBrainSourceConfig(row.config),
  }));
}

export async function insertGoatHubspotObjectEvents(
  events: readonly GoatHubspotObjectEventInsert[],
  db: DbLike = getDb(),
): Promise<number> {
  if (events.length === 0) return 0;
  // HubSpot redelivers webhooks on retry; the unique (integration, delivery id)
  // index makes redeliveries no-ops.
  const rows = await db
    .insert(goatHubspotObjectEvents)
    .values(
      events.map((event) => ({
        id: newGoatHubspotObjectEventId(),
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
    .returning({ id: goatHubspotObjectEvents.id });
  return rows.length;
}

export function newGoatHubspotObjectEventId() {
  return `ghubevt_${randomUUID().replace(/-/g, "")}`;
}

export function newGoatHubspotObjectWindowId() {
  return `ghubwin_${randomUUID().replace(/-/g, "")}`;
}

function parseObjectTypeRefs(value: unknown): GoatHubspotObjectTypeRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<GoatHubspotObjectType>();
  const refs = value.flatMap((entry) => {
    const id =
      typeof entry === "string"
        ? entry
        : entry && typeof entry === "object" && !Array.isArray(entry)
          ? (entry as Record<string, unknown>).id
          : null;
    if (!isGoatHubspotObjectType(id) || seen.has(id)) return [];
    seen.add(id);
    return [{ id }];
  });
  return refs.length > 0 ? refs : undefined;
}

function parseEventRefs(value: unknown): GoatHubspotEventRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<GoatHubspotEventType>();
  const refs = value.flatMap((entry) => {
    const id =
      typeof entry === "string"
        ? entry
        : entry && typeof entry === "object" && !Array.isArray(entry)
          ? (entry as Record<string, unknown>).id
          : null;
    if (!isGoatHubspotEventType(id) || seen.has(id)) return [];
    seen.add(id);
    return [{ id }];
  });
  return refs;
}

function isGoatHubspotEventType(value: unknown): value is GoatHubspotEventType {
  return (
    typeof value === "string" && (GOAT_HUBSPOT_EVENT_TYPES as readonly string[]).includes(value)
  );
}
