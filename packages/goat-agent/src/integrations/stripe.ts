import { randomUUID } from "node:crypto";
import { getDb } from "@opencompany/db/client";
import {
  loadGoatIntegrationCredential,
  markGoatIntegrationStatus,
  saveGoatIntegrationCredential,
} from "@opencompany/db/goat-integrations";
import { goatIntegrations } from "@opencompany/db/goat-schema";
import { and, desc, eq, sql } from "drizzle-orm";
import type { GoatStripeProviderState } from "../integration-state";
import { captureGoatIntegrationAddedAnalytics } from "./analytics";

export const GOAT_STRIPE_PROVIDER = "stripe" as const;
export const GOAT_STRIPE_CREDENTIAL_KIND = "api_key" as const;
export const GOAT_STRIPE_API_BASE_URL = "https://api.stripe.com/v1";
export const GOAT_STRIPE_API_VERSION = "2026-04-22.dahlia";

// Follows the repo-wide injectable-db convention so the canonical API can pass
// its pooled handle while web/runner callers keep the getDb() default.
type DbLike = any;

const STRIPE_API_TIMEOUT_MS = 15_000;
const MAX_STRIPE_ERROR_DETAIL_CHARS = 200;

export const GOAT_STRIPE_REQUIRED_READ_PERMISSIONS = [
  "balance_read",
  "subscription_read",
  "invoice_read",
] as const;

export type GoatStripeCredentialPayload = {
  apiKey: string;
  accountId: string;
  livemode: boolean;
  connectedAt: string;
};

export type GoatStripeAccountIdentity = {
  accountId: string;
  accountName: string;
  accountEmail: string | null;
  country: string | null;
  livemode: boolean;
};

export type GoatStripeConnection = {
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

export class GoatStripeApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly detail: string | undefined;

  constructor(status: number, path: string, payload?: StripeApiErrorPayload | null) {
    super(`Stripe API GET ${path} failed (${status}).`);
    this.name = "GoatStripeApiError";
    this.status = status;
    this.code = boundedStripeErrorString(payload?.error?.code);
    this.detail = boundedStripeErrorString(payload?.error?.message);
  }
}

export function isValidGoatStripeRestrictedApiKey(apiKey: string) {
  return /^rk_(?:test|live)_[^\s]{16,500}$/.test(apiKey);
}

export function goatStripeKeyIsLive(apiKey: string) {
  return apiKey.startsWith("rk_live_");
}

export async function validateGoatStripeRestrictedApiKey(
  apiKey: string,
): Promise<{ ok: true; identity: GoatStripeAccountIdentity } | { ok: false; error: string }> {
  if (!isValidGoatStripeRestrictedApiKey(apiKey)) {
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
    account = await requestGoatStripeApi({
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
      await requestGoatStripeApi({
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
      livemode: goatStripeKeyIsLive(apiKey),
    },
  };
}

export async function connectGoatStripeIntegration(input: {
  userWorkosId: string;
  workspaceId: string;
  apiKey: string;
  identity: GoatStripeAccountIdentity;
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
    scopes: [...GOAT_STRIPE_REQUIRED_READ_PERMISSIONS],
    lastSyncedAt: now,
    updatedAt: now,
  };

  const [integration] = await db
    .insert(goatIntegrations)
    .values({
      id: newGoatStripeIntegrationId(),
      userWorkosId: input.userWorkosId,
      workspaceId: input.workspaceId,
      provider: GOAT_STRIPE_PROVIDER,
      ...values,
    })
    .onConflictDoUpdate({
      target: [goatIntegrations.workspaceId, goatIntegrations.provider],
      targetWhere: sql`${goatIntegrations.workspaceId} IS NOT NULL AND ${goatIntegrations.provider} = 'stripe'`,
      set: values,
    })
    .returning({
      id: goatIntegrations.id,
      userWorkosId: goatIntegrations.userWorkosId,
    });

  if (!integration) throw new Error("Could not persist the Stripe integration.");

  // Workspace credentials remain bound to the original connector because the
  // credential AAD includes user_workos_id. A different admin can rotate the
  // key without changing that encryption identity.
  try {
    await saveGoatIntegrationCredential({
      userWorkosId: integration.userWorkosId,
      integrationId: integration.id,
      provider: GOAT_STRIPE_PROVIDER,
      kind: GOAT_STRIPE_CREDENTIAL_KIND,
      payload: {
        apiKey: input.apiKey,
        accountId: input.identity.accountId,
        livemode: input.identity.livemode,
        connectedAt: now.toISOString(),
      } satisfies GoatStripeCredentialPayload,
      expiresAt: null,
      db,
      now,
    });
  } catch (error) {
    await markGoatIntegrationStatus({
      userWorkosId: integration.userWorkosId,
      integrationId: integration.id,
      provider: GOAT_STRIPE_PROVIDER,
      status: "sync_failed",
      statusReason: "Failed to persist Stripe credentials.",
      db,
      now: new Date(),
    });
    throw error;
  }

  await captureGoatIntegrationAddedAnalytics({
    userWorkosId: input.userWorkosId,
    workspaceId: input.workspaceId,
    provider: GOAT_STRIPE_PROVIDER,
  });

  return { integrationId: integration.id };
}

export async function getGoatStripeIntegrationState(
  workspaceId: string,
  db: DbLike = getDb(),
): Promise<GoatStripeProviderState> {
  const [row] = await db
    .select({
      id: goatIntegrations.id,
      status: goatIntegrations.status,
      accountName: goatIntegrations.accountName,
      accountType: goatIntegrations.accountType,
      statusReason: goatIntegrations.statusReason,
    })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.workspaceId, workspaceId),
        eq(goatIntegrations.provider, GOAT_STRIPE_PROVIDER),
      ),
    )
    .orderBy(desc(goatIntegrations.updatedAt))
    .limit(1);

  if (!row || row.status === "disconnected") return emptyGoatStripeProviderState();

  return {
    provider: GOAT_STRIPE_PROVIDER,
    connected: row.status === "connected",
    status: row.status,
    integrationId: row.id,
    accountName: row.accountName,
    livemode: row.accountType === "stripe_live_restricted_key",
    statusReason: row.statusReason,
  };
}

