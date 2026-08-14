import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "./client";
import {
  type AttioEventAction,
  type AttioObjectType,
  attioObjectEvents,
  brainSources,
  type IntegrationStatus,
  integrations,
} from "./product-schema";

type DbLike = any;

export const ATTIO_PROVIDER = "attio" as const;
export const ATTIO_CREDENTIAL_KIND = "api_key" as const;

export const ATTIO_OBJECT_TYPES = ["person", "company", "deal"] as const;

// Attio's standard-object api slugs, keyed by our object type.
export const ATTIO_OBJECT_SLUGS: Record<AttioObjectType, string> = {
  person: "people",
  company: "companies",
  deal: "deals",
};

export type AttioObjectTypeRef = {
  id: AttioObjectType;
};

export const ATTIO_EVENT_TYPES = ["object_created", "object_updated", "note_added"] as const;
export const ATTIO_DEFAULT_EVENT_TYPES = ["object_created", "note_added"] as const;

// Attio record.updated payloads have no provider-native event id. Deliveries
// for the same update reach each member webhook within a short interval, while
// distinct windows are separated by the worker's 15-minute quiet period. A
// five-minute bucket therefore deduplicates the former without collapsing all
// changes to one attribute for an entire day.
export const ATTIO_UPDATE_CLAIM_BUCKET_MS = 5 * 60_000;

export type AttioEventType = (typeof ATTIO_EVENT_TYPES)[number];

export type AttioEventRef = {
  id: AttioEventType;
};

// The whole Attio connection lives in one api_key credential: the workspace
// key the user pasted, the webhook Attio minted for us at connect time (its
// secret signs inbound deliveries), and the workspace's object UUIDs so the
// webhook receiver can map event object ids to our object types without an
// API call.
export type AttioApiKeyCredentialPayload = {
  apiKey: string;
  workspaceId: string;
  authorizedByWorkspaceMemberId?: string | null;
  webhookId: string | null;
  webhookSecret: string | null;
  objectIdBySlug: Partial<Record<AttioObjectType, string>>;
  createdAt: string;
};

// The routing contract between the object-type picker, the events webhook, and
// the flush worker: CRM activity is buffered/ingested only when its object
// type and derived event type appear in the enabled brain-source config for
// the integration.
export type AttioBrainSourceConfig = {
  objectTypes?: AttioObjectTypeRef[];
  events?: AttioEventRef[];
};

export type AttioIntegrationForWorkspace = {
  id: string;
  userWorkosId: string;
  status: IntegrationStatus;
};

export type AttioBrainSourceRoute = {
  integrationId: string;
  brainRef: string;
  config: AttioBrainSourceConfig;
};

export type AttioObjectEventInsert = {
  integrationId: string;
  userWorkosId: string;
  workspaceId: string;
  objectType: AttioObjectType;
  recordId: string;
  deliveryId: string;
  action: AttioEventAction;
  attributeId?: string | null;
  noteId?: string | null;
  payload: Record<string, unknown>;
  eventTime: Date;
};

export function parseAttioBrainSourceConfig(value: unknown): AttioBrainSourceConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const objectTypes = parseObjectTypeRefs(record.objectTypes);
  const events = parseEventRefs(record.events);
  return {
    ...(objectTypes ? { objectTypes } : {}),
    ...(events ? { events } : {}),
  };
}

export function attioSelectedObjectTypes(config: AttioBrainSourceConfig): Set<AttioObjectType> {
  const ids = new Set<AttioObjectType>();
  for (const ref of config.objectTypes ?? []) ids.add(ref.id);
  return ids;
}

export function attioSelectedEventTypes(config: AttioBrainSourceConfig): Set<AttioEventType> {
  return new Set(
    (config.events ?? ATTIO_DEFAULT_EVENT_TYPES.map((id) => ({ id }))).map((ref) => ref.id),
  );
}

export function attioRouteMatchesEvent(
  config: AttioBrainSourceConfig,
  eventType: AttioEventType,
  context: { actorType?: string | null } = {},
) {
  const selected = attioSelectedEventTypes(config);
  if (!selected.has(eventType)) return false;
  // Attio recalculates enrichment and relationship fields across many records
  // as actor "system". These provider-managed updates are never Brain events.
  return !(eventType === "object_updated" && context.actorType?.trim().toLowerCase() === "system");
}

export function attioEventTypeFor(action: AttioEventAction): AttioEventType {
  if (action === "create") return "object_created";
  if (action === "note") return "note_added";
  return "object_updated";
}

export function isAttioObjectType(value: unknown): value is AttioObjectType {
  return typeof value === "string" && (ATTIO_OBJECT_TYPES as readonly string[]).includes(value);
}

