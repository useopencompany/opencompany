import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { getDb } from "@opencompany/db/client";
import {
  loadGoatIntegrationCredential,
  markGoatIntegrationStatus,
  refreshGoatIntegrationCredential,
} from "@opencompany/db/goat-integrations";
import { goatIntegrations } from "@opencompany/db/goat-schema";
import { and, desc, eq, isNull } from "drizzle-orm";
import { getGoatAppUrl } from "../app-url";
import type { GoatXProviderState } from "../integration-state";

const X_PROVIDER = "x" as const;
const X_TOKEN_ENDPOINT = "https://api.x.com/2/oauth2/token";
const X_API_BASE = "https://api.x.com/2";
const REFRESH_SKEW_MS = 60_000;
const GOAT_X_INTEGRATION_ENVS = [
  "GOAT_X_CLIENT_ID",
  "GOAT_X_CLIENT_SECRET",
  "GOAT_X_STATE_SECRET",
] as const;

export const GOAT_X_SCOPES = ["tweet.read", "tweet.write", "users.read", "offline.access"] as const;

export type GoatXIntegrationStatePayload = {
  userWorkosId: string;
  returnTo: string;
  expiresAt: number;
  nonce: string;
};

export type GoatXAuthorizationStart = {
  signedState: string;
  codeVerifier: string;
};

export type GoatXOAuthResult = {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  expiresAt: Date | null;
  scopes: string[];
};

export type GoatXUserIdentity = {
  id: string;
  username: string;
  name: string | null;
};

type StoredXTokens = {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
};

export class XAccessAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XAccessAuthError";
  }
}

export function isGoatXIntegrationConfigured() {
  return GOAT_X_INTEGRATION_ENVS.every((name) => Boolean(process.env[name]?.trim()));
}

export async function getGoatXIntegrationState(userWorkosId: string): Promise<GoatXProviderState> {
  const [row] = await getDb()
    .select({
      id: goatIntegrations.id,
      status: goatIntegrations.status,
      connectionLabel: goatIntegrations.connectionLabel,
      accountName: goatIntegrations.accountName,
      statusReason: goatIntegrations.statusReason,
    })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.userWorkosId, userWorkosId),
        eq(goatIntegrations.provider, "x"),
        isNull(goatIntegrations.workspaceId),
      ),
    )
    .orderBy(desc(goatIntegrations.updatedAt))
    .limit(1);

  if (!row || row.status === "disconnected") {
    return {
      provider: "x",
      connected: false,
      status: "not_connected",
      integrationId: null,
      username: null,
      displayName: null,
      statusReason: null,
    };
  }

  return {
    provider: "x",
    connected: row.status === "connected",
    status: row.status,
    integrationId: row.id,
    username: row.connectionLabel,
    displayName: row.accountName,
    statusReason: row.statusReason,
  };
}

