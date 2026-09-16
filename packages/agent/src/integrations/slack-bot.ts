import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { getAppUrl } from "../app-url";
import { slackApiRequest } from "./slack";

// Workspace-owned Slack Channel installation, separate from personal Slack OAuth.

export type SlackBotStatePayload = {
  userWorkosId: string;
  workspaceId: string;
  returnTo: string;
  expiresAt: number;
  nonce: string;
};

export type SlackBotOAuthResult = {
  teamId: string;
  teamName: string | null;
  botUserId: string;
  accessToken: string;
  scopes: string[];
};

const SLACK_BOT_ENVS = [
  "INTEGRATION_CREDENTIAL_ENCRYPTION_KEY",
  "OPENCOMPANY_SLACK_BOT_CLIENT_ID",
  "OPENCOMPANY_SLACK_BOT_CLIENT_SECRET",
  "OPENCOMPANY_SLACK_BOT_SIGNING_SECRET",
  "OPENCOMPANY_SLACK_BOT_STATE_SECRET",
] as const;

// Public workflow posts, delivery reconciliation, and bot-message filtering.
const SLACK_BOT_DELIVERY_SCOPES = [
  "chat:write",
  "channels:read",
  "channels:history",
  "users:read",
] as const;

// Email attribution, the cosmetic per-workflow display name, thread progress reactions, and
// reading the bot's own direct message threads are requested for new installs. Existing
// installations can keep delivering while Settings asks an admin to reconnect and grant these
// additive scopes; without them posts fall back to email-less attribution, the default bot
// identity, and threads with no progress ack, and direct messages are not delivered to the
// webhook at all.
export const SLACK_BOT_SCOPES = [
  ...SLACK_BOT_DELIVERY_SCOPES,
  "users:read.email",
  "chat:write.customize",
  "reactions:write",
  "im:history",
] as const;

// One Slack app has one bot user, so a workflow identity can only override the name and icon on
// the message itself. Slack rejects those fields without this scope, so a delivery for an install
// that predates it posts under the default identity instead of failing.
export function slackBotCanCustomizeIdentity(grantedScopes: readonly string[]): boolean {
  return grantedScopes.includes("chat:write.customize");
}

// The worker acks an inbound thread reply by reacting to that message. It is a progress signal,
// never the answer, so an install that predates the scope keeps running its threads unmarked
// instead of failing the follow-up it is annotating.
export function slackBotCanReact(grantedScopes: readonly string[]): boolean {
  return grantedScopes.includes("reactions:write");
}

// Slack withholds `message.im` entirely without this scope, so an install that predates it never
// sees a direct message at all. Nothing fails; the bot is simply silent when someone writes to it,
// which is why Settings has to name it rather than leave it to be discovered.
export function slackBotCanReadDirectMessages(grantedScopes: readonly string[]): boolean {
  return grantedScopes.includes("im:history");
}

// Settings surfaces missing grants as a reconnect requirement.
export function slackBotScopesSatisfied(grantedScopes: readonly string[]): boolean {
  const granted = new Set(grantedScopes);
  return SLACK_BOT_SCOPES.every((scope) => granted.has(scope));
}

export function slackBotDeliveryScopesSatisfied(grantedScopes: readonly string[]): boolean {
  const granted = new Set(grantedScopes);
  return SLACK_BOT_DELIVERY_SCOPES.every((scope) => granted.has(scope));
}

export function isSlackBotConfigured() {
  return SLACK_BOT_ENVS.every((name) => Boolean(process.env[name]?.trim()));
}

export function slackBotSigningSecret() {
  return process.env.OPENCOMPANY_SLACK_BOT_SIGNING_SECRET?.trim();
}

export function createSlackBotState(input: Omit<SlackBotStatePayload, "expiresAt" | "nonce">) {
  const payload: SlackBotStatePayload = {
    ...input,
    returnTo: sanitizeReturnTo(input.returnTo),
    expiresAt: Date.now() + 10 * 60 * 1000,
    nonce: randomUUID(),
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${signStateBody(body)}`;
}

export function verifySlackBotState(state: string): SlackBotStatePayload {
  const [body, signature] = state.split(".");
  if (!body || !signature || !safeEqual(signature, signStateBody(body))) {
    throw new Error("Invalid Slack bot integration state.");
  }

  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
  if (!isSlackBotStatePayload(payload)) {
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

export function buildSlackBotAuthorizationUrl(state: string) {
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", requiredEnv("OPENCOMPANY_SLACK_BOT_CLIENT_ID"));
  // scope (not user_scope): we request a bot token only.
  url.searchParams.set("scope", SLACK_BOT_SCOPES.join(","));
  url.searchParams.set("redirect_uri", slackBotCallbackUrl());
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeSlackBotCode(code: string): Promise<SlackBotOAuthResult> {
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
      client_id: requiredEnv("OPENCOMPANY_SLACK_BOT_CLIENT_ID"),
      client_secret: requiredEnv("OPENCOMPANY_SLACK_BOT_CLIENT_SECRET"),
      code,
      redirect_uri: slackBotCallbackUrl(),
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

export function appendSlackBotSetupStatus(
  returnTo: string,
  status: "connected" | "error",
  reason?: string,
) {
  const url = new URL(sanitizeReturnTo(returnTo), getAppUrl());
  url.searchParams.set("integration", "slack_bot");
  url.searchParams.set("setup", status);
  if (status === "error" && reason) url.searchParams.set("reason", reason);
  return `${url.pathname}${url.search}`;
}

function slackBotCallbackUrl() {
  return `${getAppUrl()}/api/integrations/slack-bot/callback`;
}

function isSlackBotStatePayload(value: unknown): value is SlackBotStatePayload {
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
  return createHmac("sha256", requiredEnv("OPENCOMPANY_SLACK_BOT_STATE_SECRET"))
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
  if (!value) throw new Error(`${name} is required for the opencompany Slack bot integration.`);
  return value;
}
