import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { getDb } from "@opencompany/db/client";
import { integrations } from "@opencompany/db/product-schema";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { getAppUrl } from "../app-url";
import type { SlackProviderState } from "../integration-state";
import {
  SLACK_MCP_RECONNECT_REASON,
  SLACK_MCP_USER_SCOPES,
  slackMcpScopesSatisfied,
} from "./slack-scopes";

export { SLACK_MCP_USER_SCOPES } from "./slack-scopes";

export type SlackIntegrationStatePayload = {
  userWorkosId: string;
  returnTo: string;
  expiresAt: number;
  nonce: string;
};

export type SlackOAuthResult = {
  teamId: string;
  teamName: string | null;
  authedUserId: string | null;
  accessToken: string;
  scopes: string[];
};

export type SlackOAuthResponseShape = {
  credentialLocation: "absent" | "top_level" | "nested" | "both";
  hasAuthedUserId: boolean;
  hasTeamId: boolean;
  hasEnterpriseId: boolean;
  isEnterpriseInstall: boolean | null;
};

export type SlackOAuthRequiredResponseField = "access_token" | "team.id";

export class SlackOAuthResponseError extends Error {
  readonly code = "slack_oauth_response_invalid";

  constructor(
    readonly missingFields: readonly SlackOAuthRequiredResponseField[],
    readonly responseShape: SlackOAuthResponseShape,
  ) {
    super(`Slack OAuth response missing required fields: ${missingFields.join(", ")}.`);
    this.name = "SlackOAuthResponseError";
  }
}

const SLACK_PROVIDER = "slack" as const;
const SLACK_INTEGRATION_ENVS = [
  "OPENCOMPANY_SLACK_CLIENT_ID",
  "OPENCOMPANY_SLACK_CLIENT_SECRET",
  "OPENCOMPANY_SLACK_STATE_SECRET",
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

  const needsPluginGrant = row.status === "connected" && !slackMcpScopesSatisfied(row.scopes ?? []);

  return {
    provider: SLACK_PROVIDER,
    connected: row.status === "connected" && !needsPluginGrant,
    status: needsPluginGrant ? "needs_reauth" : row.status,
    integrationId: row.id,
    accountName: row.accountName,
    teamName: row.connectionLabel,
    statusReason: needsPluginGrant ? SLACK_MCP_RECONNECT_REASON : row.statusReason,
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
      scopes: integrations.scopes,
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

export function buildSlackAuthorizationUrl(state: string) {
  const url = new URL("https://slack.com/oauth/v2_user/authorize");
  url.searchParams.set("client_id", requiredEnv("OPENCOMPANY_SLACK_CLIENT_ID"));
  url.searchParams.set("scope", SLACK_MCP_USER_SCOPES.join(","));
  url.searchParams.set("redirect_uri", slackCallbackUrl());
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeSlackCode(code: string): Promise<SlackOAuthResult> {
  const result = await slackApiRequest<{
    team?: { id?: string; name?: string };
    enterprise?: { id?: string; name?: string };
    authed_user?: { id?: string; access_token?: string; scope?: string; token_type?: string };
    access_token?: string;
    scope?: string;
    is_enterprise_install?: boolean;
  }>({
    method: "oauth.v2.user.access",
    form: {
      client_id: requiredEnv("OPENCOMPANY_SLACK_CLIENT_ID"),
      client_secret: requiredEnv("OPENCOMPANY_SLACK_CLIENT_SECRET"),
      code,
      redirect_uri: slackCallbackUrl(),
    },
  });

  const teamId = result.team?.id?.trim();
  const authedUserId = result.authed_user?.id?.trim();
  const accessToken = result.access_token?.trim();
  const nestedAccessToken = result.authed_user?.access_token?.trim();
  const missingFields: SlackOAuthRequiredResponseField[] = [];
  if (!teamId) missingFields.push("team.id");
  if (!accessToken) missingFields.push("access_token");
  if (!teamId || !accessToken) {
    throw new SlackOAuthResponseError(missingFields, {
      credentialLocation:
        accessToken && nestedAccessToken
          ? "both"
          : accessToken
            ? "top_level"
            : nestedAccessToken
              ? "nested"
              : "absent",
      hasAuthedUserId: Boolean(authedUserId),
      hasTeamId: Boolean(teamId),
      hasEnterpriseId: Boolean(result.enterprise?.id?.trim()),
      isEnterpriseInstall:
        typeof result.is_enterprise_install === "boolean" ? result.is_enterprise_install : null,
    });
  }

  return {
    teamId,
    teamName: result.team?.name?.trim() || null,
    authedUserId: authedUserId || null,
    accessToken,
    scopes: result.scope?.split(",").filter(Boolean) ?? [],
  };
}

export async function fetchSlackIdentity(input: {
  accessToken: string;
  authedUserId: string | null;
  teamId: string;
}) {
  // The dedicated user-token endpoint can omit `authed_user` from an otherwise valid response.
  // Resolve the token holder through auth.test and cross-check any identity OAuth did provide.
  const authResult = await slackApiRequest<{ url?: string; user_id?: string; team_id?: string }>({
    method: "auth.test",
    token: input.accessToken,
  });
  const oauthUserId = input.authedUserId?.trim() || null;
  const authenticatedUserId = authResult.user_id?.trim() || null;
  const authenticatedTeamId = authResult.team_id?.trim() || null;

  if (authenticatedTeamId && authenticatedTeamId !== input.teamId) {
    throw new Error("Slack authenticated token did not match the OAuth workspace.");
  }
  if (oauthUserId && authenticatedUserId && oauthUserId !== authenticatedUserId) {
    throw new Error("Slack authenticated token did not match the OAuth user.");
  }

  const authedUserId = oauthUserId ?? authenticatedUserId;
  if (!authedUserId) {
    throw new Error("Slack identity response did not include a user ID.");
  }

  const userResult = await slackApiRequest<{
    user?: { real_name?: string; name?: string; profile?: { email?: string } };
  }>({
    method: "users.info",
    token: input.accessToken,
    form: { user: authedUserId },
  });

  return {
    authedUserId,
    userName: userResult.user?.real_name?.trim() || userResult.user?.name?.trim() || null,
    userEmail: userResult.user?.profile?.email?.trim() || null,
    teamDomain: slackTeamDomainFromUrl(authResult.url),
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
    typeof record.expiresAt === "number" &&
    typeof record.nonce === "string"
  );
}

function sanitizeReturnTo(value: string) {
  if (!value.startsWith("/") || value.startsWith("//")) return "/settings/plugins/slack";
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
