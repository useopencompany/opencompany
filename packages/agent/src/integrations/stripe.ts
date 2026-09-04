import { randomUUID } from "node:crypto";
import { getDb } from "@opencompany/db/client";
import {
  loadIntegrationCredential,
  markIntegrationStatus,
  saveIntegrationCredential,
} from "@opencompany/db/integrations";
import { integrations } from "@opencompany/db/product-schema";
import { and, desc, eq, sql } from "drizzle-orm";
import type { StripeProviderState } from "../integration-state";
import { captureIntegrationAddedAnalytics } from "./analytics";
import { createRemoteMcpStaticBearerAuthProvider } from "./remote-mcp-static-bearer";

export const STRIPE_PROVIDER = "stripe" as const;
export const STRIPE_CREDENTIAL_KIND = "api_key" as const;
export const STRIPE_API_BASE_URL = "https://api.stripe.com/v1";
export const STRIPE_API_VERSION = "2026-04-22.dahlia";
export const STRIPE_MCP_ENDPOINT_URL = "https://mcp.stripe.com";

// Follows the repo-wide injectable-db convention so the canonical API can pass
// its pooled handle while web/runner callers keep the getDb() default.
type DbLike = any;

const STRIPE_API_TIMEOUT_MS = 15_000;
const MAX_STRIPE_ERROR_DETAIL_CHARS = 200;

export const STRIPE_REQUIRED_READ_PERMISSIONS = [
  "balance_read",
  "subscription_read",
  "invoice_read",
] as const;

export type StripeCredentialPayload = {
  apiKey: string;
  accountId: string;
  livemode: boolean;
  connectedAt: string;
};

export type StripeAccountIdentity = {
  accountId: string;
  accountName: string;
  accountEmail: string | null;
  country: string | null;
  livemode: boolean;
};

export type StripeConnection = {
  integrationId: string;
  userWorkosId: string;
  accountId: string;
  accountName: string;
  livemode: boolean;
  apiKey: string;
};

type StripeApiErrorPayload = {
  error?: {
    code?: string;
    message?: string;
    type?: string;
  };
};

export class StripeApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly detail: string | undefined;

  constructor(status: number, path: string, payload?: StripeApiErrorPayload | null) {
    super(`Stripe API GET ${path} failed (${status}).`);
    this.name = "StripeApiError";
    this.status = status;
    this.code = boundedStripeErrorString(payload?.error?.code);
    this.detail = boundedStripeErrorString(payload?.error?.message);
  }
}

export function isValidStripeRestrictedApiKey(apiKey: string) {
  return /^rk_(?:test|live)_[^\s]{16,500}$/.test(apiKey);
}

export function stripeKeyIsLive(apiKey: string) {
  return apiKey.startsWith("rk_live_");
}

