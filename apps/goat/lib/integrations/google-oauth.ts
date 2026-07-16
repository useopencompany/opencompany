import { createHmac, timingSafeEqual } from "node:crypto";
import type { GoatIntegrationProvider } from "@opencompany/db/goat-schema";
import { getGoatAppUrl } from "@/lib/workos";

export type GoatGoogleIntegrationProvider = Extract<
  GoatIntegrationProvider,
  "gmail" | "google_calendar" | "google_drive"
>;

export type GoatGoogleProviderConfig = {
  provider: GoatGoogleIntegrationProvider;
  routeSegment: string;
  displayName: string;
  scopes: string[];
};

const OPENID_SCOPES = ["openid", "email", "profile"];

export const GOAT_GOOGLE_PROVIDER_CONFIG: Record<
  GoatGoogleIntegrationProvider,
  GoatGoogleProviderConfig
> = {
  gmail: {
    provider: "gmail",
    routeSegment: "gmail",
    displayName: "Gmail",
    scopes: ["https://www.googleapis.com/auth/gmail.readonly", ...OPENID_SCOPES],
  },
  google_calendar: {
    provider: "google_calendar",
    routeSegment: "google-calendar",
    displayName: "Google Calendar",
    scopes: [
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/calendar.events.readonly",
      "https://www.googleapis.com/auth/calendar.freebusy",
      ...OPENID_SCOPES,
    ],
  },
  google_drive: {
    provider: "google_drive",
    routeSegment: "google-drive",
    displayName: "Google Drive",
    scopes: ["https://www.googleapis.com/auth/drive.readonly", ...OPENID_SCOPES],
  },
};

const GOOGLE_INTEGRATION_ENVS = [
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_INTEGRATION_STATE_SECRET",
  "INTEGRATION_CREDENTIAL_ENCRYPTION_KEY",
] as const;

export type GoatGoogleOAuthTokens = {
  access_token: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  id_token?: string;
};

export type GoatGoogleTokenExchangeResult = {
  tokens: GoatGoogleOAuthTokens;
  expiresAt: Date | null;
};

export type GoatGoogleUserInfo = {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
};

export type GoatGoogleIntegrationStatePayload = {
  provider: GoatGoogleIntegrationProvider;
  userWorkosId: string;
  returnTo: string;
  oauthRedirectUri?: string;
  targetOrigin?: string;
  expiresAt: number;
  nonce: string;
};

export function isGoatGoogleIntegrationConfigured() {
  return GOOGLE_INTEGRATION_ENVS.every((name) => Boolean(process.env[name]?.trim()));
}

export function createGoatGoogleIntegrationState(
  input: Omit<GoatGoogleIntegrationStatePayload, "expiresAt" | "nonce">,
) {
  const oauthRedirectUri = sanitizeGoatGoogleOAuthRedirectUri(
    input.oauthRedirectUri,
    input.provider,
  );
  const targetOrigin = sanitizeTargetOrigin(input.targetOrigin);
  const payload: GoatGoogleIntegrationStatePayload = {
    provider: input.provider,
    userWorkosId: input.userWorkosId,
    returnTo: sanitizeReturnTo(input.returnTo),
    ...(oauthRedirectUri ? { oauthRedirectUri } : {}),
    ...(targetOrigin ? { targetOrigin } : {}),
    expiresAt: Date.now() + 10 * 60 * 1000,
    nonce: crypto.randomUUID(),
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${signStateBody(body)}`;
}

export function verifyGoatGoogleIntegrationState(state: string): GoatGoogleIntegrationStatePayload {
  const [body, signature] = state.split(".");
  if (!body || !signature || !safeEqual(signature, signStateBody(body))) {
    throw new Error("Invalid Google integration state.");
  }

  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
  if (!isGoatGoogleIntegrationStatePayload(payload)) {
    throw new Error("Invalid Google integration state payload.");
  }
  if (payload.expiresAt < Date.now()) {
    throw new Error("Google integration state expired.");
  }

  const oauthRedirectUri = sanitizeGoatGoogleOAuthRedirectUri(
    payload.oauthRedirectUri,
    payload.provider,
  );
  const targetOrigin = sanitizeTargetOrigin(payload.targetOrigin);
  return {
    provider: payload.provider,
    userWorkosId: payload.userWorkosId,
    returnTo: sanitizeReturnTo(payload.returnTo),
    ...(oauthRedirectUri ? { oauthRedirectUri } : {}),
    ...(targetOrigin ? { targetOrigin } : {}),
    expiresAt: payload.expiresAt,
    nonce: payload.nonce,
  };
}

export function buildGoatGoogleAuthorizationUrl(
  config: GoatGoogleProviderConfig,
  state: string,
  redirectUri = goatGoogleOAuthRedirectUri(config),
) {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", requiredEnv("GOOGLE_OAUTH_CLIENT_ID"));
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", config.scopes.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "select_account consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeGoatGoogleCode(
  config: GoatGoogleProviderConfig,
  code: string,
  redirectUri = goatGoogleOAuthRedirectUri(config),
): Promise<GoatGoogleTokenExchangeResult> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: requiredEnv("GOOGLE_OAUTH_CLIENT_ID"),
      client_secret: requiredEnv("GOOGLE_OAUTH_CLIENT_SECRET"),
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Google token exchange failed with ${response.status}: ${await response.text()}`,
    );
  }

  const result = (await response.json()) as GoatGoogleOAuthTokens & { expires_in?: number };
  if (!result.access_token) {
    throw new Error("Google did not return an access token.");
  }

  return { tokens: stripExpiry(result), expiresAt: toExpiresAt(result.expires_in) };
}

