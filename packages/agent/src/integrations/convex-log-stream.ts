import { randomUUID } from "node:crypto";
import { getDb } from "@opencompany/db/client";
import {
  CONVEX_EVENTS_ACCOUNT_TYPE,
  CONVEX_EVENTS_CREDENTIAL_KIND,
  CONVEX_EVENTS_EXTERNAL_ID,
  CONVEX_PROVIDER,
} from "@opencompany/db/convex-events";
import {
  disconnectPersonalIntegration,
  loadIntegrationCredential,
  markIntegrationStatus,
  saveIntegrationCredential,
} from "@opencompany/db/integrations";
import { integrations } from "@opencompany/db/product-schema";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { getAppUrl } from "../app-url";
import type { ConvexEventsProviderState } from "../integration-state";
import { captureConnectionAddedAnalytics } from "./analytics";
import { loadConvexCredential, loadConvexIntegration } from "./convex-mcp";
import { parseConvexDeployKey } from "./convex-policy";

// Follows the repo-wide injectable-db convention so the canonical API can pass its pooled handle
// while web callers keep the getDb() default.
type DbLike = any;

// Only the topics opencompany acts on. Convex bills log stream egress, and every other topic —
// console lines, per-minute concurrency and storage stats — would be paid for and dropped.
const CONVEX_LOG_STREAM_TOPICS = ["verification", "function_execution"] as const;
const CONVEX_DEPLOYMENT_API_TIMEOUT_MS = 15_000;

export type ConvexLogStreamCredentialPayload = {
  webhookSecret: string;
  logStreamId: string;
  deployment: string;
  createdAt: string;
};

export class ConvexLogStreamError extends Error {}

// Convex routes a webhook log stream to one fixed URL, so each connection publishes its own and
// the id in that path is what routes a delivery back to it.
export function convexEventsWebhookUrl(integrationId: string) {
  return `${getAppUrl()}/api/webhooks/convex/${integrationId}`;
}

// Provisioning is one call because the deploy key the Convex plugin already holds is also what the
// Convex deployment API accepts: opencompany creates the log stream, and Convex hands back the
// HMAC secret it will sign deliveries with. Nothing is copied by hand in either direction.
export async function enableConvexErrorEvents(input: {
  userWorkosId: string;
  now?: Date;
  db?: DbLike;
}): Promise<{ integrationId: string }> {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();

  const mcpRow = await loadConvexIntegration(db, input.userWorkosId);
  if (!mcpRow || mcpRow.status !== "connected") {
    throw new ConvexLogStreamError("Save a Convex deploy key before turning on error events.");
  }
  const credential = await loadConvexCredential(input.userWorkosId, mcpRow.id, db);
  if (!credential) {
    throw new ConvexLogStreamError("Save a Convex deploy key before turning on error events.");
  }
  const deployment = parseConvexDeployKey(credential.apiKey);
  if (!deployment) {
    throw new ConvexLogStreamError(
      "The stored Convex deploy key is no longer usable. Save a new one.",
    );
  }

  // The row has to exist before the log stream can point at it, and it stays `needs_reauth` until
  // the secret lands, so a half-finished setup can never bind an event trigger.
  const integrationId = await ensureConvexEventsRow({
    userWorkosId: input.userWorkosId,
    deployment: deployment.name,
    now,
    db,
  });
  const url = convexEventsWebhookUrl(integrationId);

  const existing = await findWebhookLogStream(deployment.name, credential.apiKey);
  const stream =
    existing?.url === url
      ? // Re-running setup adopts the stream already pointed here rather than tripping Convex's
        // one-webhook-stream-per-deployment rule against opencompany's own stream.
        await updateWebhookLogStream(deployment.name, credential.apiKey, existing.id, url)
      : existing
        ? (() => {
            throw new ConvexLogStreamError(
              `Convex allows one webhook log stream per deployment and ${deployment.name} already streams to ${existing.url}. Remove that stream in Convex, or point it at opencompany, and try again.`,
            );
          })()
        : await createWebhookLogStream(deployment.name, credential.apiKey, url);

  await saveIntegrationCredential({
    userWorkosId: input.userWorkosId,
    integrationId,
    provider: CONVEX_PROVIDER,
    kind: CONVEX_EVENTS_CREDENTIAL_KIND,
    payload: {
      webhookSecret: stream.hmacSecret,
      logStreamId: stream.id,
      deployment: deployment.name,
      createdAt: now.toISOString(),
    } satisfies ConvexLogStreamCredentialPayload,
    db,
    now,
  });

  // Only after the secret is durable, so a failed write never leaves a connection that routes
  // deliveries it cannot authenticate.
  await markIntegrationStatus({
    userWorkosId: input.userWorkosId,
    integrationId,
    provider: CONVEX_PROVIDER,
    status: "connected",
    statusReason: null,
    db,
    now,
  });

  await captureConnectionAddedAnalytics({
    connectionId: integrationId,
    userWorkosId: input.userWorkosId,
    provider: CONVEX_PROVIDER,
  });
  return { integrationId };
}

