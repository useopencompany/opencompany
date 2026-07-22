import { getDb } from "@opencompany/db/client";
import {
  loadGoatIntegrationCredential,
  markGoatIntegrationStatus,
  refreshGoatIntegrationCredential,
} from "@opencompany/db/goat-integrations";
import type { GoatIntegrationProvider } from "@opencompany/db/goat-schema";

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REFRESH_SKEW_MS = 60_000;
const MAX_GOOGLE_ERROR_DETAIL_CHARS = 200;

type StoredGoogleTokens = {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
};

export type GoogleAccessConnection = {
  userWorkosId: string;
  integrationId: string;
  provider: GoatIntegrationProvider;
};

// Thrown when the stored Google credential cannot authenticate anymore. The
// integration row is already marked needs_reauth by the time this surfaces;
// callers translate it into their own reconnect guidance.
export class GoogleAccessAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleAccessAuthError";
  }
}

// Authenticated fetch against a Google API for one connected account: loads
// the stored token, refreshes when expired, retries once on 401 with a forced
// refresh, and marks the integration needs_reauth on hard auth failures.
export async function googleApiCall(
  connection: GoogleAccessConnection,
  method: string,
  url: URL,
  options?: { signal?: AbortSignal; body?: unknown },
): Promise<unknown> {
  const signal = options?.signal ?? null;
  const run = async (accessToken: string) =>
    fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(options?.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      signal,
      ...(options?.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });

  const tokenOptions = signal ? { signal } : {};
  let token = await getGoogleAccessToken(connection, tokenOptions);
  let response = await run(token);
  if (response.status === 401) {
    token = await getGoogleAccessToken(connection, { ...tokenOptions, forceRefresh: true });
    response = await run(token);
  }
  if (response.status === 204) return {};
  const text = await response.text();
  if (!response.ok) {
    if (response.status === 401 || isGooglePermissionError(response.status, text)) {
      await markGoogleNeedsReauth(connection, "Google rejected API access.");
      throw new GoogleAccessAuthError("Google rejected access for this account.");
    }
    const detail = googleApiErrorDetail(text);
    throw new Error(
      detail
        ? `Google API request failed with ${response.status}: ${detail}.`
        : `Google API request failed with ${response.status}.`,
    );
  }
  return text ? (JSON.parse(text) as unknown) : {};
}

export async function getGoogleAccessToken(
  connection: GoogleAccessConnection,
  options?: { signal?: AbortSignal; forceRefresh?: boolean },
): Promise<string> {
  const credential = await loadGoatIntegrationCredential({
    userWorkosId: connection.userWorkosId,
    integrationId: connection.integrationId,
    provider: connection.provider,
    kind: "oauth_token",
    db: getDb(),
  });
  if (!credential) {
    throw new GoogleAccessAuthError("No stored Google credentials for this account.");
  }
  const tokens = credential.payload as StoredGoogleTokens;
  const expired = credential.expiresAt
    ? credential.expiresAt.getTime() - REFRESH_SKEW_MS <= Date.now()
    : true;
  if (!options?.forceRefresh && !expired && tokens.access_token) return tokens.access_token;
  if (!tokens.refresh_token) {
    await markGoogleNeedsReauth(connection, "Stored Google credentials have no refresh token.");
    throw new GoogleAccessAuthError("Stored Google credentials have no refresh token.");
  }

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) throw new Error("Google OAuth is not configured.");
  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal: options?.signal ?? null,
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    if (response.status === 400 && detail.includes("invalid_grant")) {
      await markGoogleNeedsReauth(connection, "Google refused the refresh token.");
      throw new GoogleAccessAuthError("Google refused the refresh token.");
    }
    throw new Error(`Google token refresh failed with ${response.status}.`);
  }
  const refreshed = (await response.json()) as StoredGoogleTokens & { expires_in?: number };
  if (!refreshed.access_token) throw new Error("Google token refresh returned no access token.");
  const nextTokens: StoredGoogleTokens = {
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token ?? tokens.refresh_token,
    ...((refreshed.scope ?? tokens.scope) ? { scope: refreshed.scope ?? tokens.scope } : {}),
    ...((refreshed.token_type ?? tokens.token_type)
      ? { token_type: refreshed.token_type ?? tokens.token_type }
      : {}),
  };
  await refreshGoatIntegrationCredential({
    userWorkosId: connection.userWorkosId,
    integrationId: connection.integrationId,
    provider: connection.provider,
    kind: "oauth_token",
    payload: Object.fromEntries(
      Object.entries(nextTokens).filter(([, value]) => value !== undefined),
    ),
    expiresAt:
      typeof refreshed.expires_in === "number"
        ? new Date(Date.now() + refreshed.expires_in * 1_000)
        : null,
    db: getDb(),
  });
  return refreshed.access_token;
}

async function markGoogleNeedsReauth(connection: GoogleAccessConnection, reason: string) {
  await markGoatIntegrationStatus({
    userWorkosId: connection.userWorkosId,
    integrationId: connection.integrationId,
    provider: connection.provider,
    status: "needs_reauth",
    statusReason: reason,
    db: getDb(),
  });
}

function isGooglePermissionError(status: number, body: string) {
  return (
    status === 403 &&
    (body.includes("insufficientPermissions") || body.includes("insufficient_scope"))
  );
}

function googleApiErrorDetail(body: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
  const root = asRecord(parsed);
  const error = asRecord(root?.error);
  const message = boundedErrorString(error?.message);
  const firstError = Array.isArray(error?.errors) ? asRecord(error.errors[0]) : null;
  const reason = boundedErrorString(firstError?.reason);
  const status = boundedErrorString(error?.status);
  const parts = [message, reason, status].filter(
    (value, index, values): value is string =>
      Boolean(value) &&
      values.findIndex((candidate) => candidate?.toLowerCase() === value?.toLowerCase()) === index,
  );
  if (parts.length === 0) return undefined;
  const detail = parts.length === 1 ? parts[0]! : `${parts[0]} (${parts.slice(1).join(", ")})`;
  return truncateErrorDetail(detail.replace(/[.\s]+$/g, ""));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedErrorString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? truncateErrorDetail(normalized) : undefined;
}

function truncateErrorDetail(value: string) {
  return value.length > MAX_GOOGLE_ERROR_DETAIL_CHARS
    ? `${value.slice(0, MAX_GOOGLE_ERROR_DETAIL_CHARS - 1)}…`
    : value;
}
