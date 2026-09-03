import { createHmac, timingSafeEqual } from "node:crypto";
import type { IntegrationProvider } from "@opencompany/db/product-schema";
import { getAppUrl } from "../app-url";
import { GMAIL_COMPOSE_SCOPE, GMAIL_READ_SCOPE } from "./gmail-scopes";
import { GOOGLE_CALENDAR_EVENTS_SCOPE, GOOGLE_CALENDAR_READ_SCOPE } from "./google-calendar-scopes";
import {
  GOOGLE_DOCS_WRITE_SCOPE,
  GOOGLE_DRIVE_READ_SCOPE,
  GOOGLE_SHEETS_WRITE_SCOPE,
} from "./google-drive-scopes";

export type GoogleIntegrationProvider = Extract<
  IntegrationProvider,
  "gmail" | "google_calendar" | "google_drive"
>;

export type GoogleProviderConfig = {
  provider: GoogleIntegrationProvider;
  routeSegment: string;
  displayName: string;
  scopes: string[];
};

const OPENID_SCOPES = ["openid", "email", "profile"];

export const GOOGLE_PROVIDER_CONFIG: Record<GoogleIntegrationProvider, GoogleProviderConfig> = {
  gmail: {
    provider: "gmail",
    routeSegment: "gmail",
    displayName: "Gmail",
    // gmail.compose is the narrowest Gmail API scope that can create drafts.
    // It also authorizes sending, which opencompany gates separately in its own
    // per-account permission model.
    scopes: [GMAIL_READ_SCOPE, GMAIL_COMPOSE_SCOPE, ...OPENID_SCOPES],
  },
  google_calendar: {
    provider: "google_calendar",
    routeSegment: "google-calendar",
    displayName: "Google Calendar",
    scopes: [
      GOOGLE_CALENDAR_READ_SCOPE,
      GOOGLE_CALENDAR_EVENTS_SCOPE,
      "https://www.googleapis.com/auth/calendar.freebusy",
      ...OPENID_SCOPES,
    ],
  },
  google_drive: {
    provider: "google_drive",
    routeSegment: "google-drive",
    displayName: "Google Drive",
    scopes: [
      GOOGLE_DRIVE_READ_SCOPE,
      GOOGLE_DOCS_WRITE_SCOPE,
      GOOGLE_SHEETS_WRITE_SCOPE,
      ...OPENID_SCOPES,
    ],
  },
};

const GOOGLE_INTEGRATION_ENVS = [
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_INTEGRATION_STATE_SECRET",
  "INTEGRATION_CREDENTIAL_ENCRYPTION_KEY",
] as const;

export type GoogleOAuthTokens = {
  access_token: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  id_token?: string;
};

export type GoogleTokenExchangeResult = {
  tokens: GoogleOAuthTokens;
  expiresAt: Date | null;
};

export type GoogleUserInfo = {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
};

export type GoogleIntegrationStatePayload = {
  provider: GoogleIntegrationProvider;
  userWorkosId: string;
  returnTo: string;
  expiresAt: number;
  nonce: string;
};

export function isGoogleIntegrationConfigured() {
  return GOOGLE_INTEGRATION_ENVS.every((name) => Boolean(process.env[name]?.trim()));
}

export function createGoogleIntegrationState(
  input: Omit<GoogleIntegrationStatePayload, "expiresAt" | "nonce">,
) {
  const payload: GoogleIntegrationStatePayload = {
    provider: input.provider,
    userWorkosId: input.userWorkosId,
    returnTo: sanitizeReturnTo(input.returnTo),
    expiresAt: Date.now() + 10 * 60 * 1000,
    nonce: crypto.randomUUID(),
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${signStateBody(body)}`;
}

export function verifyGoogleIntegrationState(state: string): GoogleIntegrationStatePayload {
  const [body, signature] = state.split(".");
  if (!body || !signature || !safeEqual(signature, signStateBody(body))) {
    throw new Error("Invalid Google integration state.");
  }

  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
  if (!isGoogleIntegrationStatePayload(payload)) {
    throw new Error("Invalid Google integration state payload.");
  }
  if (payload.expiresAt < Date.now()) {
    throw new Error("Google integration state expired.");
  }

  return {
    provider: payload.provider,
    userWorkosId: payload.userWorkosId,
    returnTo: sanitizeReturnTo(payload.returnTo),
    expiresAt: payload.expiresAt,
    nonce: payload.nonce,
  };
}

export function buildGoogleAuthorizationUrl(
  config: GoogleProviderConfig,
  state: string,
  redirectUri = googleOAuthRedirectUri(config),
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

export async function exchangeGoogleCode(
  config: GoogleProviderConfig,
  code: string,
  redirectUri = googleOAuthRedirectUri(config),
): Promise<GoogleTokenExchangeResult> {
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

  const result = (await response.json()) as GoogleOAuthTokens & { expires_in?: number };
  if (!result.access_token) {
    throw new Error("Google did not return an access token.");
  }

  return { tokens: stripExpiry(result), expiresAt: toExpiresAt(result.expires_in) };
}

export async function fetchGoogleUserInfo(accessToken: string): Promise<GoogleUserInfo> {
  const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Google userinfo request failed with ${response.status}.`);
  }
  const result = (await response.json()) as Partial<GoogleUserInfo>;
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

export function appendGoogleIntegrationStatus(
  returnTo: string,
  provider: GoogleIntegrationProvider,
  status: "connected" | "error",
) {
  const url = new URL(sanitizeReturnTo(returnTo), getAppUrl());
  url.searchParams.set("integration", provider);
  url.searchParams.set("setup", status);
  return `${url.pathname}${url.search}`;
}

export function googleOAuthRedirectUri(config: GoogleProviderConfig) {
  return googleDirectCallbackUrl(config);
}

export function googleDirectCallbackUrl(config: GoogleProviderConfig, origin = getAppUrl()) {
  return `${origin.replace(/\/$/, "")}/api/integrations/${config.routeSegment}/callback`;
}

function stripExpiry(tokens: GoogleOAuthTokens & { expires_in?: number }) {
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

function isGoogleIntegrationStatePayload(value: unknown): value is GoogleIntegrationStatePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.provider === "gmail" ||
      record.provider === "google_calendar" ||
      record.provider === "google_drive") &&
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
    throw new Error(`${name} is required for opencompany Google integrations.`);
  }
  return value;
}