export async function validateStripeRestrictedApiKey(
  apiKey: string,
): Promise<{ ok: true; identity: StripeAccountIdentity } | { ok: false; error: string }> {
  if (!isValidStripeRestrictedApiKey(apiKey)) {
    return {
      ok: false,
      error:
        "Use a restricted Stripe key beginning with rk_test_ or rk_live_. Unrestricted sk_ keys are not accepted.",
    };
  }

  let account: {
    id?: string;
    email?: string | null;
    country?: string | null;
    business_profile?: { name?: string | null };
    settings?: { dashboard?: { display_name?: string | null } };
  };
  try {
    account = await requestStripeApi({
      apiKey,
      path: "/account",
      signal: AbortSignal.timeout(STRIPE_API_TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, error: stripeValidationError(error, "Account") };
  }

  const accountId = account.id?.trim();
  if (!accountId?.startsWith("acct_")) {
    return { ok: false, error: "Stripe did not return a valid account for this restricted key." };
  }

  const permissionChecks = [
    { label: "Balance", path: "/balance" },
    {
      label: "Balance (including balance transactions)",
      path: "/balance_transactions",
      params: { limit: 1 },
    },
    {
      label: "Subscriptions",
      path: "/subscriptions",
      params: { limit: 1, status: "active" },
    },
    { label: "Invoices", path: "/invoices", params: { limit: 1, status: "open" } },
  ] as const;

  for (const check of permissionChecks) {
    try {
      await requestStripeApi({
        apiKey,
        path: check.path,
        ...("params" in check ? { params: check.params } : {}),
        signal: AbortSignal.timeout(STRIPE_API_TIMEOUT_MS),
      });
    } catch (error) {
      return { ok: false, error: stripeValidationError(error, check.label) };
    }
  }

  const accountName =
    cleanStripeLabel(account.business_profile?.name) ??
    cleanStripeLabel(account.settings?.dashboard?.display_name) ??
    cleanStripeLabel(account.email) ??
    accountId;

  return {
    ok: true,
    identity: {
      accountId,
      accountName,
      accountEmail: cleanStripeLabel(account.email),
      country: cleanStripeLabel(account.country),
      livemode: stripeKeyIsLive(apiKey),
    },
  };
}

export async function connectStripeIntegration(input: {
  userWorkosId: string;
  workspaceId: string;
  apiKey: string;
  identity: StripeAccountIdentity;
  now?: Date;
  db?: DbLike;
}): Promise<{ integrationId: string }> {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const values = {
    externalId: input.identity.accountId,
    connectionLabel: input.identity.accountName,
    accountName: input.identity.accountName,
    accountEmail: input.identity.accountEmail,
    accountType: input.identity.livemode
      ? "stripe_live_restricted_key"
      : "stripe_test_restricted_key",
    status: "connected" as const,
    statusReason: null,
    scopes: [...STRIPE_REQUIRED_READ_PERMISSIONS],
    lastSyncedAt: now,
    updatedAt: now,
  };

  const [integration] = await db
    .insert(integrations)
    .values({
      id: newStripeIntegrationId(),
      userWorkosId: input.userWorkosId,
      workspaceId: input.workspaceId,
      provider: STRIPE_PROVIDER,
      ...values,
    })
    .onConflictDoUpdate({
      target: [integrations.workspaceId, integrations.provider],
      targetWhere: sql`${integrations.workspaceId} IS NOT NULL AND ${integrations.provider} = 'stripe'`,
      set: values,
    })
    .returning({
      id: integrations.id,
      userWorkosId: integrations.userWorkosId,
    });

  if (!integration) throw new Error("Could not persist the Stripe integration.");

  // Workspace credentials remain bound to the original connector because the
  // credential AAD includes user_workos_id. A different admin can rotate the
  // key without changing that encryption identity.
  try {
    await saveIntegrationCredential({
      userWorkosId: integration.userWorkosId,
      integrationId: integration.id,
      provider: STRIPE_PROVIDER,
      kind: STRIPE_CREDENTIAL_KIND,
      payload: {
        apiKey: input.apiKey,
        accountId: input.identity.accountId,
        livemode: input.identity.livemode,
        connectedAt: now.toISOString(),
      } satisfies StripeCredentialPayload,
      expiresAt: null,
      db,
      now,
    });
  } catch (error) {
    await markIntegrationStatus({
      userWorkosId: integration.userWorkosId,
      integrationId: integration.id,
      provider: STRIPE_PROVIDER,
      status: "sync_failed",
      statusReason: "Failed to persist Stripe credentials.",
      db,
      now: new Date(),
    });
    throw error;
  }

  await captureIntegrationAddedAnalytics({
    userWorkosId: input.userWorkosId,
    workspaceId: input.workspaceId,
    provider: STRIPE_PROVIDER,
  });

  return { integrationId: integration.id };
}

export async function getStripeIntegrationState(
  workspaceId: string,
  db: DbLike = getDb(),
): Promise<StripeProviderState> {
  const [row] = await db
    .select({
      id: integrations.id,
      status: integrations.status,
      accountName: integrations.accountName,
      accountType: integrations.accountType,
      statusReason: integrations.statusReason,
      capabilityModes: integrations.capabilityModes,
      toolModes: integrations.toolModes,
    })
    .from(integrations)
    .where(
      and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, STRIPE_PROVIDER)),
    )
    .orderBy(desc(integrations.updatedAt))
    .limit(1);

  if (!row || row.status === "disconnected") return emptyStripeProviderState();

  return {
    provider: STRIPE_PROVIDER,
    connected: row.status === "connected",
    status: row.status,
    integrationId: row.id,
    accountName: row.accountName,
    livemode: row.accountType === "stripe_live_restricted_key",
    statusReason: row.statusReason,
    capabilityModes: row.capabilityModes,
    toolModes: row.toolModes,
  };
}

export function getStripeMcpIntegrationState(input: { userWorkosId: string; workspaceId: string }) {
  return getStripeIntegrationState(input.workspaceId);
}

export async function loadStripeMcpWorkerConnection(input: {
  userWorkosId: string;
  workspaceId: string;
  onAuthorizationRequired: () => never;
}) {
  const state = await getStripeIntegrationState(input.workspaceId);
  if (state.status === "not_connected" || state.status === "disconnected") {
    return { ok: false as const, reason: "not_connected" as const };
  }
  if (!state.connected) return { ok: false as const, reason: "needs_reauth" as const };

  const connection = await loadStripeConnection(input.workspaceId);
  if (!connection) return { ok: false as const, reason: "needs_reauth" as const };

  return {
    ok: true as const,
    integrationId: connection.integrationId,
    authProvider: createRemoteMcpStaticBearerAuthProvider({
      accessToken: connection.apiKey,
      onAuthorizationRequired: async () => {
        await markStripeConnectionNeedsReauth(connection);
        return input.onAuthorizationRequired();
      },
    }),
  };
}