// Deleting the stream in Convex is the point of having a dedicated disconnect: a forgotten stream
// keeps POSTing to an endpoint that can only answer 401, and Convex bills its owner for the
// egress. The row is removed only once Convex has stopped sending.
export async function disableConvexErrorEvents(input: {
  userWorkosId: string;
  db?: DbLike;
}): Promise<void> {
  const db = input.db ?? getDb();
  const row = await findConvexEventsRow(input.userWorkosId, db);
  if (!row) return;

  const stored = await loadConvexLogStream({
    userWorkosId: input.userWorkosId,
    integrationId: row.id,
    db,
  });
  const mcpRow = await loadConvexIntegration(db, input.userWorkosId);
  const credential = mcpRow ? await loadConvexCredential(input.userWorkosId, mcpRow.id, db) : null;
  if (stored && credential) {
    await deleteLogStream(stored.deployment, credential.apiKey, stored.logStreamId);
  } else if (stored) {
    throw new ConvexLogStreamError(
      "opencompany needs the Convex deploy key to stop the log stream. Save the deploy key again, then turn error events off.",
    );
  }

  await disconnectPersonalIntegration({
    userWorkosId: input.userWorkosId,
    integrationId: row.id,
    db,
  });
}

export async function loadConvexLogStream(input: {
  userWorkosId: string;
  integrationId: string;
  db?: DbLike;
}): Promise<ConvexLogStreamCredentialPayload | null> {
  const credential = await loadIntegrationCredential({
    userWorkosId: input.userWorkosId,
    integrationId: input.integrationId,
    provider: CONVEX_PROVIDER,
    kind: CONVEX_EVENTS_CREDENTIAL_KIND,
    ...(input.db ? { db: input.db } : {}),
  });
  const payload = credential?.payload;
  const webhookSecret = payload?.webhookSecret;
  const logStreamId = payload?.logStreamId;
  const deployment = payload?.deployment;
  const createdAt = payload?.createdAt;
  if (
    typeof webhookSecret !== "string" ||
    !webhookSecret ||
    typeof logStreamId !== "string" ||
    !logStreamId ||
    typeof deployment !== "string" ||
    !deployment
  ) {
    return null;
  }
  return {
    webhookSecret,
    logStreamId,
    deployment,
    createdAt: typeof createdAt === "string" ? createdAt : "",
  };
}

export async function loadConvexWebhookSecret(input: {
  userWorkosId: string;
  integrationId: string;
  db?: DbLike;
}): Promise<string | null> {
  return (await loadConvexLogStream(input))?.webhookSecret ?? null;
}

