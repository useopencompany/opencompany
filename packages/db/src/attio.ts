import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "./client";
import {
  type GoatAttioEventAction,
  type GoatAttioObjectType,
  type GoatIntegrationStatus,
  goatAttioObjectEvents,
  goatBrainSources,
  goatIntegrations,
} from "./schema";

type DbLike = any;

export const GOAT_ATTIO_PROVIDER = "attio" as const;
export const GOAT_ATTIO_CREDENTIAL_KIND = "api_key" as const;

export const GOAT_ATTIO_OBJECT_TYPES = ["person", "company", "deal"] as const;

// Attio's standard-object api slugs, keyed by our object type.
export const GOAT_ATTIO_OBJECT_SLUGS: Record<GoatAttioObjectType, string> = {
  person: "people",
  company: "companies",
  deal: "deals",
};

export type GoatAttioObjectTypeRef = {
  id: GoatAttioObjectType;
};

export const GOAT_ATTIO_EVENT_TYPES = ["object_created", "object_updated", "note_added"] as const;
export const GOAT_ATTIO_DEFAULT_EVENT_TYPES = ["object_created", "note_added"] as const;

// Attio record.updated payloads have no provider-native event id. Deliveries
// for the same update reach each member webhook within a short interval, while
// distinct windows are separated by the worker's 15-minute quiet period. A
// five-minute bucket therefore deduplicates the former without collapsing all
// changes to one attribute for an entire day.
export const GOAT_ATTIO_UPDATE_CLAIM_BUCKET_MS = 5 * 60_000;

export type GoatAttioEventType = (typeof GOAT_ATTIO_EVENT_TYPES)[number];

export type GoatAttioEventRef = {
  id: GoatAttioEventType;
};

// The whole Attio connection lives in one api_key credential: the workspace
// key the user pasted, the webhook Attio minted for us at connect time (its
// secret signs inbound deliveries), and the workspace's object UUIDs so the
// webhook receiver can map event object ids to our object types without an
// API call.
export type GoatAttioApiKeyCredentialPayload = {
  apiKey: string;
  workspaceId: string;
  authorizedByWorkspaceMemberId?: string | null;
  webhookId: string | null;
  webhookSecret: string | null;
  objectIdBySlug: Partial<Record<GoatAttioObjectType, string>>;
  createdAt: string;
};

// The routing contract between the object-type picker, the events webhook, and
// the flush worker: CRM activity is buffered/ingested only when its object
// type and derived event type appear in the enabled brain-source config for
// the integration.
export type GoatAttioBrainSourceConfig = {
  objectTypes?: GoatAttioObjectTypeRef[];
  events?: GoatAttioEventRef[];
};

export type GoatAttioIntegrationForWorkspace = {
  id: string;
  userWorkosId: string;
  status: GoatIntegrationStatus;
};

export type GoatAttioBrainSourceRoute = {
  integrationId: string;
  brainRef: string;
  config: GoatAttioBrainSourceConfig;
};

export type GoatAttioObjectEventInsert = {
  integrationId: string;
  userWorkosId: string;
  workspaceId: string;
  objectType: GoatAttioObjectType;
  recordId: string;
  deliveryId: string;
  action: GoatAttioEventAction;
  attributeId?: string | null;
  noteId?: string | null;
  payload: Record<string, unknown>;
  eventTime: Date;
};

export function parseGoatAttioBrainSourceConfig(value: unknown): GoatAttioBrainSourceConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const objectTypes = parseObjectTypeRefs(record.objectTypes);
  const events = parseEventRefs(record.events);
  return {
    ...(objectTypes ? { objectTypes } : {}),
    ...(events ? { events } : {}),
  };
}

export function goatAttioSelectedObjectTypes(
  config: GoatAttioBrainSourceConfig,
): Set<GoatAttioObjectType> {
  const ids = new Set<GoatAttioObjectType>();
  for (const ref of config.objectTypes ?? []) ids.add(ref.id);
  return ids;
}

export function goatAttioSelectedEventTypes(
  config: GoatAttioBrainSourceConfig,
): Set<GoatAttioEventType> {
  return new Set(
    (config.events ?? GOAT_ATTIO_DEFAULT_EVENT_TYPES.map((id) => ({ id }))).map((ref) => ref.id),
  );
}

export function goatAttioRouteMatchesEvent(
  config: GoatAttioBrainSourceConfig,
  eventType: GoatAttioEventType,
  context: { actorType?: string | null } = {},
) {
  const selected = goatAttioSelectedEventTypes(config);
  if (!selected.has(eventType)) return false;
  // Attio recalculates enrichment and relationship fields across many records
  // as actor "system". These provider-managed updates are never Brain events.
  return !(eventType === "object_updated" && context.actorType?.trim().toLowerCase() === "system");
}