// Cross-member dedup identity for an event. Attio delivers separately to each
// member's webhook (no shared delivery id), so keys derive from event content:
// note and creation events have stable native ids; attribute updates use a
// short receipt-time bucket so the same update coalesces across member
// webhooks without suppressing a later, distinct activity window.
export function attioEventClaimKey(event: {
  workspaceId: string;
  objectType: AttioObjectType;
  recordId: string;
  action: AttioEventAction;
  attributeId?: string | null;
  noteId?: string | null;
  eventTime: Date;
}): string {
  const scope = `${event.workspaceId}:${event.objectType}:${event.recordId}`;
  if (event.action === "note") return `${scope}:note:${event.noteId ?? "unknown"}`;
  if (event.action === "create") return `${scope}:created`;
  const bucketStart = new Date(
    Math.floor(event.eventTime.getTime() / ATTIO_UPDATE_CLAIM_BUCKET_MS) *
      ATTIO_UPDATE_CLAIM_BUCKET_MS,
  ).toISOString();
  return `${scope}:updated:${event.attributeId ?? "unknown"}:${bucketStart}`;
}

export async function listAttioIntegrationsForWorkspace(
  workspaceId: string,
  db: DbLike = getDb(),
): Promise<AttioIntegrationForWorkspace[]> {
  return await db
    .select({
      id: integrations.id,
      userWorkosId: integrations.userWorkosId,
      status: integrations.status,
    })
    .from(integrations)
    .where(
      and(
        eq(integrations.provider, ATTIO_PROVIDER),
        // Integration rows key external_id on the Attio workspace id, so
        // inbound webhooks route by the event's workspace_id.
        eq(integrations.externalId, workspaceId),
      ),
    );
}

export async function listEnabledAttioBrainSourceRoutes(
  integrationIds: readonly string[],
  db: DbLike = getDb(),
): Promise<AttioBrainSourceRoute[]> {
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
        eq(brainSources.provider, ATTIO_PROVIDER),
        eq(brainSources.enabled, true),
        inArray(brainSources.integrationId, [...integrationIds]),
      ),
    );

  return rows.map((row: { integrationId: string; brainRef: string; config: unknown }) => ({
    integrationId: row.integrationId,
    brainRef: row.brainRef,
    config: parseAttioBrainSourceConfig(row.config),
  }));
}

export async function insertAttioObjectEvents(
  events: readonly AttioObjectEventInsert[],
  db: DbLike = getDb(),
): Promise<number> {
  if (events.length === 0) return 0;
  // Attio redelivers on non-2xx responses; the unique (integration, delivery
  // id) index makes redeliveries of stable-id events no-ops.
  const rows = await db
    .insert(attioObjectEvents)
    .values(
      events.map((event) => ({
        id: newAttioObjectEventId(),
        integrationId: event.integrationId,
        userWorkosId: event.userWorkosId,
        workspaceId: event.workspaceId,
        objectType: event.objectType,
        recordId: event.recordId,
        deliveryId: event.deliveryId,
        action: event.action,
        attributeId: event.attributeId ?? null,
        noteId: event.noteId ?? null,
        payload: event.payload,
        eventTime: event.eventTime,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: attioObjectEvents.id });
  return rows.length;
}

export function newAttioObjectEventId() {
  return `gattevt_${randomUUID().replace(/-/g, "")}`;
}

export function newAttioObjectWindowId() {
  return `gattwin_${randomUUID().replace(/-/g, "")}`;
}

function parseObjectTypeRefs(value: unknown): AttioObjectTypeRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<AttioObjectType>();
  const refs = value.flatMap((entry) => {
    const id =
      typeof entry === "string"
        ? entry
        : entry && typeof entry === "object" && !Array.isArray(entry)
          ? (entry as Record<string, unknown>).id
          : null;
    if (!isAttioObjectType(id) || seen.has(id)) return [];
    seen.add(id);
    return [{ id }];
  });
  return refs.length > 0 ? refs : undefined;
}

function parseEventRefs(value: unknown): AttioEventRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<AttioEventType>();
  const refs = value.flatMap((entry) => {
    const id =
      typeof entry === "string"
        ? entry
        : entry && typeof entry === "object" && !Array.isArray(entry)
          ? (entry as Record<string, unknown>).id
          : null;
    if (!isAttioEventType(id) || seen.has(id)) return [];
    seen.add(id);
    return [{ id }];
  });
  return refs;
}

function isAttioEventType(value: unknown): value is AttioEventType {
  return typeof value === "string" && (ATTIO_EVENT_TYPES as readonly string[]).includes(value);
}
