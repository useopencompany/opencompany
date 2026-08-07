import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { getDb } from "@opencompany/db/client";
import { integrations } from "@opencompany/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { getAppUrl } from "../app-url";
import type { SlackProviderState } from "../integration-state";

export type SlackIntegrationStatePayload = {
  userWorkosId: string;
  returnTo: string;
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
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
  "SLACK_SIGNING_SECRET",
  "SLACK_STATE_SECRET",
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

export function isSlackIntegrationConfigured() {
  return SLACK_INTEGRATION_ENVS.every((name) => Boolean(process.env[name]?.trim()));
}

export async function getSlackIntegrationState(userWorkosId: string): Promise<SlackProviderState> {
  const [row] = await getDb()
    .select({
      id: integrations.id,
      status: integrations.status,
      accountName: integrations.accountName,
      connectionLabel: integrations.connectionLabel,
      statusReason: integrations.statusReason,
    })
    .from(integrations)
    .where(
      and(eq(integrations.userWorkosId, userWorkosId), eq(integrations.provider, SLACK_PROVIDER)),
    )
    .orderBy(desc(integrations.updatedAt))
    .limit(1);

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

export function buildSlackAuthorizationUrl(state: string) {
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", requiredEnv("SLACK_CLIENT_ID"));
  // user_scope (not scope): we request a user token only, no bot token.
  url.searchParams.set("user_scope", SLACK_USER_SCOPES.join(","));
  url.searchParams.set("redirect_uri", slackCallbackUrl());
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeSlackCode(code: string): Promise<SlackOAuthResult> {
  const result = await slackApiRequest<{
    team?: { id?: string; name?: string };
    authed_user?: { id?: string; access_token?: string; scope?: string; token_type?: string };
  }>({
    method: "oauth.v2.access",
    form: {
      client_id: requiredEnv("SLACK_CLIENT_ID"),
      client_secret: requiredEnv("SLACK_CLIENT_SECRET"),
      code,
      redirect_uri: slackCallbackUrl(),
    },
  });

  const teamId = result.team?.id?.trim();
  const authedUserId = result.authed_user?.id?.trim();
  const accessToken = result.authed_user?.access_token?.trim();
  if (!teamId || !authedUserId || !accessToken) {
    throw new Error("Slack did not return a user token.");
  }

  return {
    teamId,
    teamName: result.team?.name?.trim() || null,
    authedUserId,
    accessToken,
    scopes: (result.authed_user?.scope ?? "").split(",").filter(Boolean),
  };
}

export async function fetchSlackIdentity(input: { accessToken: string; authedUserId: string }) {
  const [userResult, teamResult] = await Promise.all([
    slackApiRequest<{
      user?: { real_name?: string; name?: string; profile?: { email?: string } };
    }>({
      method: "users.info",
      token: input.accessToken,
      form: { user: input.authedUserId },
    }),
    slackApiRequest<{ team?: { domain?: string } }>({
      method: "team.info",
      token: input.accessToken,
    }),
  ]);

  return {
    userName: userResult.user?.real_name?.trim() || userResult.user?.name?.trim() || null,
    userEmail: userResult.user?.profile?.email?.trim() || null,
    teamDomain: teamResult.team?.domain?.trim() || null,
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

function isSlackIntegrationStatePayload(value: unknown): value is SlackIntegrationStatePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
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
  return createHmac("sha256", requiredEnv("SLACK_STATE_SECRET")).update(body).digest("base64url");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for Goat Slack integration.`);
  return value;
}
