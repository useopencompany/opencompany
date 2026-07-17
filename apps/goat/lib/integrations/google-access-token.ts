import { getDb } from "@opencompany/db/client";
import {
  loadGoatIntegrationCredential,
  markGoatIntegrationStatus,
  refreshGoatIntegrationCredential,
} from "@opencompany/db/goat-integrations";

// Shared app-tier Google OAuth access-token resolution for personal Google
// integrations (Gmail, Calendar, Drive): load the stored credential, refresh
// it against Google's token endpoint when expired, persist the rotation, and
// mark the integration needs_reauth when Google refuses the refresh token.

const REFRESH_SKEW_MS = 60_000;

export type GoatGoogleTokenProvider = "gmail" | "google_calendar" | "google_drive";

export type GoatGoogleTokenAccount = {
  userWorkosId: string;
  integrationId: string;
  provider: GoatGoogleTokenProvider;
};

export const GOAT_GOOGLE_PROVIDER_LABELS: Record<GoatGoogleTokenProvider, string> = {
  gmail: "Gmail",
  google_calendar: "Google Calendar",
  google_drive: "Google Drive",
};

type StoredTokens = {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
};

export class GoatGoogleApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GoatGoogleApiRequestError";
  }
}

export async function getGoatGoogleAccessToken(
  account: GoatGoogleTokenAccount,
  signal?: AbortSignal,
  forceRefresh = false,
): Promise<string> {
  const label = GOAT_GOOGLE_PROVIDER_LABELS[account.provider];
  const credential = await loadGoatIntegrationCredential({
    userWorkosId: account.userWorkosId,
    integrationId: account.integrationId,
    provider: account.provider,
    kind: "oauth_token",
    db: getDb(),
  });
  if (!credential) throw new Error(`Reconnect ${label} in Settings.`);
  const tokens = credential.payload as StoredTokens;
  const expired = credential.expiresAt
    ? credential.expiresAt.getTime() - REFRESH_SKEW_MS <= Date.now()
    : true;
  if (!forceRefresh && !expired && tokens.access_token) return tokens.access_token;
  if (!tokens.refresh_token) {
    await markNeedsReauth(account, `Stored ${label} credentials have no refresh token.`);
    throw new Error(`Reconnect ${label} in Settings.`);
  }

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) throw new Error("Google OAuth is not configured.");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    ...(signal ? { signal } : {}),
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
      await markNeedsReauth(account, "Google refused the refresh token.");
      throw new Error(`Reconnect ${label} in Settings.`);
    }
    throw new Error(`Google token refresh failed with ${response.status}.`);
  }
  const result = (await response.json()) as StoredTokens & { expires_in?: number };
  if (!result.access_token) throw new Error("Google token refresh returned no access token.");
  const nextTokens = {
    access_token: result.access_token,
    refresh_token: result.refresh_token ?? tokens.refresh_token,
    scope: result.scope ?? tokens.scope,
    token_type: result.token_type ?? tokens.token_type,
  };
  await refreshGoatIntegrationCredential({
    userWorkosId: account.userWorkosId,
    integrationId: account.integrationId,
    provider: account.provider,
    kind: "oauth_token",
    payload: Object.fromEntries(
      Object.entries(nextTokens).filter(([, value]) => value !== undefined),
    ),
    expiresAt:
      typeof result.expires_in === "number"
        ? new Date(Date.now() + result.expires_in * 1000)
        : null,
    db: getDb(),
  });
  return result.access_token;
}

export async function goatGoogleJsonRequest<T>(input: {
  account: GoatGoogleTokenAccount;
  url: URL;
  signal?: AbortSignal;
}): Promise<T> {
  const run = async (accessToken: string) =>
    fetch(input.url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      ...(input.signal ? { signal: input.signal } : {}),
    });
  let accessToken = await getGoatGoogleAccessToken(input.account, input.signal);
  let response = await run(accessToken);
  if (response.status === 401) {
    accessToken = await getGoatGoogleAccessToken(input.account, input.signal, true);
    response = await run(accessToken);
  }
  if (!response.ok) {
    throw new GoatGoogleApiRequestError(
      `${GOAT_GOOGLE_PROVIDER_LABELS[input.account.provider]} API request failed with ${response.status}.`,
      response.status,
    );
  }
  return (await response.json()) as T;
}

async function markNeedsReauth(account: GoatGoogleTokenAccount, reason: string) {
  await markGoatIntegrationStatus({
    userWorkosId: account.userWorkosId,
    integrationId: account.integrationId,
    provider: account.provider,
    status: "needs_reauth",
    statusReason: reason,
    db: getDb(),
  });
}
