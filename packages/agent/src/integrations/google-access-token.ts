import { getDb } from "@opencompany/db/client";
import { markIntegrationStatus } from "@opencompany/db/integrations";
import type { IntegrationProvider } from "@opencompany/db/product-schema";
import {
  ExpiringOAuthReauthRequired,
  getExpiringOAuthAccessToken,
} from "./expiring-oauth-access-token";

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
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
  provider: IntegrationProvider;
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

// Thrown when a download would exceed the caller's byte ceiling, either from the
// declared Content-Length or once the streamed body crosses it mid-download.
export class GoogleDownloadLimitError extends Error {
  readonly limitBytes: number;

  constructor(limitBytes: number) {
    super(`Download exceeds the ${Math.floor(limitBytes / (1024 * 1024))} MB limit.`);
    this.name = "GoogleDownloadLimitError";
    this.limitBytes = limitBytes;
  }
}

// Authenticated binary download for one connected account. Shares googleApiCall's
// token refresh, single 401 retry, and needs_reauth handling, but returns the raw
// bytes and enforces `maxBytes` both from the declared length and while streaming.
// Bytes are held only in memory and never logged.
export async function googleApiDownload(
  connection: GoogleAccessConnection,
  url: URL,
  options: { signal?: AbortSignal; maxBytes: number },
): Promise<{ bytes: Buffer; contentType: string | null }> {
  const signal = options.signal ?? null;
  const run = async (accessToken: string) =>
    fetch(url, { method: "GET", headers: { Authorization: `Bearer ${accessToken}` }, signal });

  const tokenOptions = signal ? { signal } : {};
  let token = await getGoogleAccessToken(connection, tokenOptions);
  let response = await run(token);
  if (response.status === 401) {
    token = await getGoogleAccessToken(connection, { ...tokenOptions, forceRefresh: true });
    response = await run(token);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
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

  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes) {
    throw new GoogleDownloadLimitError(options.maxBytes);
  }
  const bytes = await readBoundedBody(response, options.maxBytes);
  return { bytes, contentType: response.headers.get("content-type") };
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Buffer> {
  const body = response.body;
  if (!body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) throw new GoogleDownloadLimitError(maxBytes);
    return buffer;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new GoogleDownloadLimitError(maxBytes);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function getGoogleAccessToken(
  connection: GoogleAccessConnection,
  options?: { signal?: AbortSignal; forceRefresh?: boolean },
): Promise<string> {
  return getExpiringOAuthAccessToken({
    connection,
    displayName: "Google",
    parseCredential: parseGoogleCredential,
    refresh: refreshGoogleCredential,
    createAuthError: (message) => new GoogleAccessAuthError(message),
    missingCredential: {
      message: "No stored Google credentials for this account.",
      statusReason: "Stored Google credentials are missing.",
    },
    invalidCredential: {
      message: "Stored Google credentials are invalid.",
      statusReason: "Stored Google credentials are invalid.",
    },
    ...(options ? { options } : {}),
  });
}

function parseGoogleCredential(payload: Record<string, unknown>) {
  const accessToken = typeof payload.access_token === "string" ? payload.access_token.trim() : "";
  if (!accessToken) return null;
  const tokens = payload as StoredGoogleTokens;
  return {
    accessToken,
    refreshToken: tokens.refresh_token?.trim() || null,
    payload: tokens,
  };
}

async function refreshGoogleCredential(
  credential: {
    accessToken: string;
    refreshToken: string | null;
    payload: StoredGoogleTokens;
  },
  context: { now: Date; signal?: AbortSignal },
) {
  const refreshToken = credential.refreshToken;
  if (!refreshToken) {
    throw new ExpiringOAuthReauthRequired(
      "Stored Google credentials have no refresh token.",
      "Stored Google credentials have no refresh token.",
    );
  }
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) throw new Error("Google OAuth is not configured.");
  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal: context.signal ?? null,
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    if (response.status === 400 && detail.includes("invalid_grant")) {
      throw new ExpiringOAuthReauthRequired(
        "Google refused the refresh token.",
        "Google refused the refresh token.",
      );
    }
    throw new Error(`Google token refresh failed with ${response.status}.`);
  }
  const refreshed = (await response.json()) as StoredGoogleTokens & { expires_in?: number };
  if (!refreshed.access_token) throw new Error("Google token refresh returned no access token.");
  const nextTokens: StoredGoogleTokens = {
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token ?? refreshToken,
    ...((refreshed.scope ?? credential.payload.scope)
      ? { scope: refreshed.scope ?? credential.payload.scope }
      : {}),
    ...((refreshed.token_type ?? credential.payload.token_type)
      ? { token_type: refreshed.token_type ?? credential.payload.token_type }
      : {}),
  };
  return {
    accessToken: refreshed.access_token,
    payload: Object.fromEntries(
      Object.entries(nextTokens).filter(([, value]) => value !== undefined),
    ),
    expiresAt:
      typeof refreshed.expires_in === "number"
        ? new Date(context.now.getTime() + refreshed.expires_in * 1_000)
        : null,
  };
}

async function markGoogleNeedsReauth(connection: GoogleAccessConnection, reason: string) {
  await markIntegrationStatus({
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
