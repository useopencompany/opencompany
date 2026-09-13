import { randomUUID } from "node:crypto";
import { getDb } from "@opencompany/db/client";
import {
  JAMIE_EVENTS_ACCOUNT_TYPE,
  JAMIE_PROVIDER,
  jamieWebhookKeyExternalId,
} from "@opencompany/db/jamie";
import { integrations } from "@opencompany/db/product-schema";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { getAppUrl } from "../app-url";
import type { JamieEventsProviderState } from "../integration-state";
import { captureConnectionAddedAnalytics } from "./analytics";

// Follows the repo-wide injectable-db convention so the canonical API can pass its pooled handle
// while web callers keep the getDb() default.
type DbLike = any;

// Jamie has no webhook-management API: the user creates the endpoint in Jamie's own settings and
// Jamie mints the key there. The connection is therefore the key itself, and the only thing
// opencompany has to publish is one fixed URL that every Jamie webhook can point at.
export function jamieEventsWebhookUrl() {
  return `${getAppUrl()}/api/webhooks/jamie/events`;
}

// Jamie shows the key once, as `sk_` followed by an opaque token.
export function isValidJamieWebhookApiKey(apiKey: string) {
  return /^sk_[A-Za-z0-9_-]{10,200}$/.test(apiKey);
}

// One Jamie event connection per user. Rotating the key in Jamie replaces the digest on the same
// row, so a workflow already bound to this connection keeps firing without being re-pointed.
export async function connectJamieEventsIntegration(input: {
  userWorkosId: string;
  apiKey: string;
  now?: Date;
  db?: DbLike;
}): Promise<{ integrationId: string }> {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const values = {
    externalId: jamieWebhookKeyExternalId(input.apiKey),
    connectionLabel: "Jamie meetings",
    accountName: "Jamie meetings",
    accountType: JAMIE_EVENTS_ACCOUNT_TYPE,
    status: "connected" as const,
    statusReason: null,
    scopes: [] as string[],
    updatedAt: now,
  };

  const [existing] = await db
    .select({ id: integrations.id })
    .from(integrations)
    .where(jamieEventsRowFilter(input.userWorkosId))
    .orderBy(desc(integrations.updatedAt))
    .limit(1);

  const [integration] = existing
    ? await db
        .update(integrations)
        .set(values)
        .where(eq(integrations.id, existing.id))
        .returning({ id: integrations.id })
    : await db
        .insert(integrations)
        .values({
          id: `gint_${randomUUID().replace(/-/g, "")}`,
          userWorkosId: input.userWorkosId,
          provider: JAMIE_PROVIDER,
          ...values,
        })
        .returning({ id: integrations.id });

  if (!integration) throw new Error("Could not persist the opencompany Jamie event connection.");
  if (!existing) {
    await captureConnectionAddedAnalytics({
      connectionId: integration.id,
      userWorkosId: input.userWorkosId,
      provider: JAMIE_PROVIDER,
    });
  }
  return { integrationId: integration.id };
}

export async function getJamieEventsIntegrationState(
  userWorkosId: string,
  db: DbLike = getDb(),
): Promise<JamieEventsProviderState> {
  const [row] = await db
    .select({
      id: integrations.id,
      status: integrations.status,
      statusReason: integrations.statusReason,
      lastSyncedAt: integrations.lastSyncedAt,
    })
    .from(integrations)
    .where(and(jamieEventsRowFilter(userWorkosId), ne(integrations.status, "disconnected")))
    .orderBy(desc(integrations.updatedAt))
    .limit(1);

  if (!row) {
    return {
      provider: JAMIE_PROVIDER,
      connected: false,
      status: "not_connected",
      integrationId: null,
      statusReason: null,
      webhookUrl: jamieEventsWebhookUrl(),
      lastDeliveryAt: null,
    };
  }

  return {
    provider: JAMIE_PROVIDER,
    connected: row.status === "connected",
    status: row.status,
    integrationId: row.id,
    statusReason: row.statusReason,
    webhookUrl: jamieEventsWebhookUrl(),
    lastDeliveryAt: toIsoString(row.lastSyncedAt),
  };
}

// Jamie's MCP connector shares provider "jamie"; the account type keeps the two apart without
// depending on the MCP row's sentinel external id.
function jamieEventsRowFilter(userWorkosId: string) {
  return and(
    eq(integrations.userWorkosId, userWorkosId),
    eq(integrations.provider, JAMIE_PROVIDER),
    eq(integrations.accountType, JAMIE_EVENTS_ACCOUNT_TYPE),
    isNull(integrations.workspaceId),
  );
}

function toIsoString(value: Date | string | null | undefined) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
