import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { getDb } from "@opencompany/db/client";
import { integrations } from "@opencompany/db/product-schema";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { getAppUrl } from "../app-url";
import type { SlackProviderState } from "../integration-state";

export type SlackIntegrationStatePayload = {
  userWorkosId: string;
  returnTo: string;
  purpose?: "mcp";
  expiresAt: number;
  nonce: string;
};

export type SlackOAuthResult = {
  teamId: string;
  teamName: string | null;
  authedUserId: string;
  accessToken: string;
  scopes: string[];
};

const SLACK_PROVIDER = "slack" as const;
const SLACK_INTEGRATION_ENVS = [
  "OPENCOMPANY_SLACK_CLIENT_ID",
  "OPENCOMPANY_SLACK_CLIENT_SECRET",
  "OPENCOMPANY_SLACK_SIGNING_SECRET",
  "OPENCOMPANY_SLACK_STATE_SECRET",
] as const;

// User-token scopes: the app reads what the connected user can read (their
// channels and DMs) and never gets a bot presence in the workspace. The
// search:read scope powers search.messages for the chat capability; connections
// created before it was added keep working without search until reconnected.
export const SLACK_USER_SCOPES = [
  "channels:history",
  "groups:history",
  "im:history",
  "mpim:history",
  "channels:read",
  "groups:read",
  "im:read",
  "mpim:read",
  "users:read",
  "team:read",
  "search:read",
] as const;

// Slack's hosted MCP server only accepts the user scopes advertised by its
// protected-resource metadata. Keep this list separate from the narrower
// ingestion connection so installing the plugin never silently broadens a
// legacy Slack connection.
export const SLACK_MCP_USER_SCOPES = [
  "canvases:read",
  "canvases:write",
  "channels:history",
  "channels:read",
  "channels:write",
  "chat:write",
  "emoji:read",
  "files:read",
  "files:write",
  "groups:history",
  "groups:read",
  "groups:write",
  "im:history",
  "im:read",
  "im:write",
  "lists:read",
  "lists:write",
  "mpim:history",
  "mpim:read",
  "mpim:write",
  "reactions:read",
  "reactions:write",
  "search:read.files",
  "search:read.im",
  "search:read.mpim",
  "search:read.private",
  "search:read.public",
  "search:read.users",
  "users:read",
  "users:read.email",
] as const;

export function isSlackIntegrationConfigured() {
  return SLACK_INTEGRATION_ENVS.every((name) => Boolean(process.env[name]?.trim()));
}

export async function getSlackIntegrationState(userWorkosId: string): Promise<SlackProviderState> {
  const row = await loadSlackIntegration({ userWorkosId });

  if (!row || row.status === "disconnected") {
    return {
      provider: SLACK_PROVIDER,
      connected: false,
      status: "not_connected",
      integrationId: null,
      accountName: null,
      teamName: null,
      statusReason: null,
    };
  }

  return {
    provider: SLACK_PROVIDER,
    connected: row.status === "connected",
    status: row.status,
    integrationId: row.id,
    accountName: row.accountName,
    teamName: row.connectionLabel,
    statusReason: row.statusReason,
  };
}

type DbLike = any;

export async function loadSlackIntegration(input: { userWorkosId: string; db?: DbLike }) {
  const [row] = await (input.db ?? getDb())
    .select({
      id: integrations.id,
      userWorkosId: integrations.userWorkosId,
      status: integrations.status,
      accountName: integrations.accountName,
      connectionLabel: integrations.connectionLabel,
      statusReason: integrations.statusReason,
      capabilityModes: integrations.capabilityModes,
      toolModes: integrations.toolModes,
    })
    .from(integrations)
    .where(
      and(
        eq(integrations.userWorkosId, input.userWorkosId),
        isNull(integrations.workspaceId),
        eq(integrations.provider, SLACK_PROVIDER),
        ne(integrations.status, "disconnected"),
      ),
    )
    .orderBy(desc(integrations.updatedAt))
    .limit(1);
  return row;
}

