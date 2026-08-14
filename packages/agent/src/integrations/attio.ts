import { randomUUID } from "node:crypto";
import {
  ATTIO_CREDENTIAL_KIND,
  ATTIO_OBJECT_SLUGS,
  ATTIO_PROVIDER,
  type AttioApiKeyCredentialPayload,
} from "@opencompany/db/attio";
import { getDb } from "@opencompany/db/client";
import {
  loadIntegrationCredential,
  markIntegrationStatus,
  saveIntegrationCredential,
} from "@opencompany/db/integrations";
import { type AttioObjectType, integrations } from "@opencompany/db/product-schema";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { getAppUrl } from "../app-url";
import type { AttioProviderState } from "../integration-state";
import { captureIntegrationAddedAnalytics } from "./analytics";

export const ATTIO_API_BASE_URL = "https://api.attio.com/v2";

// Follows the repo-wide injectable-db convention so the canonical API can pass
// its pooled handle while web/runner callers keep the getDb() default.
type DbLike = any;

const ATTIO_API_TIMEOUT_MS = 15_000;
const MAX_ATTIO_ERROR_DETAIL_CHARS = 200;

export class AttioApiRequestError extends Error {
  readonly status: number;
  readonly detail: string | undefined;

  constructor(status: number, method: string, path: string, detail?: string) {
    super(`Attio API ${method} ${path} failed (${status}).`);
    this.name = "AttioApiRequestError";
    this.status = status;
    this.detail = detail;
  }
}

// The webhook subscriptions the connection needs: record lifecycle on the
// standard CRM objects plus notes attached to them. Everything else (lists,
// comments, tasks) stays out of scope for ingestion.
const ATTIO_RECORD_EVENT_TYPES = ["record.created", "record.updated"] as const;
const ATTIO_NOTE_EVENT_TYPE = "note.created";

export type AttioWorkspaceIdentity = {
  workspaceId: string;
  workspaceName: string | null;
  workspaceSlug: string | null;
  authorizedByWorkspaceMemberId: string | null;
  scopes: string[];
};

export function parseAttioScopes(value: unknown): string[] {
  const values = (Array.isArray(value) ? value : [value]).flatMap((entry) =>
    typeof entry === "string" ? entry.split(/\s+/) : [],
  );
  return [...new Set(values.map((scope) => scope.trim()).filter(Boolean))].sort();
}

export function hasAttioListReadScopes(scopes: readonly string[]) {
  const canReadListConfiguration =
    scopes.includes("list_configuration:read") || scopes.includes("list_configuration:read-write");
  const canReadListEntries =
    scopes.includes("list_entry:read") || scopes.includes("list_entry:read-write");
  return canReadListConfiguration && canReadListEntries;
}

export function hasAttioRecordReadScopes(scopes: readonly string[]) {
  const canReadObjectConfiguration =
    scopes.includes("object_configuration:read") ||
    scopes.includes("object_configuration:read-write");
  const canReadRecords =
    scopes.includes("record_permission:read") || scopes.includes("record_permission:read-write");
  return canReadObjectConfiguration && canReadRecords;
}

export function hasAttioRecordWriteScopes(scopes: readonly string[]) {
  const canReadObjectConfiguration =
    scopes.includes("object_configuration:read") ||
    scopes.includes("object_configuration:read-write");
  return canReadObjectConfiguration && scopes.includes("record_permission:read-write");
}

export function hasAttioListWriteScopes(scopes: readonly string[]) {
  const canReadListConfiguration =
    scopes.includes("list_configuration:read") || scopes.includes("list_configuration:read-write");
  return canReadListConfiguration && scopes.includes("list_entry:read-write");
}

export function hasAttioListConfigurationWriteScope(scopes: readonly string[]) {
  return scopes.includes("list_configuration:read-write");
}

export function hasAttioRecordCommentWriteScopes(scopes: readonly string[]) {
  return scopes.includes("comment:read-write") && hasAttioRecordReadScopes(scopes);
}

