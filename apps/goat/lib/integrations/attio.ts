import { randomUUID } from "node:crypto";
import { getDb } from "@opencompany/db/client";
import {
  GOAT_ATTIO_CREDENTIAL_KIND,
  GOAT_ATTIO_OBJECT_SLUGS,
  GOAT_ATTIO_PROVIDER,
  type GoatAttioApiKeyCredentialPayload,
} from "@opencompany/db/goat-attio";
import {
  loadGoatIntegrationCredential,
  markGoatIntegrationStatus,
  saveGoatIntegrationCredential,
} from "@opencompany/db/goat-integrations";
import { type GoatAttioObjectType, goatIntegrations } from "@opencompany/db/goat-schema";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { getGoatAppUrl } from "@/lib/app-url";
import type { GoatAttioProviderState } from "@/lib/integration-state";
import { captureGoatIntegrationAddedAnalytics } from "@/lib/integrations/analytics";

export const GOAT_ATTIO_API_BASE_URL = "https://api.attio.com/v2";

const ATTIO_API_TIMEOUT_MS = 15_000;

export class GoatAttioApiRequestError extends Error {
  readonly status: number;

  constructor(status: number, method: string, path: string) {
    super(`Attio API ${method} ${path} failed (${status}).`);
    this.name = "GoatAttioApiRequestError";
    this.status = status;
  }
}

// The webhook subscriptions the connection needs: record lifecycle on the
// standard CRM objects plus notes attached to them. Everything else (lists,
// comments, tasks) stays out of scope for ingestion.
const ATTIO_RECORD_EVENT_TYPES = ["record.created", "record.updated"] as const;
const ATTIO_NOTE_EVENT_TYPE = "note.created";

export type GoatAttioWorkspaceIdentity = {
  workspaceId: string;
  workspaceName: string | null;
  workspaceSlug: string | null;
  scopes: string[];
};

export function parseGoatAttioScopes(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : typeof value === "string"
      ? value.split(/\s+/)
      : [];
  return [...new Set(values.map((scope) => scope.trim()).filter(Boolean))].sort();
}

// Attio publishes no key format; only reject strings that are clearly not a
// pasted key (whitespace, absurd lengths) and let the API call be the judge.
export function isValidAttioApiKey(apiKey: string) {
  return /^\S{16,2000}$/.test(apiKey);
}

export type GoatAttioApiKeyValidation =
  | { ok: true; identity: GoatAttioWorkspaceIdentity }
  | { ok: false; error: string };

// GET /v2/self identifies the workspace the key is scoped to and doubles as
// the liveness check.
export async function validateGoatAttioApiKey(apiKey: string): Promise<GoatAttioApiKeyValidation> {
  let response: Response;
  try {
    response = await fetch(`${GOAT_ATTIO_API_BASE_URL}/self`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(ATTIO_API_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, error: "Could not reach the Attio API. Try again in a moment." };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, error: "Attio rejected this API key. Check it and try again." };
  }
  if (!response.ok) {
    return { ok: false, error: `Attio API returned an unexpected error (${response.status}).` };
  }
  const body = (await response.json().catch(() => null)) as {
    active?: boolean;
    workspace_id?: string;
    workspace_name?: string;
    workspace_slug?: string;
    scope?: string | string[];
  } | null;
  if (!body?.active || typeof body.workspace_id !== "string" || !body.workspace_id) {
    return { ok: false, error: "Attio reports this API key as inactive." };
  }
  return {
    ok: true,
    identity: {
      workspaceId: body.workspace_id,
      workspaceName: typeof body.workspace_name === "string" ? body.workspace_name : null,
      workspaceSlug: typeof body.workspace_slug === "string" ? body.workspace_slug : null,
      scopes: parseGoatAttioScopes(body.scope),
    },
  };
}

// Resolves the workspace's object UUIDs for our standard object types. Events
// reference objects by UUID, so the webhook receiver needs this map to route
// without an API call.
export async function fetchGoatAttioObjectIds(
  apiKey: string,
): Promise<Partial<Record<GoatAttioObjectType, string>>> {
  const response = await requestGoatAttioApi({ apiKey, path: "/objects" });
  const objects = (response as { data?: Array<Record<string, unknown>> })?.data ?? [];
  const slugToType = new Map(
    (Object.entries(GOAT_ATTIO_OBJECT_SLUGS) as [GoatAttioObjectType, string][]).map(
      ([type, slug]) => [slug, type],
    ),
  );
  const objectIdBySlug: Partial<Record<GoatAttioObjectType, string>> = {};
  for (const object of objects) {
    const slug = typeof object.api_slug === "string" ? object.api_slug : null;
    const id = (object.id as { object_id?: string } | undefined)?.object_id;
    const type = slug ? slugToType.get(slug) : undefined;
    if (type && typeof id === "string" && id) objectIdBySlug[type] = id;
  }
  return objectIdBySlug;
}

