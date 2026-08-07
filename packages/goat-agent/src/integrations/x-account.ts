import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { getDb } from "@opencompany/db/client";
import { goatIntegrations } from "@opencompany/db/goat-schema";
import { and, desc, eq } from "drizzle-orm";
import { getGoatAppUrl } from "../app-url";
import type { GoatXAccountProviderState } from "../integration-state";

export type GoatXAccountIntegrationStatePayload = {
  userWorkosId: string;
  returnTo: string;
  expiresAt: number;
  nonce: string;
};

export type GoatXAccountPkcePair = {
  codeVerifier: string;
  codeChallenge: string;
};

export type GoatXAccountOAuthTokens = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string[];
};

export type GoatXAccountIdentity = {
  id: string;
  username: string;
  name: string | null;
};

const X_PROVIDER = "x_account" as const;
const X_AUTHORIZATION_ENDPOINT = "https://x.com/i/oauth2/authorize";
const X_TOKEN_ENDPOINT = "https://api.x.com/2/oauth2/token";
const GOAT_X_ACCOUNT_INTEGRATION_ENVS = [
  "GOAT_X_CLIENT_ID",
  "GOAT_X_CLIENT_SECRET",
  "GOAT_X_STATE_SECRET",
] as const;

// tweet.write posts on the user's behalf; offline.access is required to
// receive a refresh token (X access tokens expire after 2 hours).
export const GOAT_X_ACCOUNT_SCOPES = [
  "tweet.read",
  "tweet.write",
  "users.read",
  "offline.access",
] as const;

export function isGoatXAccountIntegrationConfigured() {
  return GOAT_X_ACCOUNT_INTEGRATION_ENVS.every((name) => Boolean(process.env[name]?.trim()));
}

export async function getGoatXAccountIntegrationState(
  userWorkosId: string,
): Promise<GoatXAccountProviderState> {
  const [row] = await getDb()
    .select({
      id: goatIntegrations.id,
      status: goatIntegrations.status,
      accountName: goatIntegrations.accountName,
      connectionLabel: goatIntegrations.connectionLabel,
      statusReason: goatIntegrations.statusReason,
    })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.userWorkosId, userWorkosId),
        eq(goatIntegrations.provider, X_PROVIDER),
      ),
    )
    .orderBy(desc(goatIntegrations.updatedAt))
    .limit(1);

  if (!row || row.status === "disconnected") {
    return {
      provider: X_PROVIDER,
      connected: false,
      status: "not_connected",
      integrationId: null,
      accountName: null,
      handle: null,
      statusReason: null,
    };
  }

  return {
    provider: X_PROVIDER,
    connected: row.status === "connected",
    status: row.status,
    integrationId: row.id,
    accountName: row.accountName,
    handle: row.connectionLabel,
    statusReason: row.statusReason,
  };
}

export function createGoatXAccountIntegrationState(
  input: Omit<GoatXAccountIntegrationStatePayload, "expiresAt" | "nonce">,
) {
  const payload: GoatXAccountIntegrationStatePayload = {
    ...input,
    returnTo: sanitizeReturnTo(input.returnTo),
    expiresAt: Date.now() + 10 * 60 * 1000,
    nonce: randomUUID(),
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${signStateBody(body)}`;
}

export function verifyGoatXAccountIntegrationState(
  state: string,
): GoatXAccountIntegrationStatePayload {
  const [body, signature] = state.split(".");
  if (!body || !signature || !safeEqual(signature, signStateBody(body))) {
    throw new Error("Invalid X integration state.");
  }

  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
  if (!isGoatXAccountIntegrationStatePayload(payload)) {
    throw new Error("Invalid X integration state payload.");
  }
  if (payload.expiresAt < Date.now()) {
    throw new Error("X integration state expired.");
  }

  return {
    ...payload,
    returnTo: sanitizeReturnTo(payload.returnTo),
  };
}

// PKCE is mandatory for X's authorization code flow. The verifier is never
// put in the (browser-visible, X-bounced) state parameter — callers persist
// it themselves for the round trip (e.g. an httpOnly cookie in the app route).
export function createGoatXAccountPkce(): GoatXAccountPkcePair {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

export function buildGoatXAccountAuthorizationUrl(state: string, codeChallenge: string) {
  const url = new URL(X_AUTHORIZATION_ENDPOINT);
  url.searchParams.set("client_id", requiredEnv("GOAT_X_CLIENT_ID"));
  url.searchParams.set("redirect_uri", goatXAccountCallbackUrl());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOAT_X_ACCOUNT_SCOPES.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function exchangeGoatXAccountCode(
  code: string,
  codeVerifier: string,
): Promise<GoatXAccountOAuthTokens> {
  const response = await fetch(X_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuthHeader(),
    },
    body: new URLSearchParams({
      code,
      grant_type: "authorization_code",
      redirect_uri: goatXAccountCallbackUrl(),
      code_verifier: codeVerifier,
    }),
  });

  if (!response.ok) {
    throw new Error(`X token exchange failed with ${response.status}: ${await response.text()}`);
  }

  const result = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    scope?: string;
    expires_in?: number;
  };
  if (!result.access_token) {
    throw new Error("X did not return an access token.");
  }

  return {
    accessToken: result.access_token,
    refreshToken: result.refresh_token ?? null,
    expiresAt: toExpiresAt(result.expires_in),
    scopes: (result.scope ?? "").split(" ").filter(Boolean),
  };
}

export async function fetchGoatXAccountIdentity(
  accessToken: string,
): Promise<GoatXAccountIdentity> {
  const url = new URL("https://api.x.com/2/users/me");
  url.searchParams.set("user.fields", "username,name");
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`X user lookup failed with ${response.status}.`);
  }
  const result = (await response.json()) as {
    data?: { id?: string; username?: string; name?: string };
  };
  const id = result.data?.id?.trim();
  const username = result.data?.username?.trim();
  if (!id || !username) {
    throw new Error("X did not return an account id and username.");
  }
  return { id, username, name: result.data?.name?.trim() || null };
}

export function appendGoatXAccountIntegrationStatus(
  returnTo: string,
  status: "connected" | "error",
  reason?: string,
) {
  const url = new URL(sanitizeReturnTo(returnTo), getGoatAppUrl());
  url.searchParams.set("integration", X_PROVIDER);
  url.searchParams.set("setup", status);
  if (status === "error" && reason) url.searchParams.set("reason", reason);
  return `${url.pathname}${url.search}`;
}

export function goatXAccountCallbackUrl() {
  return `${getGoatAppUrl()}/api/integrations/x-account/callback`;
}

function basicAuthHeader() {
  const clientId = requiredEnv("GOAT_X_CLIENT_ID");
  const clientSecret = requiredEnv("GOAT_X_CLIENT_SECRET");
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`;
}

function toExpiresAt(expiresIn: number | undefined) {
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn)) return null;
  return new Date(Date.now() + expiresIn * 1000);
}

function isGoatXAccountIntegrationStatePayload(
  value: unknown,
): value is GoatXAccountIntegrationStatePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.userWorkosId === "string" &&
    typeof record.returnTo === "string" &&
    typeof record.expiresAt === "number" &&
    typeof record.nonce === "string"
  );
}

function sanitizeReturnTo(value: string) {
  if (!value.startsWith("/") || value.startsWith("//")) return "/settings";
  return value;
}

function signStateBody(body: string) {
  return createHmac("sha256", requiredEnv("GOAT_X_STATE_SECRET")).update(body).digest("base64url");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the Goat X integration.`);
  return value;
}
