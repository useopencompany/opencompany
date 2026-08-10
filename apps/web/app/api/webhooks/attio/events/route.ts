import { randomUUID } from "node:crypto";
import {
  GOAT_ATTIO_CREDENTIAL_KIND,
  GOAT_ATTIO_PROVIDER,
  type GoatAttioApiKeyCredentialPayload,
  type GoatAttioObjectEventInsert,
  goatAttioEventTypeFor,
  goatAttioRouteMatchesEvent,
  goatAttioSelectedObjectTypes,
  insertGoatAttioObjectEvents,
  listEnabledGoatAttioBrainSourceRoutes,
  listGoatAttioIntegrationsForWorkspace,
} from "@opencompany/db/goat-attio";
import { loadGoatIntegrationCredential } from "@opencompany/db/goat-integrations";
import type { GoatAttioEventAction, GoatAttioObjectType } from "@opencompany/db/goat-schema";
import { NextResponse } from "next/server";
import { verifyGoatAttioWebhookSignature } from "@/lib/integrations/attio-signature";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AttioWebhookEvent = {
  event_type?: string;
  id?: {
    workspace_id?: string;
    object_id?: string;
    record_id?: string;
    attribute_id?: string;
    note_id?: string;
  };
  parent_object_id?: string;
  parent_record_id?: string;
  actor?: { type?: string | null; id?: string | null };
};

type AttioWebhookDelivery = {
  webhook_id?: string;
  events?: AttioWebhookEvent[];
};

export async function POST(request: Request) {
  const rawBody = await request.text();

  // Attio signs the raw body with a per-webhook secret, so the delivery must
  // be parsed first to find which integration's webhook (and secret) it is.
  let delivery: AttioWebhookDelivery;
  try {
    delivery = JSON.parse(rawBody) as AttioWebhookDelivery;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }
  const webhookId = typeof delivery.webhook_id === "string" ? delivery.webhook_id : "";
  const events = Array.isArray(delivery.events) ? delivery.events : [];
  const workspaceId = events
    .map((event) => event.id?.workspace_id)
    .find((value): value is string => typeof value === "string" && value.length > 0);
  if (!webhookId || !workspaceId) {
    return NextResponse.json({ ok: true, ignored: true });
  }

  const signature =
    request.headers.get("attio-signature") ?? request.headers.get("x-attio-signature");
  const idempotencyKey = asHeaderValue(request.headers.get("idempotency-key"));

  // Surface transient routing or storage failures so Attio redelivers instead
  // of silently losing CRM activity.
  try {
    const match = await findIntegrationForWebhook(workspaceId, webhookId);
    if (!match) {
      return NextResponse.json({ error: "Unknown Attio webhook." }, { status: 401 });
    }
    const verified = verifyGoatAttioWebhookSignature({
      rawBody,
      signature,
      secret: match.payload.webhookSecret,
    });
    if (!verified) {
      return NextResponse.json({ error: "Invalid Attio signature." }, { status: 401 });
    }
    return NextResponse.json(
      await handleAttioEvents({ events, workspaceId, idempotencyKey, match }),
    );
  } catch (error) {
    console.error("[goat-attio] Failed to process Attio events", {
      eventCount: events.length,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: "Unable to buffer Attio events." }, { status: 503 });
  }
}

type AttioIntegrationMatch = {
  integrationId: string;
  userWorkosId: string;
  connected: boolean;
  payload: GoatAttioApiKeyCredentialPayload;
};

// Each integration of an Attio workspace owns its own webhook; the delivery's
// webhook_id identifies exactly one of them (and carries that webhook's
// signing secret).
async function findIntegrationForWebhook(
  workspaceId: string,
  webhookId: string,
): Promise<AttioIntegrationMatch | null> {
  const integrations = await listGoatAttioIntegrationsForWorkspace(workspaceId);
  for (const integration of integrations) {
    const credential = await loadGoatIntegrationCredential({
      userWorkosId: integration.userWorkosId,
      integrationId: integration.id,
      provider: GOAT_ATTIO_PROVIDER,
      kind: GOAT_ATTIO_CREDENTIAL_KIND,
    }).catch(() => null);
    const payload = credential?.payload as GoatAttioApiKeyCredentialPayload | undefined;
    if (payload?.webhookId !== webhookId) continue;
    return {
      integrationId: integration.id,
      userWorkosId: integration.userWorkosId,
      connected: integration.status === "connected",
      payload,
    };
  }
  return null;
}

