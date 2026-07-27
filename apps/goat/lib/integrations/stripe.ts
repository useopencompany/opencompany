import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { getDb } from "@opencompany/db/client";
import {
  loadGoatIntegrationCredential,
  markGoatIntegrationStatus,
  refreshGoatIntegrationCredential,
  saveGoatIntegrationCredential,
} from "@opencompany/db/goat-integrations";
import { goatIntegrationCredentials, goatIntegrations } from "@opencompany/db/goat-schema";
import { and, desc, eq, sql } from "drizzle-orm";
import type { GoatStripeProviderState } from "@/lib/integration-state";
import { getGoatAppUrl } from "@/lib/workos";

export const GOAT_STRIPE_PROVIDER = "stripe" as const;
export const GOAT_STRIPE_CREDENTIAL_KIND = "oauth_token" as const;
export const GOAT_STRIPE_API_BASE_URL = "https://api.stripe.com/v1";
export const GOAT_STRIPE_API_VERSION = "2026-04-22.dahlia";

const STRIPE_OAUTH_AUTHORIZE_URL = "https://marketplace.stripe.com/oauth/v2/authorize";
const STRIPE_OAUTH_TOKEN_URL = "https://api.stripe.com/v1/oauth/token";
const STRIPE_API_TIMEOUT_MS = 15_000;
const STRIPE_OAUTH_STATE_TTL_MS = 10 * 60 * 1_000;
const STRIPE_ACCESS_TOKEN_LIFETIME_SECONDS = 60 * 60;
const STRIPE_ACCESS_TOKEN_REFRESH_SKEW_MS = 60_000;
const MAX_STRIPE_ERROR_DETAIL_CHARS = 200;
const stripeTokenRefreshes = new Map<string, Promise<string>>();

const GOAT_STRIPE_OAUTH_ENVS = [
  "GOAT_STRIPE_OAUTH_CLIENT_ID",
  "GOAT_STRIPE_OAUTH_SECRET_KEY",
  "GOAT_STRIPE_OAUTH_STATE_SECRET",
  "GOAT_STRIPE_APP_WEBHOOK_SECRET",
  "INTEGRATION_CREDENTIAL_ENCRYPTION_KEY",
] as const;

export const GOAT_STRIPE_REQUIRED_READ_PERMISSIONS = [
  "connected_account_read",
  "balance_read",
  "subscription_read",
  "invoice_read",
  "event_read",
] as const;

export type GoatStripeOAuthStatePayload = {
  userWorkosId: string;
  workspaceId: string;
  returnTo: string;
  redirectUri: string;
  expiresAt: number;
  nonce: string;
};

export type GoatStripeOAuthTokens = {
  accessToken: string;
  refreshToken: string;
  accountId: string;
  livemode: boolean;
  scope: string | null;
  expiresAt: Date;
};

export type GoatStripeCredentialPayload = {
  accessToken: string;
  refreshToken: string;
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

export type GoatStripeOAuthValidation =
  | { ok: true; identity: GoatStripeAccountIdentity }
  | {
      ok: false;
      error: string;
      reason: "account_mismatch" | "invalid_grant" | "missing_permissions" | "provider_unavailable";
    };

export type GoatStripeConnection = {
  integrationId: string;
  userWorkosId: string;
  accountId: string;
  accountName: string;
  livemode: boolean;
  accessToken: string;
};

type StripeApiErrorPayload = {
  error?: {
    code?: string;
    message?: string;
    type?: string;
  };
};

type StripeOAuthErrorPayload = {
  error?: string;
  error_description?: string;
};

type StripeOAuthTokenPayload = StripeOAuthErrorPayload & {
  access_token?: string;
  refresh_token?: string;
  stripe_user_id?: string;
  account_id?: string;
  livemode?: boolean;
  scope?: string;
  expires_in?: number;
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

export class GoatStripeOAuthError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, payload?: StripeOAuthErrorPayload | null) {
    super(`Stripe OAuth token exchange failed (${status}).`);
    this.name = "GoatStripeOAuthError";
    this.status = status;
    this.code = boundedStripeErrorString(payload?.error);
  }
}