export function createGoatXIntegrationState(
  input: Omit<GoatXIntegrationStatePayload, "expiresAt" | "nonce">,
): GoatXAuthorizationStart {
  const codeVerifier = randomBytes(32).toString("base64url");
  const payload: GoatXIntegrationStatePayload = {
    ...input,
    returnTo: sanitizeReturnTo(input.returnTo),
    expiresAt: Date.now() + 10 * 60 * 1000,
    nonce: randomUUID(),
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return { signedState: `${body}.${signStateBody(body)}`, codeVerifier };
}

export function verifyGoatXIntegrationState(state: string): GoatXIntegrationStatePayload {
  const [body, signature] = state.split(".");
  if (!body || !signature || !safeEqual(signature, signStateBody(body))) {
    throw new Error("Invalid X integration state.");
  }
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
  if (!isGoatXIntegrationStatePayload(payload)) {
    throw new Error("Invalid X integration state payload.");
  }
  if (payload.expiresAt < Date.now()) {
    throw new Error("X integration state expired.");
  }
  return { ...payload, returnTo: sanitizeReturnTo(payload.returnTo) };
}

export function buildGoatXAuthorizationUrl(input: GoatXAuthorizationStart) {
  const url = new URL("https://x.com/i/oauth2/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", requiredEnv("GOAT_X_CLIENT_ID"));
  url.searchParams.set("redirect_uri", goatXCallbackUrl());
  url.searchParams.set("scope", GOAT_X_SCOPES.join(" "));
  url.searchParams.set("state", input.signedState);
  url.searchParams.set("code_challenge", codeChallenge(input.codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function exchangeGoatXCode(input: {
  code: string;
  codeVerifier: string;
}): Promise<GoatXOAuthResult> {
  const response = await fetch(X_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: xBasicAuthHeader(),
    },
    body: new URLSearchParams({
      code: input.code,
      grant_type: "authorization_code",
      redirect_uri: goatXCallbackUrl(),
      code_verifier: input.codeVerifier,
    }),
  });
  if (!response.ok) throw new Error(`X token exchange failed with ${response.status}.`);
  const result = (await response.json()) as StoredXTokens & { expires_in?: number };
  if (!result.access_token) throw new Error("X did not return an access token.");
  return {
    accessToken: result.access_token,
    ...(result.refresh_token ? { refreshToken: result.refresh_token } : {}),
    ...(result.token_type ? { tokenType: result.token_type } : {}),
    expiresAt: toExpiresAt(result.expires_in),
    scopes: splitScopes(result.scope, GOAT_X_SCOPES),
  };
}

export async function fetchGoatXIdentity(accessToken: string): Promise<GoatXUserIdentity> {
  const result = (await xApiFetch({ accessToken, path: "/users/me" })) as {
    data?: { id?: string; username?: string; name?: string };
  };
  const id = result.data?.id?.trim();
  const username = result.data?.username?.trim();
  if (!id || !username) throw new Error("X user lookup did not return an account id.");
  return {
    id,
    username,
    name: result.data?.name?.trim() || null,
  };
}

export async function xApiCall(input: {
  userWorkosId: string;
  integrationId: string;
  path: string;
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
}): Promise<unknown> {
  let accessToken = await getXAccessToken(input);
  try {
    return await xApiFetch({
      accessToken,
      path: input.path,
      ...(input.method ? { method: input.method } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (error) {
    if (!(error instanceof XAccessAuthError)) throw error;
    accessToken = await getXAccessToken({ ...input, forceRefresh: true });
    return xApiFetch({
      accessToken,
      path: input.path,
      ...(input.method ? { method: input.method } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }
}

export function appendGoatXIntegrationStatus(
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

async function getXAccessToken(input: {
  userWorkosId: string;
  integrationId: string;
  signal?: AbortSignal;
  forceRefresh?: boolean;
}) {
  const credential = await loadGoatIntegrationCredential({
    userWorkosId: input.userWorkosId,
    integrationId: input.integrationId,
    provider: X_PROVIDER,
    kind: "oauth_token",
    db: getDb(),
  });
  if (!credential) throw new XAccessAuthError("No stored X credentials for this account.");
  const tokens = credential.payload as StoredXTokens;
  const expired = credential.expiresAt
    ? credential.expiresAt.getTime() - REFRESH_SKEW_MS <= Date.now()
    : true;
  if (!input.forceRefresh && !expired && tokens.access_token) return tokens.access_token;
  if (!tokens.refresh_token) {
    await markXNeedsReauth(input, "Stored X credentials have no refresh token.");
    throw new XAccessAuthError("Stored X credentials have no refresh token.");
  }

  const response = await fetch(X_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: xBasicAuthHeader(),
    },
    signal: input.signal ?? null,
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    }),
  });
  if (!response.ok) {
    await markXNeedsReauth(input, "X refused the refresh token.");
    throw new XAccessAuthError("X refused the refresh token.");
  }
  const refreshed = (await response.json()) as StoredXTokens & { expires_in?: number };
  if (!refreshed.access_token) throw new Error("X token refresh returned no access token.");
  const nextTokens: StoredXTokens = {
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token ?? tokens.refresh_token,
    ...((refreshed.scope ?? tokens.scope) ? { scope: refreshed.scope ?? tokens.scope } : {}),
    ...((refreshed.token_type ?? tokens.token_type)
      ? { token_type: refreshed.token_type ?? tokens.token_type }
      : {}),
  };
  await refreshGoatIntegrationCredential({
    userWorkosId: input.userWorkosId,
    integrationId: input.integrationId,
    provider: X_PROVIDER,
    kind: "oauth_token",
    payload: nextTokens,
    expiresAt: toExpiresAt(refreshed.expires_in),
    db: getDb(),
  });
  return refreshed.access_token;
}

async function xApiFetch(input: {
  accessToken: string;
  path: string;
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
}) {
  const response = await fetch(`${X_API_BASE}${input.path}`, {
    method: input.method ?? "GET",
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      ...(input.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    signal: input.signal ?? null,
    ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
  });
  const text = await response.text();
  if (!response.ok) {
    if (response.status === 401) {
      throw new XAccessAuthError("X rejected access for this account.");
    }
    throw new Error(xApiErrorMessage(response.status, text));
  }
  return text ? (JSON.parse(text) as unknown) : {};
}

async function markXNeedsReauth(
  input: { userWorkosId: string; integrationId: string },
  reason: string,
) {
  await markGoatIntegrationStatus({
    userWorkosId: input.userWorkosId,
    integrationId: input.integrationId,
    provider: X_PROVIDER,
    status: "needs_reauth",
    statusReason: reason,
    db: getDb(),
  });
}

function codeChallenge(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

function xBasicAuthHeader() {
  return `Basic ${Buffer.from(`${requiredEnv("GOAT_X_CLIENT_ID")}:${requiredEnv("GOAT_X_CLIENT_SECRET")}`).toString("base64")}`;
}

function goatXCallbackUrl() {
  return `${getGoatAppUrl()}/api/integrations/x/callback`;
}

function splitScopes(value: string | undefined, fallback: readonly string[] = []) {
  const scopes = (value ?? "")
    .split(/[,\s]+/g)
    .map((scope) => scope.trim())
    .filter(Boolean);
  return scopes.length > 0 ? scopes : [...fallback];
}

function toExpiresAt(expiresIn: unknown): Date | null {
  return typeof expiresIn === "number" ? new Date(Date.now() + expiresIn * 1_000) : null;
}

function xApiErrorMessage(status: number, body: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return `X API request failed with ${status}.`;
  }
  const detail =
    typeof parsed === "object" && parsed && "detail" in parsed && typeof parsed.detail === "string"
      ? parsed.detail
      : undefined;
  return detail
    ? `X API request failed with ${status}: ${detail.slice(0, 200)}.`
    : `X API request failed with ${status}.`;
}

function isGoatXIntegrationStatePayload(value: unknown): value is GoatXIntegrationStatePayload {
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
  if (!value) throw new Error(`${name} is required for Goat X integration.`);
  return value;
}
