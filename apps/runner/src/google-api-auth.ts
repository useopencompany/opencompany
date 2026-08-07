import {
  loadIntegrationCredential,
  markIntegrationStatus,
  refreshIntegrationCredential,
} from "@opencompany/db/integrations";
import type { IntegrationProvider } from "@opencompany/db/schema";
import { getDb } from "./db";
import type { RunnerEnv } from "./env";

// Shared Google OAuth access for the runner's Gmail and Drive ingestion
// workers. Keeping one stored-credential + refresh stack ensures needs_reauth
// marking and refresh-token rotation behave identically everywhere.

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REFRESH_SKEW_MS = 60_000;

export type GoogleApiAccount = {
  integrationId: string;
  provider: IntegrationProvider;
  accountEmail: string | null;
};

export type GoogleApiEnv = Pick<RunnerEnv, "googleOAuthClientId" | "googleOAuthClientSecret">;

type StoredGoogleTokens = {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
};

export async function getGoogleAccessToken(input: {
  env: GoogleApiEnv;
  userWorkosId: string;
  account: GoogleApiAccount;
  signal: AbortSignal;
  forceRefresh?: boolean;
}) {
  const credential = await loadIntegrationCredential({
    userWorkosId: input.userWorkosId,
    integrationId: input.account.integrationId,
    provider: input.account.provider,
    kind: "oauth_token",
    db: getDb(),
  });
  if (!credential) {
    throw new Error(`Reconnect ${googleProviderDisplayName(input.account.provider)} in Settings.`);
  }

  const tokens = credential.payload as StoredGoogleTokens;
  const expired = credential.expiresAt
    ? credential.expiresAt.getTime() - REFRESH_SKEW_MS <= Date.now()
    : true;
  if (!input.forceRefresh && !expired && tokens.access_token) return tokens.access_token;

  if (!tokens.refresh_token) {
    await markGoogleNeedsReauth(input, "Stored Google credentials have no refresh token.");
    throw new Error(`Reconnect ${googleProviderDisplayName(input.account.provider)} in Settings.`);
  }

  return refreshGoogleAccessToken(input, tokens);
}

async function refreshGoogleAccessToken(
  input: {
    env: GoogleApiEnv;
    userWorkosId: string;
    account: GoogleApiAccount;
    signal: AbortSignal;
  },
  tokens: StoredGoogleTokens,
) {
  if (!input.env.googleOAuthClientId || !input.env.googleOAuthClientSecret) {
    throw new Error("Google OAuth is not configured on the runner.");
  }

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal: input.signal,
    body: new URLSearchParams({
      client_id: input.env.googleOAuthClientId,
      client_secret: input.env.googleOAuthClientSecret,
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token ?? "",
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    if (response.status === 400 && detail.includes("invalid_grant")) {
      await markGoogleNeedsReauth(input, "Google refused the refresh token.");
      throw new Error(
        `Reconnect ${googleProviderDisplayName(input.account.provider)} in Settings.`,
      );
    }
    throw new Error(`Google token refresh failed with ${response.status}.`);
  }

  const result = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    scope?: string;
    token_type?: string;
  };
  if (!result.access_token) throw new Error("Google token refresh did not return an access token.");

  const nextTokens: StoredGoogleTokens = {
    access_token: result.access_token,
    ...((result.refresh_token ?? tokens.refresh_token)
      ? { refresh_token: result.refresh_token ?? tokens.refresh_token }
      : {}),
    ...((result.scope ?? tokens.scope) ? { scope: result.scope ?? tokens.scope } : {}),
    ...((result.token_type ?? tokens.token_type)
      ? { token_type: result.token_type ?? tokens.token_type }
      : {}),
  };
  const expiresAt =
    typeof result.expires_in === "number" ? new Date(Date.now() + result.expires_in * 1000) : null;

  await refreshIntegrationCredential({
    userWorkosId: input.userWorkosId,
    integrationId: input.account.integrationId,
    provider: input.account.provider,
    kind: "oauth_token",
    payload: stripUndefined(nextTokens),
    expiresAt,
    db: getDb(),
  });

  return result.access_token;
}

async function markGoogleNeedsReauth(
  input: { userWorkosId: string; account: GoogleApiAccount },
  reason: string,
) {
  await markIntegrationStatus({
    userWorkosId: input.userWorkosId,
    integrationId: input.account.integrationId,
    provider: input.account.provider,
    status: "needs_reauth",
    statusReason: reason,
    db: getDb(),
  });
}

export class GoogleApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GoogleApiRequestError";
  }
}

export async function googleApiCall(input: {
  env: GoogleApiEnv;
  userWorkosId: string;
  account: GoogleApiAccount;
  method: string;
  url: string;
  body?: unknown;
  signal: AbortSignal;
}): Promise<unknown> {
  const response = await googleApiFetch(input);

  if (response.status === 204) return {};
  const text = await response.text();
  if (!response.ok) {
    throw new GoogleApiRequestError(
      `${googleProviderDisplayName(input.account.provider)} API request failed with ${response.status}: ${truncateText(text, 300)}`,
      response.status,
    );
  }
  return text ? JSON.parse(text) : {};
}

export async function googleApiFetch(input: {
  env: GoogleApiEnv;
  userWorkosId: string;
  account: GoogleApiAccount;
  method: string;
  url: string;
  body?: unknown;
  signal: AbortSignal;
}): Promise<Response> {
  const run = async (token: string) =>
    fetch(input.url, {
      method: input.method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(input.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      signal: input.signal,
      ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
    });
  let token = await getGoogleAccessToken(input);
  let response = await run(token);
  if (response.status === 401) {
    token = await getGoogleAccessToken({ ...input, forceRefresh: true });
    response = await run(token);
  }
  return response;
}

export function googleProviderDisplayName(provider: IntegrationProvider) {
  if (provider === "gmail") return "Gmail";
  if (provider === "google_drive") return "Google Drive";
  return "Google Calendar";
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function truncateText(value: string, maxChars: number) {
  return value.length > maxChars ? `${value.slice(0, maxChars).trimEnd()}...` : value;
}
