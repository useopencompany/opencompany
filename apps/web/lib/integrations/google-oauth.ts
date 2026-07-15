import { createHmac, timingSafeEqual } from "node:crypto";
import { getAppUrl } from "@/lib/billing/stripe";

// Gmail, Google Calendar, and Google Drive are modeled as separate integrations that share a
// single Google OAuth client. They differ by the scopes they request and whether the callback syncs
// provider-specific resources. Everything Google-specific (scopes, endpoints, token shape) lives
// here; the DB persistence lives in google-service.ts and the route glue in google-routes.ts.

export type GoogleIntegrationProvider = "gmail" | "google_calendar" | "google_drive";

export type GoogleProviderConfig = {
  provider: GoogleIntegrationProvider;
  /** URL path segment, e.g. `/api/integrations/<routeSegment>/callback`. */
  routeSegment: string;
  displayName: string;
  scopes: string[];
  /** Calendar lists the account's calendars as resources; Gmail has none. */
  syncsCalendars: boolean;
};

const OPENID_SCOPES = ["openid", "email", "profile"];

export const GOOGLE_PROVIDER_CONFIG: Record<GoogleIntegrationProvider, GoogleProviderConfig> = {
  gmail: {
    provider: "gmail",
    routeSegment: "gmail",
    displayName: "Gmail",
    // Read-only: agents read mail, never send or modify.
    scopes: ["https://www.googleapis.com/auth/gmail.readonly", ...OPENID_SCOPES],
    syncsCalendars: false,
  },
  google_calendar: {
    provider: "google_calendar",
    routeSegment: "google-calendar",
    displayName: "Google Calendar",
    // Read + write: list/read events and create/update/delete them.
    scopes: [
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/calendar.events",
      ...OPENID_SCOPES,
    ],
    syncsCalendars: true,
  },
  google_drive: {
    provider: "google_drive",
    routeSegment: "google-drive",
    displayName: "Google Drive",
    // Use Drive's per-file scope in production. Full-drive scopes are restricted and can block
    // OAuth until Google finishes restricted-scope verification for the app.
    scopes: ["https://www.googleapis.com/auth/drive.file", ...OPENID_SCOPES],
    syncsCalendars: false,
  },
};

const GOOGLE_INTEGRATION_ENVS = [
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_INTEGRATION_STATE_SECRET",
  "INTEGRATION_CREDENTIAL_ENCRYPTION_KEY",
] as const;

export function isGoogleIntegrationConfigured() {
  return GOOGLE_INTEGRATION_ENVS.every((name) => Boolean(process.env[name]?.trim()));
}

// --- OAuth tokens ----------------------------------------------------------

export type GoogleOAuthTokens = {
  access_token: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  id_token?: string;
};

export type GoogleTokenExchangeResult = {
  tokens: GoogleOAuthTokens;
  /** Absolute expiry derived from the token endpoint's `expires_in`. */
  expiresAt: Date | null;
};

export type GoogleUserInfo = {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
};

export type GoogleCalendarSummary = {
  id: string;
  summary: string;
  primary: boolean;
  accessRole?: string;
  backgroundColor?: string;
};

// --- State -----------------------------------------------------------------

export type GoogleIntegrationStatePayload = {
  provider: GoogleIntegrationProvider;
  workspaceId: string;
  userId: string;
  returnTo: string;
  oauthRedirectUri?: string;
  targetOrigin?: string;
  expiresAt: number;
  nonce: string;
};

export function createGoogleIntegrationState(
  input: Omit<GoogleIntegrationStatePayload, "expiresAt" | "nonce">,
) {
  const { oauthRedirectUri: rawOauthRedirectUri, targetOrigin: rawTargetOrigin, ...rest } = input;
  const oauthRedirectUri = sanitizeGoogleOAuthRedirectUri(rawOauthRedirectUri, input.provider);
  const targetOrigin = sanitizeTargetOrigin(rawTargetOrigin);
  const payload: GoogleIntegrationStatePayload = {
    ...rest,
    returnTo: sanitizeReturnTo(input.returnTo),
    ...(oauthRedirectUri ? { oauthRedirectUri } : {}),
    ...(targetOrigin ? { targetOrigin } : {}),
    expiresAt: Date.now() + 10 * 60 * 1000,
    nonce: crypto.randomUUID(),
  };
  const body = base64Url(JSON.stringify(payload));
  return `${body}.${signStateBody(body)}`;
}

export function verifyGoogleIntegrationState(state: string): GoogleIntegrationStatePayload {
  const [body, signature] = state.split(".");
  if (!body || !signature) {
    throw new Error("Invalid Google integration state.");
  }
  if (!safeEqual(signature, signStateBody(body))) {
    throw new Error("Invalid Google integration state signature.");
  }

  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
  if (!isGoogleIntegrationStatePayload(payload)) {
    throw new Error("Invalid Google integration state payload.");
  }
  if (payload.expiresAt < Date.now()) {
    throw new Error("Google integration state expired.");
  }

  const { oauthRedirectUri: rawOauthRedirectUri, targetOrigin: rawTargetOrigin, ...rest } = payload;
  const oauthRedirectUri = sanitizeGoogleOAuthRedirectUri(rawOauthRedirectUri, payload.provider);
  const targetOrigin = sanitizeTargetOrigin(rawTargetOrigin);
  return {
    ...rest,
    returnTo: sanitizeReturnTo(payload.returnTo),
    ...(oauthRedirectUri ? { oauthRedirectUri } : {}),
    ...(targetOrigin ? { targetOrigin } : {}),
  };
}