export function createSlackIntegrationState(
  input: Omit<SlackIntegrationStatePayload, "expiresAt" | "nonce">,
) {
  const payload: SlackIntegrationStatePayload = {
    ...input,
    returnTo: sanitizeReturnTo(input.returnTo),
    expiresAt: Date.now() + 10 * 60 * 1000,
    nonce: randomUUID(),
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${signStateBody(body)}`;
}

export function verifySlackIntegrationState(state: string): SlackIntegrationStatePayload {
  const [body, signature] = state.split(".");
  if (!body || !signature || !safeEqual(signature, signStateBody(body))) {
    throw new Error("Invalid Slack integration state.");
  }

  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
  if (!isSlackIntegrationStatePayload(payload)) {
    throw new Error("Invalid Slack integration state payload.");
  }
  if (payload.expiresAt < Date.now()) {
    throw new Error("Slack integration state expired.");
  }

  return {
    ...payload,
    returnTo: sanitizeReturnTo(payload.returnTo),
  };
}

export function buildSlackAuthorizationUrl(state: string, purpose?: "mcp") {
  const url = new URL(
    purpose === "mcp"
      ? "https://slack.com/oauth/v2_user/authorize"
      : "https://slack.com/oauth/v2/authorize",
  );
  url.searchParams.set("client_id", requiredEnv("OPENCOMPANY_SLACK_CLIENT_ID"));
  if (purpose === "mcp") {
    url.searchParams.set("scope", SLACK_MCP_USER_SCOPES.join(","));
  } else {
    // user_scope (not scope): the ingestion flow requests a user token only.
    url.searchParams.set("user_scope", SLACK_USER_SCOPES.join(","));
  }
  url.searchParams.set("redirect_uri", slackCallbackUrl());
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeSlackCode(code: string, purpose?: "mcp"): Promise<SlackOAuthResult> {
  const result = await slackApiRequest<{
    team?: { id?: string; name?: string };
    authed_user?: { id?: string; access_token?: string; scope?: string; token_type?: string };
    access_token?: string;
    scope?: string;
  }>({
    method: purpose === "mcp" ? "oauth.v2.user.access" : "oauth.v2.access",
    form: {
      client_id: requiredEnv("OPENCOMPANY_SLACK_CLIENT_ID"),
      client_secret: requiredEnv("OPENCOMPANY_SLACK_CLIENT_SECRET"),
      code,
      redirect_uri: slackCallbackUrl(),
    },
  });

  const teamId = result.team?.id?.trim();
  const authedUserId = result.authed_user?.id?.trim();
  const accessToken = (
    purpose === "mcp" ? result.access_token : result.authed_user?.access_token
  )?.trim();
  if (!teamId || !authedUserId || !accessToken) {
    throw new Error("Slack did not return a user token.");
  }

  return {
    teamId,
    teamName: result.team?.name?.trim() || null,
    authedUserId,
    accessToken,
    scopes:
      (purpose === "mcp" ? result.scope : (result.authed_user?.scope ?? ""))
        ?.split(",")
        .filter(Boolean) ?? [],
  };
}

export async function fetchSlackIdentity(input: {
  accessToken: string;
  authedUserId: string;
  includeTeamDetails?: boolean;
}) {
  const [userResult, teamDomain] = await Promise.all([
    slackApiRequest<{
      user?: { real_name?: string; name?: string; profile?: { email?: string } };
    }>({
      method: "users.info",
      token: input.accessToken,
      form: { user: input.authedUserId },
    }),
    input.includeTeamDetails === false
      ? slackApiRequest<{ url?: string }>({
          method: "auth.test",
          token: input.accessToken,
        }).then((result) => slackTeamDomainFromUrl(result.url))
      : slackApiRequest<{ team?: { domain?: string } }>({
          method: "team.info",
          token: input.accessToken,
        }).then((result) => result.team?.domain?.trim() || null),
  ]);

  return {
    userName: userResult.user?.real_name?.trim() || userResult.user?.name?.trim() || null,
    userEmail: userResult.user?.profile?.email?.trim() || null,
    teamDomain,
  };
}

export function appendSlackIntegrationStatus(
  returnTo: string,
  status: "connected" | "error",
  reason?: string,
) {
  const url = new URL(sanitizeReturnTo(returnTo), getAppUrl());
  url.searchParams.set("integration", SLACK_PROVIDER);
  url.searchParams.set("setup", status);
  if (status === "error" && reason) url.searchParams.set("reason", reason);
  return `${url.pathname}${url.search}`;
}

export async function slackApiRequest<T extends Record<string, unknown>>(input: {
  method: string;
  token?: string;
  form?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<T> {
  const response = await fetch(`https://slack.com/api/${input.method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(input.token ? { Authorization: `Bearer ${input.token}` } : {}),
    },
    body: new URLSearchParams(input.form ?? {}).toString(),
    ...(input.signal ? { signal: input.signal } : {}),
  });

  if (!response.ok) {
    throw new Error(`Slack API ${input.method} failed with ${response.status}.`);
  }

  const result = (await response.json()) as T & { ok?: boolean; error?: string };
  if (!result.ok) {
    throw new Error(`Slack API ${input.method} returned ${result.error ?? "an unknown error"}.`);
  }
  return result;
}

function slackCallbackUrl() {
  return `${getAppUrl()}/api/integrations/slack/callback`;
}

function slackTeamDomainFromUrl(value: string | undefined) {
  if (!value) return null;
  try {
    const hostname = new URL(value).hostname.toLocaleLowerCase();
    return hostname.endsWith(".slack.com") ? hostname.slice(0, -".slack.com".length) || null : null;
  } catch {
    return null;
  }
}

function isSlackIntegrationStatePayload(value: unknown): value is SlackIntegrationStatePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.userWorkosId === "string" &&
    typeof record.returnTo === "string" &&
    (record.purpose === undefined || record.purpose === "mcp") &&
    typeof record.expiresAt === "number" &&
    typeof record.nonce === "string"
  );
}

function sanitizeReturnTo(value: string) {
  if (!value.startsWith("/") || value.startsWith("//")) return "/settings";
  return value;
}

function signStateBody(body: string) {
  return createHmac("sha256", requiredEnv("OPENCOMPANY_SLACK_STATE_SECRET"))
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
  if (!value) throw new Error(`${name} is required for opencompany Slack integration.`);
  return value;
}
