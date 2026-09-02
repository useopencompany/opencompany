import { getDb } from "@opencompany/db/client";
import { markIntegrationStatus } from "@opencompany/db/integrations";
import {
  ExpiringOAuthReauthRequired,
  getExpiringOAuthAccessToken,
} from "./expiring-oauth-access-token";

const X_TOKEN_ENDPOINT = "https://api.x.com/2/oauth2/token";

type StoredXTokens = {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
};

export type XAccessConnection = {
  userWorkosId: string;
  integrationId: string;
};

// Thrown when the stored X credential cannot authenticate anymore. The
// integration row is already marked needs_reauth by the time this surfaces;
// callers translate it into their own reconnect guidance.
export class XAccessAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XAccessAuthError";
  }
}

// Authenticated fetch against the X API for one connected account: loads the
// stored token, refreshes when expired, retries once on 401 with a forced
// refresh, and marks the integration needs_reauth on hard auth failures.
export async function xAccountApiCall(
  connection: XAccessConnection,
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
  let token = await getXAccessToken(connection, tokenOptions);
  let response = await run(token);
  if (response.status === 401) {
    token = await getXAccessToken(connection, { ...tokenOptions, forceRefresh: true });
    response = await run(token);
  }
  const text = await response.text();
  if (!response.ok) {
    // Only 401 (after a forced refresh already failed) means the credential
    // itself is bad. 403 from X's write endpoints is commonly unrelated to
    // auth — duplicate content, a suspended/restricted account, or app-level
    // policy — and must not force an unnecessary reconnect.
    if (response.status === 401) {
      await markXAccountNeedsReauth(connection, "X rejected API access.");
      throw new XAccessAuthError("X rejected access for this account.");
    }
    throw new Error(
      `X API request failed with ${response.status}${text ? `: ${xApiErrorDetail(text)}` : "."}`,
    );
  }
  return text ? (JSON.parse(text) as unknown) : {};
}

export async function getXAccessToken(
  connection: XAccessConnection,
  options?: { signal?: AbortSignal; forceRefresh?: boolean },
): Promise<string> {
  return getExpiringOAuthAccessToken({
    connection: { ...connection, provider: "x_account" },
    displayName: "X",
    parseCredential: parseXCredential,
    refresh: refreshXCredential,
    createAuthError: (message) => new XAccessAuthError(message),
    missingCredential: {
      message: "No stored X credentials for this account.",
      statusReason: "Stored X credentials are missing.",
    },
    invalidCredential: {
      message: "Stored X credentials are invalid.",
      statusReason: "Stored X credentials are invalid.",
    },
    ...(options ? { options } : {}),
  });
}

function parseXCredential(payload: Record<string, unknown>) {
  const accessToken = typeof payload.access_token === "string" ? payload.access_token.trim() : "";
  if (!accessToken) return null;
  const tokens = payload as StoredXTokens;
  return {
    accessToken,
    refreshToken: tokens.refresh_token?.trim() || null,
    payload: tokens,
  };
}

async function refreshXCredential(
  credential: {
    accessToken: string;
    refreshToken: string | null;
    payload: StoredXTokens;
  },
  context: { now: Date; signal?: AbortSignal },
) {
  const refreshToken = credential.refreshToken;
  if (!refreshToken) {
    throw new ExpiringOAuthReauthRequired(
      "Stored X credentials have no refresh token.",
      "Stored X credentials have no refresh token.",
    );
  }
  const clientId = process.env.OPENCOMPANY_X_CLIENT_ID?.trim();
  const clientSecret = process.env.OPENCOMPANY_X_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret)
    throw new Error("The opencompany X integration is not configured.");
  const response = await fetch(X_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`,
    },
    signal: context.signal ?? null,
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    if (response.status === 400 || response.status === 401) {
      throw new ExpiringOAuthReauthRequired(
        "X refused the refresh token.",
        "X refused the refresh token.",
      );
    }
    throw new Error(`X token refresh failed with ${response.status}: ${xApiErrorDetail(detail)}`);
  }
  const refreshed = (await response.json()) as StoredXTokens & { expires_in?: number };
  if (!refreshed.access_token) throw new Error("X token refresh returned no access token.");
  const nextTokens: StoredXTokens = {
    access_token: refreshed.access_token,
    // X may omit refresh_token on rotation responses that keep it stable.
    refresh_token: refreshed.refresh_token ?? refreshToken,
    ...((refreshed.scope ?? credential.payload.scope)
      ? { scope: refreshed.scope ?? credential.payload.scope }
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

async function markXAccountNeedsReauth(connection: XAccessConnection, reason: string) {
  await markIntegrationStatus({
    userWorkosId: connection.userWorkosId,
    integrationId: connection.integrationId,
    provider: "x_account",
    status: "needs_reauth",
    statusReason: reason,
    db: getDb(),
  });
}

function xApiErrorDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      const detail = record.detail ?? record.error_description ?? record.title;
      if (typeof detail === "string" && detail.trim()) return detail.trim().slice(0, 200);
    }
  } catch {
    // fall through to raw body
  }
  return body.slice(0, 200);
}