export async function fetchGoatGoogleUserInfo(accessToken: string): Promise<GoatGoogleUserInfo> {
  const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Google userinfo request failed with ${response.status}.`);
  }
  const result = (await response.json()) as Partial<GoatGoogleUserInfo>;
  if (!result.sub) {
    throw new Error("Google userinfo did not include an account id.");
  }
  return {
    sub: result.sub,
    ...(result.email ? { email: result.email } : {}),
    ...(result.name ? { name: result.name } : {}),
    ...(result.picture ? { picture: result.picture } : {}),
  };
}

export function appendGoatGoogleIntegrationStatus(
  returnTo: string,
  provider: GoatGoogleIntegrationProvider,
  status: "connected" | "error",
) {
  const url = new URL(sanitizeReturnTo(returnTo), getGoatAppUrl());
  url.searchParams.set("integration", provider);
  url.searchParams.set("setup", status);
  return `${url.pathname}${url.search}`;
}

export function goatGoogleOAuthRedirectUri(config: GoatGoogleProviderConfig) {
  const brokerCallbackUrl = goatGoogleOAuthBrokerCallbackUrl();
  if (brokerCallbackUrl && isPreviewGoogleOAuthTargetOrigin(getGoatAppUrl())) {
    return brokerCallbackUrl;
  }
  return goatGoogleDirectCallbackUrl(config);
}

export function goatGoogleOAuthTargetOriginForState() {
  if (!goatGoogleOAuthBrokerCallbackUrl()) return undefined;
  const targetOrigin = sanitizeTargetOrigin(getGoatAppUrl());
  return targetOrigin && isPreviewGoogleOAuthTargetOrigin(targetOrigin) ? targetOrigin : undefined;
}

export function goatGoogleDirectCallbackUrl(
  config: GoatGoogleProviderConfig,
  origin = getGoatAppUrl(),
) {
  return `${origin.replace(/\/$/, "")}/api/integrations/${config.routeSegment}/callback`;
}

function stripExpiry(tokens: GoatGoogleOAuthTokens & { expires_in?: number }) {
  const { access_token, refresh_token, scope, token_type, id_token } = tokens;
  return {
    access_token,
    ...(refresh_token ? { refresh_token } : {}),
    ...(scope ? { scope } : {}),
    ...(token_type ? { token_type } : {}),
    ...(id_token ? { id_token } : {}),
  };
}

function toExpiresAt(expiresIn?: number) {
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn)) return null;
  return new Date(Date.now() + expiresIn * 1000);
}

function isGoatGoogleIntegrationStatePayload(
  value: unknown,
): value is GoatGoogleIntegrationStatePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.provider === "gmail" ||
      record.provider === "google_calendar" ||
      record.provider === "google_drive") &&
    typeof record.userWorkosId === "string" &&
    typeof record.returnTo === "string" &&
    (record.oauthRedirectUri === undefined || typeof record.oauthRedirectUri === "string") &&
    (record.targetOrigin === undefined || typeof record.targetOrigin === "string") &&
    typeof record.expiresAt === "number" &&
    typeof record.nonce === "string"
  );
}

function sanitizeReturnTo(value: string) {
  if (!value.startsWith("/") || value.startsWith("//")) return "/settings";
  return value;
}

function goatGoogleOAuthBrokerCallbackUrl() {
  const value = process.env.GOOGLE_OAUTH_CALLBACK_URL?.trim();
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && !isLocalhost(url)) return undefined;
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function sanitizeTargetOrigin(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    const origin = url.origin;
    if (isPreviewGoogleOAuthTargetOrigin(origin) || isLocalhost(url)) return origin;
    return undefined;
  } catch {
    return undefined;
  }
}

function isPreviewGoogleOAuthTargetOrigin(origin: string) {
  return /^https:\/\/pr-\d+\.preview\.opencompany\.cloud$/.test(origin);
}

function sanitizeGoatGoogleOAuthRedirectUri(
  value: unknown,
  provider: GoatGoogleIntegrationProvider,
) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.hash) url.hash = "";
    if (url.protocol !== "https:" && !isLocalhost(url)) return undefined;

    const config = GOAT_GOOGLE_PROVIDER_CONFIG[provider];
    if (
      url.pathname === "/api/google/callback" ||
      url.pathname === `/api/integrations/${config.routeSegment}/callback`
    ) {
      return url.toString();
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function isLocalhost(url: URL) {
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1")
  );
}

function signStateBody(body: string) {
  return createHmac("sha256", requiredEnv("GOOGLE_INTEGRATION_STATE_SECRET"))
    .update(body)
    .digest("base64url");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for Goat Google integrations.`);
  }
  return value;
}
