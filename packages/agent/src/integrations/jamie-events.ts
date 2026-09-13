import { randomUUID } from "node:crypto";
import { getDb } from "@opencompany/db/client";
import {
  loadIntegrationCredential,
  markIntegrationStatus,
  saveIntegrationCredential,
} from "@opencompany/db/integrations";
import {
  JAMIE_EVENTS_ACCOUNT_TYPE,
  JAMIE_EVENTS_CREDENTIAL_KIND,
  JAMIE_PROVIDER,
} from "@opencompany/db/jamie";
import { integrations } from "@opencompany/db/product-schema";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { getAppUrl } from "../app-url";
import type { JamieEventsProviderState } from "../integration-state";
import { captureConnectionAddedAnalytics } from "./analytics";

// Follows the repo-wide injectable-db convention so the canonical API can pass its pooled handle
// while web callers keep the getDb() default.
type DbLike = any;

export type JamieWebhookSecretCredentialPayload = {
  webhookSecret: string;
  createdAt: string;
};

const JAMIE_EVENTS_SETUP_STATUS_REASON =
  "Add the webhook key Jamie showed when you created the endpoint.";

// Jamie has no webhook-management API: the user creates the endpoint in Jamie's own settings and
// pastes its URL there. Each connection therefore publishes its own URL, and the id in that path is
// what routes a delivery back to it.
export function jamieEventsWebhookUrl(integrationId: string) {
  return `${getAppUrl()}/api/webhooks/jamie/${integrationId}`;
}

// Jamie shows the key once, as `sk_` followed by an opaque token.
export function isValidJamieWebhookKey(secret: string) {
  return /^sk_[A-Za-z0-9_-]{10,200}$/.test(secret);
}

// The endpoint has to exist before the user can point Jamie at it, so this is the first half of the
// setup. It is idempotent: a second call returns the same endpoint rather than orphaning the URL
// the user may already have pasted into Jamie.
export async function ensureJamieEventsEndpoint(input: {
  userWorkosId: string;
  now?: Date;
  db?: DbLike;
}): Promise<{ integrationId: string }> {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const existing = await findJamieEventsRow(input.userWorkosId, db);
  if (existing) return { integrationId: existing.id };

  const integrationId = `gint_${randomUUID().replace(/-/g, "")}`;
  const [integration] = await db
    .insert(integrations)
    .values({
      id: integrationId,
      userWorkosId: input.userWorkosId,
      provider: JAMIE_PROVIDER,
      externalId: `jamie_webhook:${integrationId}`,
      connectionLabel: "Jamie meetings",
      accountName: "Jamie meetings",
      accountType: JAMIE_EVENTS_ACCOUNT_TYPE,
      // The endpoint alone receives nothing: an event trigger binds only to a connected row, and
      // the key is what connects it.
      status: "needs_reauth" as const,
      statusReason: JAMIE_EVENTS_SETUP_STATUS_REASON,
      scopes: [] as string[],
      updatedAt: now,
    })
    .returning({ id: integrations.id });

  if (!integration) throw new Error("Could not create the opencompany Jamie event endpoint.");
  return { integrationId: integration.id };
}

// The second half: Jamie mints the key when the webhook is created, so opencompany stores it the
// way it stores every other inbound webhook secret and compares it on each delivery.
export async function saveJamieWebhookKey(input: {
  userWorkosId: string;
  webhookSecret: string;
  now?: Date;
  db?: DbLike;
}): Promise<{ integrationId: string }> {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const { integrationId } = await ensureJamieEventsEndpoint({
    userWorkosId: input.userWorkosId,
    now,
    db,
  });
  const existing = await findJamieEventsRow(input.userWorkosId, db);

  await saveIntegrationCredential({
    userWorkosId: input.userWorkosId,
    integrationId,
    provider: JAMIE_PROVIDER,
    kind: JAMIE_EVENTS_CREDENTIAL_KIND,
    payload: {
      webhookSecret: input.webhookSecret,
      createdAt: now.toISOString(),
    } satisfies JamieWebhookSecretCredentialPayload,
    db,
    now,
  });

  // Only after the secret is durable, so a failed write never leaves a connection that routes
  // deliveries it cannot authenticate.
  await markIntegrationStatus({
    userWorkosId: input.userWorkosId,
    integrationId,
    provider: JAMIE_PROVIDER,
    status: "connected",
    statusReason: null,
    db,
    now,
  });

  if (existing?.status !== "connected") {
    await captureConnectionAddedAnalytics({
      connectionId: integrationId,
      userWorkosId: input.userWorkosId,
      provider: JAMIE_PROVIDER,
    });
  }
  return { integrationId };
}

export async function loadJamieWebhookSecret(input: {
  userWorkosId: string;
  integrationId: string;
  db?: DbLike;
}): Promise<string | null> {
  const credential = await loadIntegrationCredential({
    userWorkosId: input.userWorkosId,
    integrationId: input.integrationId,
    provider: JAMIE_PROVIDER,
    kind: JAMIE_EVENTS_CREDENTIAL_KIND,
    ...(input.db ? { db: input.db } : {}),
  });
  const secret = credential?.payload.webhookSecret;
  return typeof secret === "string" && secret ? secret : null;
}

export async function getJamieEventsIntegrationState(
  userWorkosId: string,
  db: DbLike = getDb(),
): Promise<JamieEventsProviderState> {
  const row = await findJamieEventsRow(userWorkosId, db);
  if (!row) {
    return {
      provider: JAMIE_PROVIDER,
      connected: false,
      status: "not_connected",
      integrationId: null,
      statusReason: null,
      webhookUrl: null,
      lastDeliveryAt: null,
    };
  }

  return {
    provider: JAMIE_PROVIDER,
    connected: row.status === "connected",
    status: row.status,
    integrationId: row.id,
    statusReason: row.statusReason,
    webhookUrl: jamieEventsWebhookUrl(row.id),
    lastDeliveryAt: toIsoString(row.lastSyncedAt),
  };
}

// One Jamie event connection per user. Jamie's MCP connector shares provider "jamie"; the account
// type keeps the two apart without depending on the MCP row's sentinel external id.
async function findJamieEventsRow(userWorkosId: string, db: DbLike) {
  const [row] = await db
    .select({
      id: integrations.id,
      status: integrations.status,
      statusReason: integrations.statusReason,
      lastSyncedAt: integrations.lastSyncedAt,
    })
    .from(integrations)
    .where(
      and(
        eq(integrations.userWorkosId, userWorkosId),
        eq(integrations.provider, JAMIE_PROVIDER),
        eq(integrations.accountType, JAMIE_EVENTS_ACCOUNT_TYPE),
        isNull(integrations.workspaceId),
        ne(integrations.status, "disconnected"),
      ),
    )
    .orderBy(desc(integrations.updatedAt))
    .limit(1);
  return row ?? null;
}

function toIsoString(value: Date | string | null | undefined) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