export async function getConvexEventsIntegrationState(
  userWorkosId: string,
  db: DbLike = getDb(),
): Promise<ConvexEventsProviderState> {
  const row = await findConvexEventsRow(userWorkosId, db);
  if (!row) {
    return {
      provider: CONVEX_PROVIDER,
      connected: false,
      status: "not_connected",
      integrationId: null,
      statusReason: null,
      deployment: null,
      webhookUrl: null,
      lastDeliveryAt: null,
    };
  }
  return {
    provider: CONVEX_PROVIDER,
    connected: row.status === "connected",
    status: row.status,
    integrationId: row.id,
    statusReason: row.statusReason,
    deployment: row.accountName,
    webhookUrl: convexEventsWebhookUrl(row.id),
    lastDeliveryAt: toIsoString(row.lastSyncedAt),
  };
}

// One Convex event connection per user, matching the one deployment the plugin's deploy key names.
// Convex's MCP connector shares provider "convex"; the account type keeps the two apart.
async function findConvexEventsRow(userWorkosId: string, db: DbLike) {
  const [row] = await db
    .select({
      id: integrations.id,
      status: integrations.status,
      statusReason: integrations.statusReason,
      accountName: integrations.accountName,
      lastSyncedAt: integrations.lastSyncedAt,
    })
    .from(integrations)
    .where(
      and(
        eq(integrations.userWorkosId, userWorkosId),
        eq(integrations.provider, CONVEX_PROVIDER),
        eq(integrations.accountType, CONVEX_EVENTS_ACCOUNT_TYPE),
        isNull(integrations.workspaceId),
        ne(integrations.status, "disconnected"),
      ),
    )
    .orderBy(desc(integrations.updatedAt))
    .limit(1);
  return row ?? null;
}

async function ensureConvexEventsRow(input: {
  userWorkosId: string;
  deployment: string;
  now: Date;
  db: DbLike;
}) {
  const existing = await findConvexEventsRow(input.userWorkosId, input.db);
  if (existing) return existing.id as string;

  const integrationId = `gint_${randomUUID().replace(/-/gu, "")}`;
  const [integration] = await input.db
    .insert(integrations)
    .values({
      id: integrationId,
      userWorkosId: input.userWorkosId,
      provider: CONVEX_PROVIDER,
      externalId: `${CONVEX_EVENTS_EXTERNAL_ID}:${integrationId}`,
      connectionLabel: `${input.deployment} errors`,
      accountName: input.deployment,
      accountType: CONVEX_EVENTS_ACCOUNT_TYPE,
      status: "needs_reauth" as const,
      statusReason: "Convex has not confirmed the log stream yet.",
      scopes: [] as string[],
      updatedAt: input.now,
    })
    .returning({ id: integrations.id });
  if (!integration) throw new ConvexLogStreamError("Could not create the Convex event endpoint.");
  return integration.id as string;
}

type ConvexWebhookLogStream = { id: string; url: string };

async function findWebhookLogStream(
  deployment: string,
  apiKey: string,
): Promise<ConvexWebhookLogStream | null> {
  const streams = await convexDeploymentRequest<unknown>({
    deployment,
    apiKey,
    method: "GET",
    path: "/list_log_streams",
    intent: "list the deployment's log streams",
  });
  if (!Array.isArray(streams)) return null;
  for (const entry of streams) {
    const stream = asRecord(entry);
    if (stream?.logStreamType !== "webhook") continue;
    const id = asNonEmptyString(stream.id);
    const url = asNonEmptyString(stream.url);
    if (id && url) return { id, url };
  }
  return null;
}

async function createWebhookLogStream(deployment: string, apiKey: string, url: string) {
  const response = await convexDeploymentRequest<unknown>({
    deployment,
    apiKey,
    method: "POST",
    path: "/create_log_stream",
    body: { logStreamType: "webhook", format: "json", url, topics: CONVEX_LOG_STREAM_TOPICS },
    intent: "create the webhook log stream",
  });
  return readWebhookLogStreamSecret(response);
}