export function verifyGoogleOAuthBrokerState(state: string) {
  const [body, signature] = state.split(".");
  if (!body || !signature || !safeEqual(signature, signStateBody(body))) {
    throw new Error("Invalid Google integration state.");
  }

  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
  if (!isGoogleOAuthBrokerStatePayload(payload)) {
    throw new Error("Invalid Google integration broker state payload.");
  }
  if (payload.expiresAt < Date.now()) {
    throw new Error("Google integration state expired.");
  }

  const targetOrigin =
    payload.targetOrigin === undefined ? undefined : sanitizeTargetOrigin(payload.targetOrigin);
  if (payload.targetOrigin !== undefined && !targetOrigin) {
    throw new Error("Invalid Google integration broker target origin.");
  }

  return {
    provider: payload.provider,
    returnTo: sanitizeReturnTo(payload.returnTo ?? "/company/integrations"),
    ...(targetOrigin ? { targetOrigin } : {}),
  };
}

// --- Authorization + token endpoints --------------------------------------

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
  // offline + consent guarantee a refresh_token on every connect; select_account lets a user
  // attach more than one Google account to the same integration.
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

export async function fetchGoogleCalendarList(
  accessToken: string,
): Promise<GoogleCalendarSummary[]> {
  const calendars: GoogleCalendarSummary[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL("https://www.googleapis.com/calendar/v3/users/me/calendarList");
    url.searchParams.set("maxResults", "250");
    url.searchParams.set("showHidden", "false");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) {
      throw new Error(`Google calendarList request failed with ${response.status}.`);
    }
    const result = (await response.json()) as {
      items?: Array<{
        id?: string;
        summary?: string;
        primary?: boolean;
        accessRole?: string;
        backgroundColor?: string;
      }>;
      nextPageToken?: string;
    };
    for (const item of result.items ?? []) {
      if (!item.id) continue;
      calendars.push({
        id: item.id,
        summary: item.summary ?? item.id,
        primary: item.primary ?? false,
        ...(item.accessRole ? { accessRole: item.accessRole } : {}),
        ...(item.backgroundColor ? { backgroundColor: item.backgroundColor } : {}),
      });
    }
    pageToken = result.nextPageToken;
  } while (pageToken);

  return calendars;
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
  return googleOAuthBrokerCallbackUrl() ?? googleDirectCallbackUrl(config);
}

export function googleDirectCallbackUrl(config: GoogleProviderConfig, origin = getAppUrl()) {
  return `${origin.replace(/\/$/, "")}/api/integrations/${config.routeSegment}/callback`;
}

export function googleOAuthBrokerCallbackUrl() {
  const value = process.env.GOOGLE_OAUTH_CALLBACK_URL?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && !isLocalhost(url)) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function googleOAuthTargetOriginForState() {
  if (!googleOAuthBrokerCallbackUrl()) return undefined;
  const targetOrigin = sanitizeTargetOrigin(getAppUrl());
  if (!targetOrigin) return undefined;
  return isPreviewGoogleOAuthTargetOrigin(targetOrigin) ? targetOrigin : undefined;
}

export function isAllowedGoogleOAuthTargetOrigin(targetOrigin: string) {
  const sanitized = sanitizeTargetOrigin(targetOrigin);
  if (!sanitized) return false;
  if (sanitized === new URL(getAppUrl()).origin) return true;
  if (isPreviewGoogleOAuthTargetOrigin(sanitized)) return true;
  if (isDevelopmentRuntime() && isLocalhost(new URL(sanitized))) return true;
  return false;
}

// --- internals -------------------------------------------------------------

function stripExpiry(tokens: GoogleOAuthTokens & { expires_in?: number }): GoogleOAuthTokens {
  const { access_token, refresh_token, scope, token_type, id_token } = tokens;
  return {
    access_token,
    ...(refresh_token ? { refresh_token } : {}),
    ...(scope ? { scope } : {}),
    ...(token_type ? { token_type } : {}),
    ...(id_token ? { id_token } : {}),
  };
}

function toExpiresAt(expiresIn?: number): Date | null {
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
    typeof record.workspaceId === "string" &&
    typeof record.userId === "string" &&
    typeof record.returnTo === "string" &&
    (record.oauthRedirectUri === undefined || typeof record.oauthRedirectUri === "string") &&
    (record.targetOrigin === undefined || typeof record.targetOrigin === "string") &&
    typeof record.expiresAt === "number" &&
    typeof record.nonce === "string"
  );
}

function isGoogleOAuthBrokerStatePayload(
  value: unknown,
): value is Pick<
  GoogleIntegrationStatePayload,
  "provider" | "targetOrigin" | "expiresAt" | "nonce"
> & { returnTo?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.provider === "gmail" ||
      record.provider === "google_calendar" ||
      record.provider === "google_drive") &&
    (record.returnTo === undefined || typeof record.returnTo === "string") &&
    (record.targetOrigin === undefined || typeof record.targetOrigin === "string") &&
    typeof record.expiresAt === "number" &&
    typeof record.nonce === "string"
  );
}

function sanitizeReturnTo(value: string) {
  if (!value.startsWith("/") || value.startsWith("//")) return "/company/integrations";
  return value;
}

function sanitizeTargetOrigin(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && !isLocalhost(url)) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function sanitizeGoogleOAuthRedirectUri(value: unknown, provider: GoogleIntegrationProvider) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.hash) url.hash = "";
    if (url.protocol !== "https:" && !isLocalhost(url)) return undefined;

    const config = GOOGLE_PROVIDER_CONFIG[provider];
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

function isPreviewGoogleOAuthTargetOrigin(origin: string) {
  return /^https:\/\/pr-\d+\.preview\.opencompany\.cloud$/.test(origin);
}

function isLocalhost(url: URL) {
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1")
  );
}

function isDevelopmentRuntime() {
  return process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";
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
    throw new Error(`${name} is required for Google integrations.`);
  }
  return value;
}

function base64Url(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}