export async function loadStripeConnection(workspaceId: string): Promise<StripeConnection | null> {
  const [integration] = await getDb()
    .select({
      id: integrations.id,
      userWorkosId: integrations.userWorkosId,
      externalId: integrations.externalId,
      accountName: integrations.accountName,
      status: integrations.status,
    })
    .from(integrations)
    .where(
      and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, STRIPE_PROVIDER)),
    )
    .orderBy(desc(integrations.updatedAt))
    .limit(1);

  if (!integration || integration.status !== "connected") return null;
  const credential = await loadIntegrationCredential({
    userWorkosId: integration.userWorkosId,
    integrationId: integration.id,
    provider: STRIPE_PROVIDER,
    kind: STRIPE_CREDENTIAL_KIND,
  });
  const payload = parseStripeCredential(credential?.payload);
  if (!payload || payload.accountId !== integration.externalId) {
    await markIntegrationStatus({
      userWorkosId: integration.userWorkosId,
      integrationId: integration.id,
      provider: STRIPE_PROVIDER,
      status: "needs_reauth",
      statusReason: "Stripe needs to be reconnected before opencompany can use it.",
    });
    return null;
  }

  return {
    integrationId: integration.id,
    userWorkosId: integration.userWorkosId,
    accountId: payload.accountId,
    accountName: integration.accountName?.trim() || payload.accountId,
    livemode: payload.livemode,
    apiKey: payload.apiKey,
  };
}

export async function disconnectStripeIntegration(
  workspaceId: string,
  db: DbLike = getDb(),
): Promise<boolean> {
  const deleted = await db
    .delete(integrations)
    .where(
      and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, STRIPE_PROVIDER)),
    )
    .returning({ id: integrations.id });
  return deleted.length > 0;
}

export async function markStripeConnectionNeedsReauth(connection: StripeConnection) {
  await markIntegrationStatus({
    userWorkosId: connection.userWorkosId,
    integrationId: connection.integrationId,
    provider: STRIPE_PROVIDER,
    status: "needs_reauth",
    statusReason: "Stripe rejected the saved restricted key or one of its required permissions.",
  });
}

export async function requestStripeApi<T>(input: {
  apiKey: string;
  path: string;
  params?: Readonly<Record<string, string | number | boolean | undefined>>;
  signal?: AbortSignal;
}): Promise<T> {
  const url = new URL(`${STRIPE_API_BASE_URL}${input.path}`);
  for (const [key, value] of Object.entries(input.params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        Accept: "application/json",
        "Stripe-Version": STRIPE_API_VERSION,
      },
      signal: input.signal ?? AbortSignal.timeout(STRIPE_API_TIMEOUT_MS),
    });
  } catch (error) {
    if (
      error instanceof DOMException &&
      (error.name === "AbortError" || error.name === "TimeoutError")
    ) {
      throw error;
    }
    throw new Error("Could not reach the Stripe API.");
  }
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as StripeApiErrorPayload | null;
    throw new StripeApiError(response.status, input.path, payload);
  }
  return (await response.json()) as T;
}

function parseStripeCredential(value: unknown): StripeCredentialPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (
    typeof payload.apiKey !== "string" ||
    !isValidStripeRestrictedApiKey(payload.apiKey) ||
    typeof payload.accountId !== "string" ||
    !payload.accountId.startsWith("acct_") ||
    typeof payload.livemode !== "boolean" ||
    typeof payload.connectedAt !== "string"
  ) {
    return null;
  }
  return {
    apiKey: payload.apiKey,
    accountId: payload.accountId,
    livemode: payload.livemode,
    connectedAt: payload.connectedAt,
  };
}

function stripeValidationError(error: unknown, permission: string) {
  if (error instanceof StripeApiError) {
    if (error.status === 401) return "Stripe rejected this restricted key. Check it and try again.";
    if (error.status === 403) {
      return `This restricted key needs read access to ${permission}. Update the key's permissions in Stripe and try again.`;
    }
    return `Stripe returned an unexpected error while checking ${permission} (${error.status}).`;
  }
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return "Stripe took too long to respond. Try again in a moment.";
  }
  return "Could not reach Stripe. Try again in a moment.";
}

function cleanStripeLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length > 200 ? `${normalized.slice(0, 199)}…` : normalized;
}

function boundedStripeErrorString(value: unknown): string | undefined {
  const normalized = cleanStripeLabel(value);
  if (!normalized) return undefined;
  return normalized.length > MAX_STRIPE_ERROR_DETAIL_CHARS
    ? `${normalized.slice(0, MAX_STRIPE_ERROR_DETAIL_CHARS - 1)}…`
    : normalized;
}

function newStripeIntegrationId() {
  return `gint_${randomUUID().replace(/-/g, "")}`;
}

function emptyStripeProviderState(): StripeProviderState {
  return {
    provider: STRIPE_PROVIDER,
    connected: false,
    status: "not_connected",
    integrationId: null,
    accountName: null,
    livemode: null,
    statusReason: null,
    capabilityModes: {},
    toolModes: {},
  };
}
