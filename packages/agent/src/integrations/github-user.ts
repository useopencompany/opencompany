import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { getDb } from "@opencompany/db/client";
import {
  GITHUB_USER_INTEGRATION_EXTERNAL_ID,
  type GitHubUserOAuthCredentialPayload,
} from "@opencompany/db/integrations";
import { integrations } from "@opencompany/db/product-schema";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { getAppUrl } from "../app-url";
import {
  ExpiringOAuthReauthRequired,
  getExpiringOAuthAccessToken,
} from "./expiring-oauth-access-token";
import { verifyGitHubUserInstallation } from "./github";
import type { RemoteMcpProviderState } from "./remote-mcp-oauth";

const GITHUB_USER_PROVIDER = "github_user" as const;
const GITHUB_USER_TOKEN_ENDPOINT = "https://github.com/login/oauth/access_token";
const GITHUB_API_USER_ENDPOINT = "https://api.github.com/user";
const STATE_TTL_MS = 10 * 60 * 1_000;

const GITHUB_USER_INTEGRATION_ENVS = [
  "GITHUB_USER_APP_CLIENT_ID",
  "GITHUB_USER_APP_CLIENT_SECRET",
  "GITHUB_USER_APP_SLUG",
  "GITHUB_USER_APP_STATE_SECRET",
  "INTEGRATION_CREDENTIAL_ENCRYPTION_KEY",
] as const;

type DbLike = any;

export type GitHubUserProviderState = RemoteMcpProviderState<"github_user">;

export type GitHubUserIntegrationStatePayload = {
  provider: "github_user";
  userWorkosId: string;
  returnTo: string;
  expiresAt: number;
  nonce: string;
};

export type GitHubUserOAuthTokens = {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date;
};

export type GitHubUserIdentity = {
  id: string;
  login: string;
  name: string | null;
  email: string | null;
};

export type GitHubUserAccessConnection = {
  userWorkosId: string;
  integrationId: string;
};

export class GitHubUserAccessAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubUserAccessAuthError";
  }
}

export function isGitHubUserIntegrationConfigured() {
  return GITHUB_USER_INTEGRATION_ENVS.every((name) => Boolean(process.env[name]?.trim()));
}

export async function getGitHubUserIntegrationState(
  identity: string | { userWorkosId: string },
): Promise<GitHubUserProviderState> {
  const userWorkosId = typeof identity === "string" ? identity : identity.userWorkosId;
  const row = await loadGitHubUserIntegration({ userWorkosId });

  if (!row || row.status === "disconnected") {
    return {
      provider: GITHUB_USER_PROVIDER,
      connected: false,
      status: "not_connected",
      integrationId: null,
      accountName: null,
      statusReason: null,
      capabilityModes: {},
      toolModes: {},
    };
  }

  return {
    provider: GITHUB_USER_PROVIDER,
    connected: row.status === "connected",
    status: row.status,
    integrationId: row.id,
    accountName: row.accountName,
    statusReason: row.statusReason,
    capabilityModes: row.capabilityModes,
    toolModes: row.toolModes,
  };
}

export async function loadGitHubUserIntegration(input: { userWorkosId: string; db?: DbLike }) {
  const [row] = await (input.db ?? getDb())
    .select({
      id: integrations.id,
      userWorkosId: integrations.userWorkosId,
      status: integrations.status,
      connectionLabel: integrations.connectionLabel,
      accountName: integrations.accountName,
      accountEmail: integrations.accountEmail,
      statusReason: integrations.statusReason,
      capabilityModes: integrations.capabilityModes,
      toolModes: integrations.toolModes,
    })
    .from(integrations)
    .where(
      and(
        eq(integrations.userWorkosId, input.userWorkosId),
        isNull(integrations.workspaceId),
        eq(integrations.provider, GITHUB_USER_PROVIDER),
        eq(integrations.externalId, GITHUB_USER_INTEGRATION_EXTERNAL_ID),
        ne(integrations.status, "disconnected"),
      ),
    )
    .orderBy(desc(integrations.updatedAt))
    .limit(1);
  return row;
}