// Mints the webhook that feeds ingestion. Record events are filtered to the
// standard CRM objects at the Attio side; note events filter on the parent
// object. The secret is only returned at creation, so it is persisted in the
// api_key credential payload.
export async function createGoatAttioWebhook(input: {
  apiKey: string;
  targetUrl: string;
  objectIds: readonly string[];
}): Promise<{ webhookId: string; secret: string }> {
  if (input.objectIds.length === 0) {
    throw new Error("No Attio standard objects resolved for the webhook subscription.");
  }
  const recordFilter = {
    $or: input.objectIds.map((objectId) => ({
      field: "id.object_id",
      operator: "equals",
      value: objectId,
    })),
  };
  const noteFilter = {
    $or: input.objectIds.map((objectId) => ({
      field: "parent_object_id",
      operator: "equals",
      value: objectId,
    })),
  };
  const response = (await requestGoatAttioApi({
    apiKey: input.apiKey,
    path: "/webhooks",
    method: "POST",
    body: {
      data: {
        target_url: input.targetUrl,
        subscriptions: [
          ...ATTIO_RECORD_EVENT_TYPES.map((eventType) => ({
            event_type: eventType,
            filter: recordFilter,
          })),
          { event_type: ATTIO_NOTE_EVENT_TYPE, filter: noteFilter },
        ],
      },
    },
  })) as {
    data?: { id?: { webhook_id?: string }; secret?: string };
  } | null;
  const webhookId = response?.data?.id?.webhook_id;
  const secret = response?.data?.secret;
  if (typeof webhookId !== "string" || !webhookId || typeof secret !== "string" || !secret) {
    throw new Error("Attio webhook creation returned no webhook id or secret.");
  }
  return { webhookId, secret };
}

// Best-effort cleanup; a webhook left behind in Attio delivers to a receiver
// that no longer recognizes its id and gets 401s until Attio disables it.
export async function deleteGoatAttioWebhook(input: {
  apiKey: string;
  webhookId: string;
}): Promise<boolean> {
  try {
    await requestGoatAttioApi({
      apiKey: input.apiKey,
      path: `/webhooks/${encodeURIComponent(input.webhookId)}`,
      method: "DELETE",
    });
    return true;
  } catch {
    return false;
  }
}