async function handleAttioEvents(input: {
  events: AttioWebhookEvent[];
  workspaceId: string;
  idempotencyKey: string | null;
  match: AttioIntegrationMatch;
}) {
  const { events, workspaceId, idempotencyKey, match } = input;
  if (!match.connected) return { ok: true, ignored: true };

  const objectTypeById = new Map<string, GoatAttioObjectType>();
  for (const [type, objectId] of Object.entries(match.payload.objectIdBySlug ?? {})) {
    if (typeof objectId === "string" && objectId) {
      objectTypeById.set(objectId, type as GoatAttioObjectType);
    }
  }

  const routes = await listEnabledGoatAttioBrainSourceRoutes([match.integrationId]);
  if (routes.length === 0) return { ok: true, ignored: true };

  const inserts: GoatAttioObjectEventInsert[] = [];
  for (const [eventIndex, event] of events.entries()) {
    const parsed = parseAttioEvent(event, objectTypeById, {
      idempotencyKey,
      eventIndex,
    });
    if (!parsed) continue;
    const eventType = goatAttioEventTypeFor(parsed.action);
    const actorType =
      typeof parsed.payload.actorType === "string" ? parsed.payload.actorType : null;
    const matched = routes.some((route) => {
      const selected = goatAttioSelectedObjectTypes(route.config);
      if (selected.size === 0) return false;
      if (!selected.has(parsed.objectType)) return false;
      return goatAttioRouteMatchesEvent(route.config, eventType, { actorType });
    });
    if (!matched) continue;
    inserts.push({
      integrationId: match.integrationId,
      userWorkosId: match.userWorkosId,
      workspaceId,
      ...parsed,
    });
  }

  const buffered = await insertGoatAttioObjectEvents(inserts);
  return { ok: true, buffered };
}

function parseAttioEvent(
  event: AttioWebhookEvent,
  objectTypeById: ReadonlyMap<string, GoatAttioObjectType>,
  delivery: { idempotencyKey: string | null; eventIndex: number },
): Omit<GoatAttioObjectEventInsert, "integrationId" | "userWorkosId" | "workspaceId"> | null {
  const eventType = event.event_type;
  const actorType = typeof event.actor?.type === "string" ? event.actor.type : null;

  if (eventType === "record.created" || eventType === "record.updated") {
    const objectId = asId(event.id?.object_id);
    const recordId = asId(event.id?.record_id);
    const objectType = objectId ? objectTypeById.get(objectId) : undefined;
    if (!objectType || !recordId) return null;
    const action: GoatAttioEventAction = eventType === "record.created" ? "create" : "update";
    const attributeId = action === "update" ? asId(event.id?.attribute_id) : null;
    return {
      objectType,
      recordId,
      deliveryId:
        action === "create"
          ? `created:${recordId}`
          : attioDeliveryId({
              idempotencyKey: delivery.idempotencyKey,
              eventIndex: delivery.eventIndex,
              fallback: `updated:${recordId}:${attributeId ?? "unknown"}:${randomUUID()}`,
            }),
      action,
      attributeId,
      noteId: null,
      payload: {
        eventType,
        ...(attributeId ? { attributeId } : {}),
        ...(actorType ? { actorType } : {}),
      },
      // Attio events carry no occurred-at timestamp; receipt time orders the
      // window well enough for quiet-period batching.
      eventTime: new Date(),
    };
  }

  if (eventType === "note.created") {
    const parentObjectId = asId(event.parent_object_id);
    const recordId = asId(event.parent_record_id);
    const noteId = asId(event.id?.note_id);
    const objectType = parentObjectId ? objectTypeById.get(parentObjectId) : undefined;
    if (!objectType || !recordId || !noteId) return null;
    return {
      objectType,
      recordId,
      deliveryId: `note:${noteId}`,
      action: "note",
      attributeId: null,
      noteId,
      payload: {
        eventType,
        noteId,
        ...(actorType ? { actorType } : {}),
      },
      eventTime: new Date(),
    };
  }

  // Deletions, merges, and other event families carry no durable knowledge on
  // their own.
  return null;
}

function asId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asHeaderValue(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= 512 ? trimmed : null;
}

function attioDeliveryId(input: {
  idempotencyKey: string | null;
  eventIndex: number;
  fallback: string;
}) {
  return input.idempotencyKey
    ? `delivery:${input.idempotencyKey}:${input.eventIndex}`
    : input.fallback;
}