async function updateWebhookLogStream(
  deployment: string,
  apiKey: string,
  logStreamId: string,
  url: string,
) {
  // Convex's update response does not return the secret, so the secret is rotated instead: an
  // adopted stream was configured by an earlier setup whose secret opencompany may no longer hold,
  // and rotating is the only way to be certain the stored one is the one Convex signs with.
  await convexDeploymentRequest<unknown>({
    deployment,
    apiKey,
    method: "POST",
    path: `/update_log_stream/${encodeURIComponent(logStreamId)}`,
    body: { logStreamType: "webhook", format: "json", url, topics: CONVEX_LOG_STREAM_TOPICS },
    intent: "update the webhook log stream",
  });
  const rotated = await convexDeploymentRequest<unknown>({
    deployment,
    apiKey,
    method: "POST",
    path: `/rotate_webhook_secret/${encodeURIComponent(logStreamId)}`,
    intent: "rotate the webhook log stream secret",
  });
  const secret = asNonEmptyString(asRecord(rotated)?.hmacSecret);
  if (!secret) {
    throw new ConvexLogStreamError("Convex did not return a signing secret for the log stream.");
  }
  return { id: logStreamId, hmacSecret: secret };
}

async function deleteLogStream(deployment: string, apiKey: string, logStreamId: string) {
  await convexDeploymentRequest<unknown>({
    deployment,
    apiKey,
    method: "POST",
    path: `/delete_log_stream/${encodeURIComponent(logStreamId)}`,
    intent: "remove the webhook log stream",
    // A stream the user already deleted in Convex is the state this call was trying to reach.
    allowNotFound: true,
  });
}

function readWebhookLogStreamSecret(response: unknown) {
  const record = asRecord(response);
  const id = asNonEmptyString(record?.id);
  const hmacSecret = asNonEmptyString(record?.hmacSecret);
  if (!id || !hmacSecret) {
    throw new ConvexLogStreamError("Convex did not return a signing secret for the log stream.");
  }
  return { id, hmacSecret };
}

async function convexDeploymentRequest<T>(input: {
  deployment: string;
  apiKey: string;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  intent: string;
  allowNotFound?: boolean;
}): Promise<T | null> {
  let response: Response;
  try {
    response = await fetch(`https://${input.deployment}.convex.cloud/api/v1${input.path}`, {
      method: input.method,
      headers: {
        Authorization: `Convex ${input.apiKey}`,
        ...(input.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      signal: AbortSignal.timeout(CONVEX_DEPLOYMENT_API_TIMEOUT_MS),
    });
  } catch {
    throw new ConvexLogStreamError(`Convex could not be reached to ${input.intent}. Try again.`);
  }
  if (response.status === 404 && input.allowNotFound) return null;
  if (!response.ok) throw convexDeploymentError(response, await safeText(response), input.intent);
  if (response.status === 204) return null;
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

// Convex answers failures with `{code, message}`. The message is first-party and specific — it
// names the missing permission or the plan requirement — so it is worth showing, bounded and
// prefixed so it is clear who said it.
function convexDeploymentError(response: Response, body: string, intent: string) {
  const message = asNonEmptyString(asRecord(safeJson(body))?.message)?.slice(0, 300);
  if (response.status === 401 || response.status === 403) {
    return new ConvexLogStreamError(
      `Convex denied the request to ${intent}. Generate a deploy key with deployment:integrations:write in Convex deployment settings and save it on this page.${message ? ` Convex said: ${message}` : ""}`,
    );
  }
  if (response.status === 402) {
    return new ConvexLogStreamError(
      "Convex log streams require a Convex Pro plan. Upgrade the deployment's team and try again.",
    );
  }
  return new ConvexLogStreamError(
    `Convex could not ${intent}.${message ? ` Convex said: ${message}` : ` It answered ${response.status}.`}`,
  );
}

async function safeText(response: Response) {
  try {
    return (await response.text()).slice(0, 2_000);
  } catch {
    return "";
  }
}

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function toIsoString(value: Date | string | null | undefined) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