export async function loadGoatStripeConnection(
  workspaceId: string,
): Promise<GoatStripeConnection | null> {
  const [integration] = await getDb()
    .select({
      id: goatIntegrations.id,
      userWorkosId: goatIntegrations.userWorkosId,
      externalId: goatIntegrations.externalId,
      accountName: goatIntegrations.accountName,
      status: goatIntegrations.status,
    })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.workspaceId, workspaceId),
        eq(goatIntegrations.provider, GOAT_STRIPE_PROVIDER),
      ),
    )
    .orderBy(desc(goatIntegrations.updatedAt))
    .limit(1);

  if (!integration || integration.status !== "connected") return null;
  const credential = await loadGoatIntegrationCredential({
    userWorkosId: integration.userWorkosId,
    integrationId: integration.id,
    provider: GOAT_STRIPE_PROVIDER,
    kind: GOAT_STRIPE_CREDENTIAL_KIND,
  });
  const payload = parseGoatStripeCredential(credential?.payload);
  if (!payload || payload.accountId !== integration.externalId) return null;

  return {
    integrationId: integration.id,
    userWorkosId: integration.userWorkosId,
    accountId: payload.accountId,
    accountName: integration.accountName?.trim() || payload.accountId,
    livemode: payload.livemode,
    apiKey: payload.apiKey,
  };
}

export async function disconnectGoatStripeIntegration(
  workspaceId: string,
  db: DbLike = getDb(),
): Promise<boolean> {
  const deleted = await db
    .delete(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.workspaceId, workspaceId),
        eq(goatIntegrations.provider, GOAT_STRIPE_PROVIDER),
      ),
    )
    .returning({ id: goatIntegrations.id });
  return deleted.length > 0;
}

export async function markGoatStripeConnectionNeedsReauth(connection: GoatStripeConnection) {
  await markGoatIntegrationStatus({
    userWorkosId: connection.userWorkosId,
    integrationId: connection.integrationId,
    provider: GOAT_STRIPE_PROVIDER,
    status: "needs_reauth",
    statusReason: "Stripe rejected the saved restricted key or one of its required permissions.",
  });
}

export async function requestGoatStripeApi<T>(input: {
  apiKey: string;
  path: string;
  params?: Readonly<Record<string, string | number | boolean | undefined>>;
  signal?: AbortSignal;
}): Promise<T> {
  const url = new URL(`${GOAT_STRIPE_API_BASE_URL}${input.path}`);
  for (const [key, value] of Object.entries(input.params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        Accept: "application/json",
        "Stripe-Version": GOAT_STRIPE_API_VERSION,
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
    throw new GoatStripeApiError(response.status, input.path, payload);
  }
  return (await response.json()) as T;
}

function parseGoatStripeCredential(value: unknown): GoatStripeCredentialPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (
    typeof payload.apiKey !== "string" ||
    !isValidGoatStripeRestrictedApiKey(payload.apiKey) ||
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
  if (error instanceof GoatStripeApiError) {
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

function newGoatStripeIntegrationId() {
  return `gint_${randomUUID().replace(/-/g, "")}`;
}

function emptyGoatStripeProviderState(): GoatStripeProviderState {
  return {
    provider: GOAT_STRIPE_PROVIDER,
    connected: false,
    status: "not_connected",
    integrationId: null,
    accountName: null,
    livemode: null,
    statusReason: null,
  };
}