export class GoatStripeOAuthAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoatStripeOAuthAuthError";
  }
}

export function isGoatStripeOAuthConfigured() {
  if (!GOAT_STRIPE_OAUTH_ENVS.every((name) => Boolean(process.env[name]?.trim()))) return false;
  if (requiredEnv("GOAT_STRIPE_OAUTH_STATE_SECRET").length < 32) return false;
  try {
    goatStripeOAuthRedirectUri();
    return true;
  } catch {
    return false;
  }
}

export function createGoatStripeOAuthState(
  input: Omit<GoatStripeOAuthStatePayload, "expiresAt" | "nonce" | "redirectUri"> & {
    redirectUri?: string;
  },
) {
  const payload: GoatStripeOAuthStatePayload = {
    userWorkosId: input.userWorkosId,
    workspaceId: input.workspaceId,
    returnTo: sanitizeReturnTo(input.returnTo),
    redirectUri: sanitizeGoatStripeOAuthRedirectUri(
      input.redirectUri ?? goatStripeOAuthRedirectUri(),
    ),
    expiresAt: Date.now() + STRIPE_OAUTH_STATE_TTL_MS,
    nonce: randomUUID(),
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${signStripeOAuthState(body)}`;
}

export function verifyGoatStripeOAuthState(state: string): GoatStripeOAuthStatePayload {
  const [body, signature] = state.split(".");
  if (!body || !signature || !safeEqual(signature, signStripeOAuthState(body))) {
    throw new Error("Invalid Stripe OAuth state.");
  }

  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
  if (!isGoatStripeOAuthStatePayload(payload)) {
    throw new Error("Invalid Stripe OAuth state payload.");
  }
  if (payload.expiresAt < Date.now()) {
    throw new Error("Stripe OAuth state expired.");
  }

  return {
    ...payload,
    returnTo: sanitizeReturnTo(payload.returnTo),
    redirectUri: sanitizeGoatStripeOAuthRedirectUri(payload.redirectUri),
  };
}

export function buildGoatStripeOAuthAuthorizationUrl(
  state: string,
  redirectUri = goatStripeOAuthRedirectUri(),
) {
  const url = new URL(STRIPE_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("client_id", requiredEnv("GOAT_STRIPE_OAUTH_CLIENT_ID"));
  url.searchParams.set("redirect_uri", sanitizeGoatStripeOAuthRedirectUri(redirectUri));
  url.searchParams.set("state", state);
  return url.toString();
}

export function goatStripeOAuthRedirectUri() {
  const configured = process.env.GOAT_STRIPE_OAUTH_CALLBACK_URL?.trim();
  return sanitizeGoatStripeOAuthRedirectUri(
    configured || `${getGoatAppUrl()}/api/integrations/stripe/callback`,
  );
}

export function appendGoatStripeIntegrationStatus(
  returnTo: string,
  status: "connected" | "error",
  reason?: string,
) {
  const url = new URL(sanitizeReturnTo(returnTo), getGoatAppUrl());
  url.searchParams.set("integration", GOAT_STRIPE_PROVIDER);
  url.searchParams.set("setup", status);
  if (status === "error" && reason) url.searchParams.set("reason", reason);
  return `${url.pathname}${url.search}`;
}

export async function exchangeGoatStripeOAuthCode(code: string): Promise<GoatStripeOAuthTokens> {
  return requestGoatStripeOAuthToken({
    grant_type: "authorization_code",
    code,
  });
}

export async function refreshGoatStripeOAuthTokens(
  refreshToken: string,
): Promise<GoatStripeOAuthTokens> {
  return requestGoatStripeOAuthToken({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

export async function validateGoatStripeOAuthAccess(
  tokens: Pick<GoatStripeOAuthTokens, "accessToken" | "accountId" | "livemode">,
): Promise<GoatStripeOAuthValidation> {
  let account: {
    id?: string;
    email?: string | null;
    country?: string | null;
    business_profile?: { name?: string | null };
    settings?: { dashboard?: { display_name?: string | null } };
  };
  try {
    account = await requestGoatStripeApi({
      accessToken: tokens.accessToken,
      path: "/account",
      signal: AbortSignal.timeout(STRIPE_API_TIMEOUT_MS),
    });
  } catch (error) {
    return stripeOAuthValidationError(error, "account details");
  }

  const accountId = account.id?.trim();
  if (!accountId?.startsWith("acct_") || accountId !== tokens.accountId) {
    return {
      ok: false,
      error: "Stripe returned an account that did not match the OAuth grant.",
      reason: "account_mismatch",
    };
  }

  const permissionChecks = [
    { label: "balances", path: "/balance" },
    {
      label: "balance transactions",
      path: "/balance_transactions",
      params: { limit: 1 },
    },
    {
      label: "subscriptions",
      path: "/subscriptions",
      params: { limit: 1, status: "active" },
    },
    { label: "invoices", path: "/invoices", params: { limit: 1, status: "open" } },
  ] as const;

  for (const check of permissionChecks) {
    try {
      await requestGoatStripeApi({
        accessToken: tokens.accessToken,
        path: check.path,
        ...("params" in check ? { params: check.params } : {}),
        signal: AbortSignal.timeout(STRIPE_API_TIMEOUT_MS),
      });
    } catch (error) {
      return stripeOAuthValidationError(error, check.label);
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
      livemode: tokens.livemode,
    },
  };
}

export async function connectGoatStripeIntegration(input: {
  userWorkosId: string;
  workspaceId: string;
  tokens: GoatStripeOAuthTokens;
  identity: GoatStripeAccountIdentity;
  now?: Date;
}): Promise<{ integrationId: string }> {
  if (
    input.tokens.accountId !== input.identity.accountId ||
    input.tokens.livemode !== input.identity.livemode
  ) {
    throw new Error("Stripe OAuth tokens did not match the validated account.");
  }

  const db = getDb();
  const now = input.now ?? new Date();
  const values = {
    externalId: input.identity.accountId,
    connectionLabel: input.identity.accountName,
    accountName: input.identity.accountName,
    accountEmail: input.identity.accountEmail,
    accountType: input.identity.livemode ? "stripe_oauth_live" : "stripe_oauth_test",
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
  // credential AAD includes user_workos_id. Another admin can reauthorize the
  // workspace without changing that encryption identity.
  try {
    await saveGoatIntegrationCredential({
      userWorkosId: integration.userWorkosId,
      integrationId: integration.id,
      provider: GOAT_STRIPE_PROVIDER,
      kind: GOAT_STRIPE_CREDENTIAL_KIND,
      payload: {
        accessToken: input.tokens.accessToken,
        refreshToken: input.tokens.refreshToken,
        accountId: input.tokens.accountId,
        livemode: input.tokens.livemode,
        connectedAt: now.toISOString(),
      } satisfies GoatStripeCredentialPayload,
      expiresAt: input.tokens.expiresAt,
      db,
      now,
    });
    // OAuth is the only supported customer-Stripe credential. Remove a key
    // left by the pre-OAuth implementation after a successful authorization.
    await db
      .delete(goatIntegrationCredentials)
      .where(
        and(
          eq(goatIntegrationCredentials.integrationId, integration.id),
          eq(goatIntegrationCredentials.kind, "api_key"),
        ),
      );
  } catch (error) {
    await markGoatIntegrationStatus({
      userWorkosId: integration.userWorkosId,
      integrationId: integration.id,
      provider: GOAT_STRIPE_PROVIDER,
      status: "sync_failed",
      statusReason: "Failed to persist Stripe OAuth credentials.",
      db,
      now: new Date(),
    });
    throw error;
  }

  return { integrationId: integration.id };
}

export async function getGoatStripeIntegrationState(
  workspaceId: string,
): Promise<GoatStripeProviderState> {
  const [row] = await getDb()
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

  const livemode = goatStripeOAuthLivemode(row.accountType);
  if (livemode === null) {
    return {
      provider: GOAT_STRIPE_PROVIDER,
      connected: false,
      status: "needs_reauth",
      integrationId: row.id,
      accountName: row.accountName,
      livemode: null,
      statusReason: "Reconnect Stripe to authorize read-only access.",
    };
  }

  return {
    provider: GOAT_STRIPE_PROVIDER,
    connected: row.status === "connected",
    status: row.status,
    integrationId: row.id,
    accountName: row.accountName,
    livemode,
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
      accountType: goatIntegrations.accountType,
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
  const livemode = goatStripeOAuthLivemode(integration.accountType);
  if (livemode === null) return null;

  const base = {
    integrationId: integration.id,
    userWorkosId: integration.userWorkosId,
    accountId: integration.externalId,
    accountName: integration.accountName?.trim() || integration.externalId,
    livemode,
  };
  const accessToken = await getGoatStripeAccessToken(base);
  return { ...base, accessToken };
}

export async function refreshGoatStripeConnectionAccessToken(
  connection: GoatStripeConnection,
): Promise<string> {
  return getGoatStripeAccessToken(connection, { forceRefresh: true });
}

export async function disconnectGoatStripeIntegration(workspaceId: string): Promise<boolean> {
  const deleted = await getDb()
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

export async function disconnectGoatStripeIntegrationForAccount(input: {
  accountId: string;
  livemode: boolean;
}): Promise<number> {
  const deleted = await getDb()
    .delete(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.provider, GOAT_STRIPE_PROVIDER),
        eq(goatIntegrations.externalId, input.accountId),
        eq(
          goatIntegrations.accountType,
          input.livemode ? "stripe_oauth_live" : "stripe_oauth_test",
        ),
      ),
    )
    .returning({ id: goatIntegrations.id });
  return deleted.length;
}

export async function markGoatStripeConnectionNeedsReauth(connection: GoatStripeConnection) {
  await markStripeNeedsReauth(connection, "Stripe OAuth access was revoked or lost permission.");
}

export async function requestGoatStripeApi<T>(input: {
  accessToken: string;
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
        Authorization: `Bearer ${input.accessToken}`,
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

async function getGoatStripeAccessToken(
  connection: Pick<
    GoatStripeConnection,
    "integrationId" | "userWorkosId" | "accountId" | "livemode"
  >,
  options?: { forceRefresh?: boolean },
) {
  const credential = await loadGoatIntegrationCredential({
    userWorkosId: connection.userWorkosId,
    integrationId: connection.integrationId,
    provider: GOAT_STRIPE_PROVIDER,
    kind: GOAT_STRIPE_CREDENTIAL_KIND,
  });
  const payload = parseGoatStripeCredential(credential?.payload);
  if (
    !credential ||
    !payload ||
    payload.accountId !== connection.accountId ||
    payload.livemode !== connection.livemode
  ) {
    await markStripeNeedsReauth(connection, "Stored Stripe OAuth credentials are not usable.");
    throw new GoatStripeOAuthAuthError("Stored Stripe OAuth credentials are not usable.");
  }

  if (
    !options?.forceRefresh &&
    credential.expiresAt &&
    credential.expiresAt.getTime() - STRIPE_ACCESS_TOKEN_REFRESH_SKEW_MS > Date.now()
  ) {
    return payload.accessToken;
  }

  const inFlight = stripeTokenRefreshes.get(connection.integrationId);
  if (inFlight) return inFlight;

  const refresh = refreshGoatStripeCredential(connection, credential.updatedAt).finally(() => {
    if (stripeTokenRefreshes.get(connection.integrationId) === refresh) {
      stripeTokenRefreshes.delete(connection.integrationId);
    }
  });
  stripeTokenRefreshes.set(connection.integrationId, refresh);
  return refresh;
}

async function refreshGoatStripeCredential(
  connection: Pick<
    GoatStripeConnection,
    "integrationId" | "userWorkosId" | "accountId" | "livemode"
  >,
  loadedAt: Date,
) {
  const current = await loadGoatIntegrationCredential({
    userWorkosId: connection.userWorkosId,
    integrationId: connection.integrationId,
    provider: GOAT_STRIPE_PROVIDER,
    kind: GOAT_STRIPE_CREDENTIAL_KIND,
  });
  const payload = parseGoatStripeCredential(current?.payload);
  if (!current || !payload) {
    await markStripeNeedsReauth(connection, "Stored Stripe OAuth credentials are not usable.");
    throw new GoatStripeOAuthAuthError("Stored Stripe OAuth credentials are not usable.");
  }

  // A different request may have completed the rotation before this refresh
  // acquired the local in-flight slot.
  if (
    current.updatedAt.getTime() > loadedAt.getTime() &&
    current.expiresAt &&
    current.expiresAt.getTime() - STRIPE_ACCESS_TOKEN_REFRESH_SKEW_MS > Date.now()
  ) {
    return payload.accessToken;
  }

  let tokens: GoatStripeOAuthTokens;
  try {
    tokens = await refreshGoatStripeOAuthTokens(payload.refreshToken);
  } catch (error) {
    if (error instanceof GoatStripeOAuthError && error.code === "invalid_grant") {
      // Stripe rotates refresh tokens. Another server instance can win the
      // exchange; recover its freshly persisted token instead of forcing a
      // needless reconnect.
      const recovered = await loadGoatIntegrationCredential({
        userWorkosId: connection.userWorkosId,
        integrationId: connection.integrationId,
        provider: GOAT_STRIPE_PROVIDER,
        kind: GOAT_STRIPE_CREDENTIAL_KIND,
      });
      const recoveredPayload = parseGoatStripeCredential(recovered?.payload);
      if (
        recovered &&
        recoveredPayload &&
        recovered.updatedAt.getTime() > current.updatedAt.getTime() &&
        recovered.expiresAt &&
        recovered.expiresAt.getTime() - STRIPE_ACCESS_TOKEN_REFRESH_SKEW_MS > Date.now()
      ) {
        return recoveredPayload.accessToken;
      }
      await markStripeNeedsReauth(connection, "Stripe rejected the OAuth refresh token.");
      throw new GoatStripeOAuthAuthError("Stripe rejected the OAuth refresh token.");
    }
    throw error;
  }

  if (tokens.accountId !== connection.accountId || tokens.livemode !== connection.livemode) {
    await markStripeNeedsReauth(connection, "Stripe refreshed a different OAuth account.");
    throw new GoatStripeOAuthAuthError("Stripe refreshed a different OAuth account.");
  }

  await refreshGoatIntegrationCredential({
    userWorkosId: connection.userWorkosId,
    integrationId: connection.integrationId,
    provider: GOAT_STRIPE_PROVIDER,
    kind: GOAT_STRIPE_CREDENTIAL_KIND,
    payload: {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accountId: tokens.accountId,
      livemode: tokens.livemode,
      connectedAt: payload.connectedAt,
    } satisfies GoatStripeCredentialPayload,
    expiresAt: tokens.expiresAt,
    db: getDb(),
  });
  return tokens.accessToken;
}

async function requestGoatStripeOAuthToken(
  form:
    | { grant_type: "authorization_code"; code: string }
    | { grant_type: "refresh_token"; refresh_token: string },
): Promise<GoatStripeOAuthTokens> {
  let response: Response;
  try {
    response = await fetch(STRIPE_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(
          `${requiredEnv("GOAT_STRIPE_OAUTH_SECRET_KEY")}:`,
        ).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(STRIPE_API_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") throw error;
    throw new Error("Could not reach Stripe OAuth.");
  }

  const result = (await response.json().catch(() => null)) as StripeOAuthTokenPayload | null;
  if (!response.ok) throw new GoatStripeOAuthError(response.status, result);

  const accessToken = cleanOAuthToken(result?.access_token);
  const refreshToken = cleanOAuthToken(result?.refresh_token);
  const accountId = cleanStripeLabel(result?.stripe_user_id ?? result?.account_id);
  if (
    !accessToken ||
    !refreshToken ||
    !accountId?.startsWith("acct_") ||
    typeof result?.livemode !== "boolean"
  ) {
    throw new Error("Stripe OAuth returned an incomplete token response.");
  }

  const expiresIn =
    typeof result.expires_in === "number" &&
    Number.isFinite(result.expires_in) &&
    result.expires_in > 0
      ? result.expires_in
      : STRIPE_ACCESS_TOKEN_LIFETIME_SECONDS;

  return {
    accessToken,
    refreshToken,
    accountId,
    livemode: result.livemode,
    scope: cleanStripeLabel(result.scope),
    expiresAt: new Date(Date.now() + expiresIn * 1_000),
  };
}

function parseGoatStripeCredential(value: unknown): GoatStripeCredentialPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  const accessToken = cleanOAuthToken(payload.accessToken);
  const refreshToken = cleanOAuthToken(payload.refreshToken);
  if (
    !accessToken ||
    !refreshToken ||
    typeof payload.accountId !== "string" ||
    !payload.accountId.startsWith("acct_") ||
    typeof payload.livemode !== "boolean" ||
    typeof payload.connectedAt !== "string"
  ) {
    return null;
  }
  return {
    accessToken,
    refreshToken,
    accountId: payload.accountId,
    livemode: payload.livemode,
    connectedAt: payload.connectedAt,
  };
}

function stripeOAuthValidationError(error: unknown, resource: string) {
  if (error instanceof GoatStripeApiError) {
    if (error.status === 401) {
      return {
        ok: false,
        error: "Stripe rejected the OAuth access grant. Reconnect and retry.",
        reason: "invalid_grant",
      } as const;
    }
    if (error.status === 403) {
      return {
        ok: false,
        error: `The Stripe app was not granted read access to ${resource}. Reinstall it and accept the requested permissions.`,
        reason: "missing_permissions",
      } as const;
    }
    return {
      ok: false,
      error: `Stripe returned an unexpected error while checking ${resource} (${error.status}).`,
      reason: "provider_unavailable",
    } as const;
  }
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return {
      ok: false,
      error: "Stripe took too long to respond. Try again in a moment.",
      reason: "provider_unavailable",
    } as const;
  }
  return {
    ok: false,
    error: "Could not reach Stripe. Try again in a moment.",
    reason: "provider_unavailable",
  } as const;
}

async function markStripeNeedsReauth(
  connection: Pick<GoatStripeConnection, "integrationId" | "userWorkosId">,
  reason: string,
) {
  await markGoatIntegrationStatus({
    userWorkosId: connection.userWorkosId,
    integrationId: connection.integrationId,
    provider: GOAT_STRIPE_PROVIDER,
    status: "needs_reauth",
    statusReason: reason,
  });
}

function goatStripeOAuthLivemode(accountType: string | null): boolean | null {
  if (accountType === "stripe_oauth_live") return true;
  if (accountType === "stripe_oauth_test") return false;
  return null;
}

function isGoatStripeOAuthStatePayload(value: unknown): value is GoatStripeOAuthStatePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.userWorkosId === "string" &&
    typeof record.workspaceId === "string" &&
    typeof record.returnTo === "string" &&
    typeof record.redirectUri === "string" &&
    typeof record.expiresAt === "number" &&
    typeof record.nonce === "string"
  );
}

function sanitizeReturnTo(value: string) {
  if (
    value.length > 2_000 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\")
  ) {
    return "/settings/integrations";
  }
  return value;
}

function sanitizeGoatStripeOAuthRedirectUri(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Stripe OAuth callback URL must be a valid URL.");
  }
  const isLocalhost =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (
    (url.protocol !== "https:" && !(isLocalhost && url.protocol === "http:")) ||
    url.pathname !== "/api/integrations/stripe/callback" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error("Stripe OAuth callback URL is not allowed.");
  }
  return url.toString();
}

function signStripeOAuthState(body: string) {
  return createHmac("sha256", requiredEnv("GOAT_STRIPE_OAUTH_STATE_SECRET"))
    .update(body)
    .digest("base64url");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function cleanOAuthToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (normalized.length < 8 || normalized.length > 1_000 || /\s/.test(normalized)) return null;
  return normalized;
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

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the Goat Stripe OAuth integration.`);
  return value;
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