export function createGitHubUserIntegrationState(
  input: Omit<GitHubUserIntegrationStatePayload, "provider" | "expiresAt" | "nonce">,
) {
  const payload: GitHubUserIntegrationStatePayload = {
    provider: GITHUB_USER_PROVIDER,
    userWorkosId: input.userWorkosId,
    returnTo: sanitizeReturnTo(input.returnTo),
    expiresAt: Date.now() + STATE_TTL_MS,
    nonce: randomUUID(),
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${signStateBody(body)}`;
}

export function verifyGitHubUserIntegrationState(state: string): GitHubUserIntegrationStatePayload {
  const [body, signature] = state.split(".");
  if (!body || !signature || !safeEqual(signature, signStateBody(body))) {
    throw new Error("Invalid GitHub user integration state.");
  }

  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
  if (!isGitHubUserIntegrationStatePayload(payload)) {
    throw new Error("Invalid GitHub user integration state payload.");
  }
  if (payload.expiresAt < Date.now()) {
    throw new Error("GitHub user integration state expired.");
  }
  return { ...payload, returnTo: sanitizeReturnTo(payload.returnTo) };
}

// The dedicated App has "Request user authorization (OAuth) during
// installation" enabled, so installing and authorizing land in one callback.
export function buildGitHubUserInstallUrl(state: string) {
  const slug = requiredEnv("GITHUB_USER_APP_SLUG");
  if (!/^[a-z0-9-]+$/iu.test(slug)) {
    throw new Error("GITHUB_USER_APP_SLUG is not a valid GitHub App slug.");
  }
  const url = new URL(`https://github.com/apps/${slug}/installations/new`);
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeGitHubAppUserCode(code: string): Promise<GitHubUserOAuthTokens> {
  const response = await fetch(GITHUB_USER_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: requiredEnv("GITHUB_USER_APP_CLIENT_ID"),
      client_secret: requiredEnv("GITHUB_USER_APP_CLIENT_SECRET"),
      code,
      redirect_uri: githubUserCallbackUrl(),
    }),
  });
  const result = await tokenResponseJson(response);
  if (!response.ok || readString(result.error)) {
    throw new Error(`GitHub user authorization failed with ${response.status}.`);
  }
  return parseTokenResponse(result, new Date());
}

export async function verifyGitHubAppUserInstallation(input: {
  accessToken: string;
  installationId: string;
}) {
  return verifyGitHubUserInstallation({
    userToken: input.accessToken,
    installationId: input.installationId,
  });
}

export async function fetchGitHubUserIdentity(accessToken: string): Promise<GitHubUserIdentity> {
  const response = await fetch(GITHUB_API_USER_ENDPOINT, {
    headers: githubApiHeaders(accessToken),
  });
  if (!response.ok) {
    throw new Error(`GitHub user lookup failed with ${response.status}.`);
  }
  const result = (await response.json()) as Record<string, unknown>;
  const id = readId(result.id);
  const login = readString(result.login);
  if (!id || !login) {
    throw new Error("GitHub did not return an account id and login.");
  }
  return {
    id,
    login,
    name: readString(result.name),
    email: readString(result.email),
  };
}

// Shared by the action gateway now and the runner sandbox injection slice
// later. Refresh responses rotate both GitHub tokens; persistence therefore
// replaces the encrypted payload as one write before returning the new access
// token.
export async function getGitHubUserAccessToken(
  connection: GitHubUserAccessConnection,
  options: { signal?: AbortSignal; forceRefresh?: boolean; db?: DbLike; now?: Date } = {},
): Promise<string> {
  return getExpiringOAuthAccessToken({
    connection: { ...connection, provider: GITHUB_USER_PROVIDER },
    displayName: "GitHub",
    parseCredential: (payload) => {
      const tokens = parseStoredTokens(payload);
      return tokens
        ? {
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            payload: tokens,
          }
        : null;
    },
    validateRefresh: (credential, now) => {
      if (
        new Date(credential.payload.refresh_token_expires_at).getTime() - 60_000 <=
        now.getTime()
      ) {
        throw new ExpiringOAuthReauthRequired(
          "The GitHub refresh token expired.",
          "The GitHub refresh token expired. Reconnect GitHub in Settings.",
        );
      }
    },
    refresh: refreshGitHubAppUserCredential,
    createAuthError: (message) => new GitHubUserAccessAuthError(message),
    missingCredential: {
      message: "No stored GitHub credentials for this account.",
      statusReason: "Stored GitHub credentials are missing.",
    },
    invalidCredential: {
      message: "Stored GitHub credentials are invalid.",
      statusReason: "Stored GitHub credentials are invalid.",
    },
    options,
  });
}

async function refreshGitHubAppUserCredential(
  credential: {
    accessToken: string;
    refreshToken: string | null;
    payload: GitHubUserOAuthCredentialPayload;
  },
  context: { now: Date; signal?: AbortSignal },
) {
  if (!credential.refreshToken) {
    throw new ExpiringOAuthReauthRequired(
      "Stored GitHub credentials have no refresh token.",
      "Stored GitHub credentials have no refresh token. Reconnect GitHub in Settings.",
    );
  }
  let response: Response;
  try {
    response = await fetch(GITHUB_USER_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      signal: context.signal ?? null,
      body: new URLSearchParams({
        client_id: requiredEnv("GITHUB_USER_APP_CLIENT_ID"),
        client_secret: requiredEnv("GITHUB_USER_APP_CLIENT_SECRET"),
        grant_type: "refresh_token",
        refresh_token: credential.refreshToken,
      }),
    });
  } catch (error) {
    if (context.signal?.aborted) throw error;
    throw new Error("GitHub token refresh could not reach GitHub.", { cause: error });
  }

  const result = await tokenResponseJson(response);
  const oauthError = readString(result.error);
  if (!response.ok || oauthError) {
    if (oauthError === "bad_refresh_token") {
      throw new ExpiringOAuthReauthRequired(
        "GitHub refused the refresh token.",
        "GitHub refused the refresh token. Reconnect GitHub in Settings.",
      );
    }
    throw new Error(`GitHub token refresh failed with ${response.status}.`);
  }

  let refreshed: GitHubUserOAuthTokens;
  try {
    refreshed = parseTokenResponse(result, context.now);
  } catch (error) {
    throw new ExpiringOAuthReauthRequired(
      error instanceof Error ? error.message : "GitHub returned invalid credentials.",
      "GitHub returned invalid expiring credentials. Reconnect GitHub in Settings.",
    );
  }

  return {
    accessToken: refreshed.accessToken,
    payload: {
      access_token: refreshed.accessToken,
      refresh_token: refreshed.refreshToken,
      token_type: refreshed.tokenType,
      refresh_token_expires_at: refreshed.refreshTokenExpiresAt.toISOString(),
      github_user_id: credential.payload.github_user_id,
      github_login: credential.payload.github_login,
      github_installation_id: credential.payload.github_installation_id,
    } satisfies GitHubUserOAuthCredentialPayload,
    expiresAt: refreshed.accessTokenExpiresAt,
  };
}