export async function connectGoatAttioIntegration(input: {
  userWorkosId: string;
  apiKey: string;
  identity: GoatAttioWorkspaceIdentity;
  now?: Date;
}): Promise<{ integrationId: string }> {
  const db = getDb();
  const now = input.now ?? new Date();
  const connectionLabel = input.identity.workspaceName?.trim() || "Attio";

  const [integration] = await db
    .insert(goatIntegrations)
    .values({
      id: newGoatIntegrationId(),
      userWorkosId: input.userWorkosId,
      provider: GOAT_ATTIO_PROVIDER,
      // The Attio workspace id is the routing key for inbound webhooks.
      externalId: input.identity.workspaceId,
      connectionLabel,
      accountName: input.identity.workspaceSlug,
      accountEmail: null,
      accountType: "attio_api_key",
      status: "connected",
      statusReason: null,
      scopes: input.identity.scopes,
      lastSyncedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        goatIntegrations.userWorkosId,
        goatIntegrations.provider,
        goatIntegrations.externalId,
      ],
      // The personal-uniqueness index is partial; the arbiter must match it.
      targetWhere: sql`${goatIntegrations.workspaceId} IS NULL`,
      set: {
        connectionLabel,
        accountName: input.identity.workspaceSlug,
        accountType: "attio_api_key",
        status: "connected",
        statusReason: null,
        scopes: input.identity.scopes,
        lastSyncedAt: now,
        updatedAt: now,
      },
    })
    .returning({ id: goatIntegrations.id });

  if (!integration) {
    throw new Error("Could not persist Goat Attio integration.");
  }

  // A reconnect replaces the webhook rather than reusing it: the secret is
  // only readable at creation, so a fresh webhook is the only way to be sure
  // the stored secret matches the live one.
  const existing = await loadGoatIntegrationCredential({
    userWorkosId: input.userWorkosId,
    integrationId: integration.id,
    provider: GOAT_ATTIO_PROVIDER,
    kind: GOAT_ATTIO_CREDENTIAL_KIND,
    db,
  }).catch(() => null);
  const existingPayload = existing?.payload as GoatAttioApiKeyCredentialPayload | undefined;
  if (existingPayload?.webhookId) {
    await deleteGoatAttioWebhook({ apiKey: input.apiKey, webhookId: existingPayload.webhookId });
  }

  let payload: GoatAttioApiKeyCredentialPayload;
  try {
    const objectIdBySlug = await fetchGoatAttioObjectIds(input.apiKey);
    const objectIds = Object.values(objectIdBySlug).filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    const webhook = await createGoatAttioWebhook({
      apiKey: input.apiKey,
      targetUrl: `${getGoatAppUrl()}/api/webhooks/attio/events`,
      objectIds,
    });
    payload = {
      apiKey: input.apiKey,
      workspaceId: input.identity.workspaceId,
      webhookId: webhook.webhookId,
      webhookSecret: webhook.secret,
      objectIdBySlug,
      createdAt: now.toISOString(),
    };
  } catch (error) {
    await markGoatIntegrationStatus({
      userWorkosId: input.userWorkosId,
      integrationId: integration.id,
      provider: GOAT_ATTIO_PROVIDER,
      status: "sync_failed",
      statusReason: "Failed to register the Attio webhook.",
      db,
      now: new Date(),
    });
    throw error;
  }

  try {
    await saveGoatIntegrationCredential({
      userWorkosId: input.userWorkosId,
      integrationId: integration.id,
      provider: GOAT_ATTIO_PROVIDER,
      kind: GOAT_ATTIO_CREDENTIAL_KIND,
      payload,
      // Attio workspace API keys do not expire; users revoke them in Attio.
      expiresAt: null,
      db,
      now,
    });
  } catch (error) {
    await deleteGoatAttioWebhook({ apiKey: input.apiKey, webhookId: payload.webhookId ?? "" });
    await markGoatIntegrationStatus({
      userWorkosId: input.userWorkosId,
      integrationId: integration.id,
      provider: GOAT_ATTIO_PROVIDER,
      status: "sync_failed",
      statusReason: "Failed to persist Attio integration credentials.",
      db,
      now: new Date(),
    });
    throw error;
  }

  await captureGoatIntegrationAddedAnalytics({
    userWorkosId: input.userWorkosId,
    provider: "attio",
  });

  return { integrationId: integration.id };
}

export async function getGoatAttioIntegrationState(
  userWorkosId: string,
): Promise<GoatAttioProviderState> {
  const [row] = await getDb()
    .select({
      id: goatIntegrations.id,
      status: goatIntegrations.status,
      connectionLabel: goatIntegrations.connectionLabel,
      statusReason: goatIntegrations.statusReason,
    })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.userWorkosId, userWorkosId),
        eq(goatIntegrations.provider, GOAT_ATTIO_PROVIDER),
        ne(goatIntegrations.status, "disconnected"),
      ),
    )
    .orderBy(desc(goatIntegrations.updatedAt))
    .limit(1);

  if (!row) {
    return {
      provider: "attio",
      connected: false,
      status: "not_connected",
      integrationId: null,
      workspaceName: null,
      statusReason: null,
    };
  }

  return {
    provider: "attio",
    connected: row.status === "connected",
    status: row.status,
    integrationId: row.id,
    workspaceName: row.connectionLabel,
    statusReason: row.statusReason,
  };
}

export async function requestGoatAttioApi(input: {
  apiKey: string;
  path: string;
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
}): Promise<unknown> {
  const method = input.method ?? "GET";
  const response = await fetch(`${GOAT_ATTIO_API_BASE_URL}${input.path}`, {
    method,
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      Accept: "application/json",
      ...(input.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    // Main-chat actions pass their shared abort/timeout signal. Connection
    // setup keeps the integration client's existing bounded timeout.
    signal: input.signal ?? AbortSignal.timeout(ATTIO_API_TIMEOUT_MS),
    ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
  });
  if (!response.ok) {
    throw new GoatAttioApiRequestError(response.status, method, input.path);
  }
  if (response.status === 204) return null;
  return await response.json().catch(() => null);
}

function newGoatIntegrationId() {
  return `gint_${randomUUID().replace(/-/g, "")}`;
}
