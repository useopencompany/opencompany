import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { getDb } from "@opencompany/db/client";
import { goatIntegrations } from "@opencompany/db/goat-schema";
import { and, desc, eq } from "drizzle-orm";
import type { GoatSlackProviderState } from "@/lib/integration-state";
import { getGoatAppUrl } from "@/lib/workos";

export type GoatSlackIntegrationStatePayload = {
  userWorkosId: string;
  returnTo: string;
  expiresAt: number;
  nonce: string;
};

export type GoatSlackOAuthResult = {
  teamId: string;
  teamName: string | null;
  authedUserId: string;
  accessToken: string;
  scopes: string[];
};

const SLACK_PROVIDER = "slack" as const;
const GOAT_SLACK_INTEGRATION_ENVS = [
  "GOAT_SLACK_CLIENT_ID",
  "GOAT_SLACK_CLIENT_SECRET",
  "GOAT_SLACK_SIGNING_SECRET",
  "GOAT_SLACK_STATE_SECRET",
] as const;

// User-token scopes: the app reads what the connected user can read (their
// channels and DMs) and never gets a bot presence in the workspace. The
// search:read.* family powers chat-capability keyword search; connections
// created before it was added keep working without search until reconnected.
export const GOAT_SLACK_USER_SCOPES = [
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
  "search:read.public",
  "search:read.private",
  "search:read.im",
  "search:read.mpim",
] as const;

export function isGoatSlackIntegrationConfigured() {
  return GOAT_SLACK_INTEGRATION_ENVS.every((name) => Boolean(process.env[name]?.trim()));
}

export async function getGoatSlackIntegrationState(
  userWorkosId: string,
): Promise<GoatSlackProviderState> {
  const [row] = await getDb()
    .select({
      id: goatIntegrations.id,
      status: goatIntegrations.status,
      accountName: goatIntegrations.accountName,
      connectionLabel: goatIntegrations.connectionLabel,
      statusReason: goatIntegrations.statusReason,
    })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.userWorkosId, userWorkosId),
        eq(goatIntegrations.provider, SLACK_PROVIDER),
      ),
    )
    .orderBy(desc(goatIntegrations.updatedAt))
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

export function createGoatSlackIntegrationState(
  input: Omit<GoatSlackIntegrationStatePayload, "expiresAt" | "nonce">,
) {
  const payload: GoatSlackIntegrationStatePayload = {
    ...input,
    returnTo: sanitizeReturnTo(input.returnTo),
    expiresAt: Date.now() + 10 * 60 * 1000,
    nonce: randomUUID(),
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${signStateBody(body)}`;
}

export function verifyGoatSlackIntegrationState(state: string): GoatSlackIntegrationStatePayload {
  const [body, signature] = state.split(".");
  if (!body || !signature || !safeEqual(signature, signStateBody(body))) {
    throw new Error("Invalid Slack integration state.");
  }

  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
  if (!isGoatSlackIntegrationStatePayload(payload)) {
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

export function buildGoatSlackAuthorizationUrl(state: string) {
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", requiredEnv("GOAT_SLACK_CLIENT_ID"));
  // user_scope (not scope): we request a user token only, no bot token.
  url.searchParams.set("user_scope", GOAT_SLACK_USER_SCOPES.join(","));
  url.searchParams.set("redirect_uri", goatSlackCallbackUrl());
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeGoatSlackCode(code: string): Promise<GoatSlackOAuthResult> {
  const result = await slackApiRequest<{
    team?: { id?: string; name?: string };
    authed_user?: { id?: string; access_token?: string; scope?: string; token_type?: string };
  }>({
    method: "oauth.v2.access",
    form: {
      client_id: requiredEnv("GOAT_SLACK_CLIENT_ID"),
      client_secret: requiredEnv("GOAT_SLACK_CLIENT_SECRET"),
      code,
      redirect_uri: goatSlackCallbackUrl(),
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

export async function fetchGoatSlackIdentity(input: { accessToken: string; authedUserId: string }) {
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

export function appendGoatSlackIntegrationStatus(
  returnTo: string,
  status: "connected" | "error",
  reason?: string,
) {
  const url = new URL(sanitizeReturnTo(returnTo), getGoatAppUrl());
  url.searchParams.set("integration", SLACK_PROVIDER);
  url.searchParams.set("setup", status);
  if (status === "error" && reason) url.searchParams.set("reason", reason);
  return `${url.pathname}${url.search}`;
}

export async function slackApiRequest<T extends Record<string, unknown>>(input: {
  method: string;
  token?: string;
  form?: Record<string, string>;
}): Promise<T> {
  const response = await fetch(`https://slack.com/api/${input.method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(input.token ? { Authorization: `Bearer ${input.token}` } : {}),
    },
    body: new URLSearchParams(input.form ?? {}).toString(),
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

function goatSlackCallbackUrl() {
  return `${getGoatAppUrl()}/api/integrations/slack/callback`;
}

function isGoatSlackIntegrationStatePayload(
  value: unknown,
): value is GoatSlackIntegrationStatePayload {
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
  return createHmac("sha256", requiredEnv("GOAT_SLACK_STATE_SECRET"))
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
  if (!value) throw new Error(`${name} is required for Goat Slack integration.`);
  return value;
}