export function goatAttioEventTypeFor(action: GoatAttioEventAction): GoatAttioEventType {
  if (action === "create") return "object_created";
  if (action === "note") return "note_added";
  return "object_updated";
}

export function isGoatAttioObjectType(value: unknown): value is GoatAttioObjectType {
  return (
    typeof value === "string" && (GOAT_ATTIO_OBJECT_TYPES as readonly string[]).includes(value)
  );
}

// Cross-member dedup identity for an event. Attio delivers separately to each
// member's webhook (no shared delivery id), so keys derive from event content:
// note and creation events have stable native ids; attribute updates use a
// short receipt-time bucket so the same update coalesces across member
// webhooks without suppressing a later, distinct activity window.
export function goatAttioEventClaimKey(event: {
  workspaceId: string;
  objectType: GoatAttioObjectType;
  recordId: string;
  action: GoatAttioEventAction;
  attributeId?: string | null;
  noteId?: string | null;
  eventTime: Date;
}): string {
  const scope = `${event.workspaceId}:${event.objectType}:${event.recordId}`;
  if (event.action === "note") return `${scope}:note:${event.noteId ?? "unknown"}`;
  if (event.action === "create") return `${scope}:created`;
  const bucketStart = new Date(
    Math.floor(event.eventTime.getTime() / GOAT_ATTIO_UPDATE_CLAIM_BUCKET_MS) *
      GOAT_ATTIO_UPDATE_CLAIM_BUCKET_MS,
  ).toISOString();
  return `${scope}:updated:${event.attributeId ?? "unknown"}:${bucketStart}`;
}

export async function listGoatAttioIntegrationsForWorkspace(
  workspaceId: string,
  db: DbLike = getDb(),
): Promise<GoatAttioIntegrationForWorkspace[]> {
  return await db
    .select({
      id: goatIntegrations.id,
      userWorkosId: goatIntegrations.userWorkosId,
      status: goatIntegrations.status,
    })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.provider, GOAT_ATTIO_PROVIDER),
        // Integration rows key external_id on the Attio workspace id, so
        // inbound webhooks route by the event's workspace_id.
        eq(goatIntegrations.externalId, workspaceId),
      ),
    );
}

export async function listEnabledGoatAttioBrainSourceRoutes(
  integrationIds: readonly string[],
  db: DbLike = getDb(),
): Promise<GoatAttioBrainSourceRoute[]> {
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
        eq(goatBrainSources.provider, GOAT_ATTIO_PROVIDER),
        eq(goatBrainSources.enabled, true),
        inArray(goatBrainSources.integrationId, [...integrationIds]),
      ),
    );

  return rows.map((row: { integrationId: string; brainRef: string; config: unknown }) => ({
    integrationId: row.integrationId,
    brainRef: row.brainRef,
    config: parseGoatAttioBrainSourceConfig(row.config),
  }));
}

export async function insertGoatAttioObjectEvents(
  events: readonly GoatAttioObjectEventInsert[],
  db: DbLike = getDb(),
): Promise<number> {
  if (events.length === 0) return 0;
  // Attio redelivers on non-2xx responses; the unique (integration, delivery
  // id) index makes redeliveries of stable-id events no-ops.
  const rows = await db
    .insert(goatAttioObjectEvents)
    .values(
      events.map((event) => ({
        id: newGoatAttioObjectEventId(),
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
    .returning({ id: goatAttioObjectEvents.id });
  return rows.length;
}

export function newGoatAttioObjectEventId() {
  return `gattevt_${randomUUID().replace(/-/g, "")}`;
}

export function newGoatAttioObjectWindowId() {
  return `gattwin_${randomUUID().replace(/-/g, "")}`;
}

function parseObjectTypeRefs(value: unknown): GoatAttioObjectTypeRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<GoatAttioObjectType>();
  const refs = value.flatMap((entry) => {
    const id =
      typeof entry === "string"
        ? entry
        : entry && typeof entry === "object" && !Array.isArray(entry)
          ? (entry as Record<string, unknown>).id
          : null;
    if (!isGoatAttioObjectType(id) || seen.has(id)) return [];
    seen.add(id);
    return [{ id }];
  });
  return refs.length > 0 ? refs : undefined;
}

function parseEventRefs(value: unknown): GoatAttioEventRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<GoatAttioEventType>();
  const refs = value.flatMap((entry) => {
    const id =
      typeof entry === "string"
        ? entry
        : entry && typeof entry === "object" && !Array.isArray(entry)
          ? (entry as Record<string, unknown>).id
          : null;
    if (!isGoatAttioEventType(id) || seen.has(id)) return [];
    seen.add(id);
    return [{ id }];
  });
  return refs;
}

function isGoatAttioEventType(value: unknown): value is GoatAttioEventType {
  return typeof value === "string" && (GOAT_ATTIO_EVENT_TYPES as readonly string[]).includes(value);
}