export function appendGitHubUserIntegrationStatus(
  returnTo: string,
  status: "connected" | "error",
  reason?: string,
) {
  const url = new URL(sanitizeReturnTo(returnTo), getAppUrl());
  url.searchParams.set("integration", GITHUB_USER_PROVIDER);
  url.searchParams.set("setup", status);
  if (status === "error" && reason) url.searchParams.set("reason", reason);
  return `${url.pathname}${url.search}`;
}

export function githubUserCallbackUrl() {
  return `${getAppUrl()}/api/integrations/github-user/callback`;
}

function parseTokenResponse(value: Record<string, unknown>, now: Date): GitHubUserOAuthTokens {
  const accessToken = readString(value.access_token);
  const refreshToken = readString(value.refresh_token);
  const tokenType = readString(value.token_type);
  const expiresIn = readPositiveNumber(value.expires_in);
  const refreshTokenExpiresIn = readPositiveNumber(value.refresh_token_expires_in);
  if (
    !accessToken?.startsWith("ghu_") ||
    !refreshToken?.startsWith("ghr_") ||
    tokenType?.toLowerCase() !== "bearer" ||
    !expiresIn ||
    !refreshTokenExpiresIn
  ) {
    throw new Error("GitHub did not return expiring GitHub App user credentials.");
  }
  return {
    accessToken,
    refreshToken,
    tokenType: "bearer",
    accessTokenExpiresAt: new Date(now.getTime() + expiresIn * 1_000),
    refreshTokenExpiresAt: new Date(now.getTime() + refreshTokenExpiresIn * 1_000),
  };
}

function parseStoredTokens(
  value: Record<string, unknown>,
): GitHubUserOAuthCredentialPayload | null {
  const accessToken = readString(value.access_token);
  const refreshToken = readString(value.refresh_token);
  const tokenType = readString(value.token_type);
  const refreshTokenExpiresAt = readString(value.refresh_token_expires_at);
  const githubUserId = readString(value.github_user_id);
  const githubLogin = readString(value.github_login);
  const githubInstallationId = readString(value.github_installation_id);
  if (
    !accessToken?.startsWith("ghu_") ||
    !refreshToken?.startsWith("ghr_") ||
    tokenType?.toLowerCase() !== "bearer" ||
    !refreshTokenExpiresAt ||
    Number.isNaN(new Date(refreshTokenExpiresAt).getTime()) ||
    !githubUserId ||
    !githubLogin ||
    !githubInstallationId
  ) {
    return null;
  }
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "bearer",
    refresh_token_expires_at: refreshTokenExpiresAt,
    github_user_id: githubUserId,
    github_login: githubLogin,
    github_installation_id: githubInstallationId,
  };
}

async function tokenResponseJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = (await response.json()) as unknown;
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

function githubApiHeaders(accessToken: string) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${accessToken}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function sanitizeReturnTo(value: string) {
  if (!value.startsWith("/") || value.startsWith("//")) return "/settings";
  return value;
}

function signStateBody(body: string) {
  return createHmac("sha256", requiredEnv("GITHUB_USER_APP_STATE_SECRET"))
    .update(body)
    .digest("base64url");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isGitHubUserIntegrationStatePayload(
  value: unknown,
): value is GitHubUserIntegrationStatePayload {
  if (!isRecord(value)) return false;
  return (
    value.provider === GITHUB_USER_PROVIDER &&
    typeof value.userWorkosId === "string" &&
    typeof value.returnTo === "string" &&
    typeof value.expiresAt === "number" &&
    typeof value.nonce === "string"
  );
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readId(value: unknown) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return readString(value);
}

function readPositiveNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requiredEnv(name: (typeof GITHUB_USER_INTEGRATION_ENVS)[number]) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the opencompany GitHub user integration.`);
  return value;
}