export function hasAttioListCommentWriteScopes(scopes: readonly string[]) {
  return scopes.includes("comment:read-write") && hasAttioListReadScopes(scopes);
}

export function hasAttioCommentWriteScopes(scopes: readonly string[]) {
  return (
    scopes.includes("comment:read-write") &&
    (hasAttioRecordReadScopes(scopes) || hasAttioListReadScopes(scopes))
  );
}

// Attio publishes no key format; only reject strings that are clearly not a
// pasted key (whitespace, absurd lengths) and let the API call be the judge.
export function isValidAttioApiKey(apiKey: string) {
  return /^\S{16,2000}$/.test(apiKey);
}

export type AttioApiKeyValidation =
  | { ok: true; identity: AttioWorkspaceIdentity }
  | { ok: false; error: string };

// GET /v2/self identifies the workspace the key is scoped to and doubles as
// the liveness check.
export async function validateAttioApiKey(apiKey: string): Promise<AttioApiKeyValidation> {
  let response: Response;
  try {
    response = await fetch(`${ATTIO_API_BASE_URL}/self`, {
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
    authorized_by_workspace_member_id?: string;
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
      authorizedByWorkspaceMemberId:
        typeof body.authorized_by_workspace_member_id === "string" &&
        body.authorized_by_workspace_member_id
          ? body.authorized_by_workspace_member_id
          : null,
      scopes: parseAttioScopes(body.scope),
    },
  };
}

// Resolves the workspace's object UUIDs for our standard object types. Events
// reference objects by UUID, so the webhook receiver needs this map to route
// without an API call.
export async function fetchAttioObjectIds(
  apiKey: string,
): Promise<Partial<Record<AttioObjectType, string>>> {
  const response = await requestAttioApi({ apiKey, path: "/objects" });
  const objects = (response as { data?: Array<Record<string, unknown>> })?.data ?? [];
  const slugToType = new Map(
    (Object.entries(ATTIO_OBJECT_SLUGS) as [AttioObjectType, string][]).map(([type, slug]) => [
      slug,
      type,
    ]),
  );
  const objectIdBySlug: Partial<Record<AttioObjectType, string>> = {};
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
export async function createAttioWebhook(input: {
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
  const response = (await requestAttioApi({
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
export async function deleteAttioWebhook(input: {
  apiKey: string;
  webhookId: string;
}): Promise<boolean> {
  try {
    await requestAttioApi({
      apiKey: input.apiKey,
      path: `/webhooks/${encodeURIComponent(input.webhookId)}`,
      method: "DELETE",
    });
    return true;
  } catch {
    return false;
  }
}

export async function connectAttioIntegration(input: {
  userWorkosId: string;
  apiKey: string;
  identity: AttioWorkspaceIdentity;
  now?: Date;
  db?: DbLike;
}): Promise<{ integrationId: string }> {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const connectionLabel = input.identity.workspaceName?.trim() || "Attio";

  const [integration] = await db
    .insert(integrations)
    .values({
      id: newIntegrationId(),
      userWorkosId: input.userWorkosId,
      provider: ATTIO_PROVIDER,
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
      target: [integrations.userWorkosId, integrations.provider, integrations.externalId],
      // The personal-uniqueness index is partial; the arbiter must match it.
      targetWhere: sql`${integrations.workspaceId} IS NULL`,
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
    .returning({ id: integrations.id });

  if (!integration) {
    throw new Error("Could not persist opencompany Attio integration.");
  }

  // A reconnect replaces the webhook rather than reusing it: the secret is
  // only readable at creation, so a fresh webhook is the only way to be sure
  // the stored secret matches the live one.
  const existing = await loadIntegrationCredential({
    userWorkosId: input.userWorkosId,
    integrationId: integration.id,
    provider: ATTIO_PROVIDER,
    kind: ATTIO_CREDENTIAL_KIND,
    db,
  }).catch(() => null);
  const existingPayload = existing?.payload as AttioApiKeyCredentialPayload | undefined;
  if (existingPayload?.webhookId) {
    await deleteAttioWebhook({ apiKey: input.apiKey, webhookId: existingPayload.webhookId });
  }

  let payload: AttioApiKeyCredentialPayload;
  try {
    const objectIdBySlug = await fetchAttioObjectIds(input.apiKey);
    const objectIds = Object.values(objectIdBySlug).filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    const webhook = await createAttioWebhook({
      apiKey: input.apiKey,
      targetUrl: `${getAppUrl()}/api/webhooks/attio/events`,
      objectIds,
    });
    payload = {
      apiKey: input.apiKey,
      workspaceId: input.identity.workspaceId,
      authorizedByWorkspaceMemberId: input.identity.authorizedByWorkspaceMemberId,
      webhookId: webhook.webhookId,
      webhookSecret: webhook.secret,
      objectIdBySlug,
      createdAt: now.toISOString(),
    };
  } catch (error) {
    await markIntegrationStatus({
      userWorkosId: input.userWorkosId,
      integrationId: integration.id,
      provider: ATTIO_PROVIDER,
      status: "sync_failed",
      statusReason: "Failed to register the Attio webhook.",
      db,
      now: new Date(),
    });
    throw error;
  }

  try {
    await saveIntegrationCredential({
      userWorkosId: input.userWorkosId,
      integrationId: integration.id,
      provider: ATTIO_PROVIDER,
      kind: ATTIO_CREDENTIAL_KIND,
      payload,
      // Attio workspace API keys do not expire; users revoke them in Attio.
      expiresAt: null,
      db,
      now,
    });
  } catch (error) {
    await deleteAttioWebhook({ apiKey: input.apiKey, webhookId: payload.webhookId ?? "" });
    await markIntegrationStatus({
      userWorkosId: input.userWorkosId,
      integrationId: integration.id,
      provider: ATTIO_PROVIDER,
      status: "sync_failed",
      statusReason: "Failed to persist Attio integration credentials.",
      db,
      now: new Date(),
    });
    throw error;
  }

  await captureIntegrationAddedAnalytics({
    userWorkosId: input.userWorkosId,
    provider: "attio",
  });

  return { integrationId: integration.id };
}

export async function getAttioIntegrationState(
  userWorkosId: string,
  db: DbLike = getDb(),
): Promise<AttioProviderState> {
  const [row] = await db
    .select({
      id: integrations.id,
      status: integrations.status,
      connectionLabel: integrations.connectionLabel,
      statusReason: integrations.statusReason,
    })
    .from(integrations)
    .where(
      and(
        eq(integrations.userWorkosId, userWorkosId),
        eq(integrations.provider, ATTIO_PROVIDER),
        ne(integrations.status, "disconnected"),
      ),
    )
    .orderBy(desc(integrations.updatedAt))
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

export async function requestAttioApi(input: {
  apiKey: string;
  path: string;
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
}): Promise<unknown> {
  const method = input.method ?? "GET";
  const response = await fetch(`${ATTIO_API_BASE_URL}${input.path}`, {
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
    const body = await response.text();
    throw new AttioApiRequestError(response.status, method, input.path, attioApiErrorDetail(body));
  }
  if (response.status === 204) return null;
  return await response.json().catch(() => null);
}

function attioApiErrorDetail(body: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const error = parsed as Record<string, unknown>;
  const message = boundedAttioErrorString(error.message);
  const code = boundedAttioErrorString(error.code);
  const detail = message ? `${message}${code && code !== message ? ` (${code})` : ""}` : code;
  if (!detail) return undefined;
  const normalized = detail.replace(/[.\s]+$/g, "");
  return normalized.length > MAX_ATTIO_ERROR_DETAIL_CHARS
    ? `${normalized.slice(0, MAX_ATTIO_ERROR_DETAIL_CHARS - 1)}…`
    : normalized;
}

function boundedAttioErrorString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > MAX_ATTIO_ERROR_DETAIL_CHARS
    ? `${normalized.slice(0, MAX_ATTIO_ERROR_DETAIL_CHARS - 1)}…`
    : normalized;
}

function newIntegrationId() {
  return `gint_${randomUUID().replace(/-/g, "")}`;
}
