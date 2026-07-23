import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { getGoatAppUrl } from "@/lib/workos";
import { slackApiRequest } from "./slack";

// The Slack answer bot is a second, separate Slack app from the user-token
// ingestion app: it has a bot presence, receives app_mention events, and
// posts answers back into channels. Installed once per workspace by an admin.

export type GoatSlackBotStatePayload = {
  userWorkosId: string;
  workspaceId: string;
  returnTo: string;
  expiresAt: number;
  nonce: string;
};

export type GoatSlackBotOAuthResult = {
  teamId: string;
  teamName: string | null;
  botUserId: string;
  accessToken: string;
  scopes: string[];
};

const GOAT_SLACK_BOT_ENVS = [
  "INTEGRATION_CREDENTIAL_ENCRYPTION_KEY",
  "GOAT_SLACK_BOT_CLIENT_ID",
  "GOAT_SLACK_BOT_CLIENT_SECRET",
  "GOAT_SLACK_BOT_SIGNING_SECRET",
  "GOAT_SLACK_BOT_STATE_SECRET",
] as const;

// Bot scopes: receive mentions and channel/DM messages, reply, list channels
// for the picker, read thread context, react for status acks, and resolve the
// asking Slack user's email for goat-identity mapping.
export const GOAT_SLACK_BOT_SCOPES = [
  "app_mentions:read",
  "chat:write",
  "channels:read",
  "groups:read",
  "channels:history",
  "groups:history",
  "im:history",
  "reactions:write",
  "users:read",
  "users:read.email",
] as const;

// Installs made before a scope was added keep working for mentions; the
// settings UI surfaces a reconnect banner until the granted set catches up.
export function goatSlackBotScopesSatisfied(grantedScopes: readonly string[]): boolean {
  const granted = new Set(grantedScopes);
  return GOAT_SLACK_BOT_SCOPES.every((scope) => granted.has(scope));
}

export function goatSlackBotHasScope(
  grantedScopes: readonly string[],
  scope: (typeof GOAT_SLACK_BOT_SCOPES)[number],
): boolean {
  return grantedScopes.includes(scope);
}

export function isGoatSlackBotConfigured() {
  return GOAT_SLACK_BOT_ENVS.every((name) => Boolean(process.env[name]?.trim()));
}

export function goatSlackBotSigningSecret() {
  return process.env.GOAT_SLACK_BOT_SIGNING_SECRET?.trim();
}

export function createGoatSlackBotState(
  input: Omit<GoatSlackBotStatePayload, "expiresAt" | "nonce">,
) {
  const payload: GoatSlackBotStatePayload = {
    ...input,
    returnTo: sanitizeReturnTo(input.returnTo),
    expiresAt: Date.now() + 10 * 60 * 1000,
    nonce: randomUUID(),
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${signStateBody(body)}`;
}

export function verifyGoatSlackBotState(state: string): GoatSlackBotStatePayload {
  const [body, signature] = state.split(".");
  if (!body || !signature || !safeEqual(signature, signStateBody(body))) {
    throw new Error("Invalid Slack bot integration state.");
  }

  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
  if (!isGoatSlackBotStatePayload(payload)) {
    throw new Error("Invalid Slack bot integration state payload.");
  }
  if (payload.expiresAt < Date.now()) {
    throw new Error("Slack bot integration state expired.");
  }

  return {
    ...payload,
    returnTo: sanitizeReturnTo(payload.returnTo),
  };
}

export function buildGoatSlackBotAuthorizationUrl(state: string) {
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", requiredEnv("GOAT_SLACK_BOT_CLIENT_ID"));
  // scope (not user_scope): we request a bot token only.
  url.searchParams.set("scope", GOAT_SLACK_BOT_SCOPES.join(","));
  url.searchParams.set("redirect_uri", goatSlackBotCallbackUrl());
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeGoatSlackBotCode(code: string): Promise<GoatSlackBotOAuthResult> {
  // Bot installs return the token at the top level of oauth.v2.access,
  // unlike user-token installs which nest it under authed_user.
  const result = await slackApiRequest<{
    access_token?: string;
    bot_user_id?: string;
    scope?: string;
    team?: { id?: string; name?: string };
  }>({
    method: "oauth.v2.access",
    form: {
      client_id: requiredEnv("GOAT_SLACK_BOT_CLIENT_ID"),
      client_secret: requiredEnv("GOAT_SLACK_BOT_CLIENT_SECRET"),
      code,
      redirect_uri: goatSlackBotCallbackUrl(),
    },
  });

  const teamId = result.team?.id?.trim();
  const botUserId = result.bot_user_id?.trim();
  const accessToken = result.access_token?.trim();
  if (!teamId || !botUserId || !accessToken) {
    throw new Error("Slack did not return a bot token.");
  }

  return {
    teamId,
    teamName: result.team?.name?.trim() || null,
    botUserId,
    accessToken,
    scopes: (result.scope ?? "").split(",").filter(Boolean),
  };
}

export function appendGoatSlackBotSetupStatus(
  returnTo: string,
  status: "connected" | "error",
  reason?: string,
) {
  const url = new URL(sanitizeReturnTo(returnTo), getGoatAppUrl());
  url.searchParams.set("integration", "slack_bot");
  url.searchParams.set("setup", status);
  if (status === "error" && reason) url.searchParams.set("reason", reason);
  return `${url.pathname}${url.search}`;
}

function goatSlackBotCallbackUrl() {
  return `${getGoatAppUrl()}/api/integrations/slack-bot/callback`;
}

function isGoatSlackBotStatePayload(value: unknown): value is GoatSlackBotStatePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.userWorkosId === "string" &&
    typeof record.workspaceId === "string" &&
    typeof record.returnTo === "string" &&
    typeof record.expiresAt === "number" &&
    typeof record.nonce === "string"
  );
}

function sanitizeReturnTo(value: string) {
  if (!value.startsWith("/") || value.startsWith("//")) return "/settings/workspace/slack";
  return value;
}

function signStateBody(body: string) {
  return createHmac("sha256", requiredEnv("GOAT_SLACK_BOT_STATE_SECRET"))
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
  if (!value) throw new Error(`${name} is required for the Goat Slack bot integration.`);
  return value;
}
