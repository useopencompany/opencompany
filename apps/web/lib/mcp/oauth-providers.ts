import { createHash } from "node:crypto";
import type { OAuthClientInformation } from "@ai-sdk/mcp";
import {
  BETTERSTACK_MCP_ENDPOINT_URL,
  BETTERSTACK_MCP_OAUTH_CREDENTIAL_KIND,
  BETTERSTACK_MCP_SERVER_KEY,
  BRAINTRUST_MCP_ENDPOINT_URL,
  BRAINTRUST_MCP_OAUTH_CREDENTIAL_KIND,
  BRAINTRUST_MCP_SERVER_KEY,
  LINEAR_MCP_ENDPOINT_URL,
  LINEAR_MCP_OAUTH_CREDENTIAL_KIND,
  LINEAR_MCP_SERVER_KEY,
  NOTION_MCP_ENDPOINT_URL,
  NOTION_MCP_OAUTH_CREDENTIAL_KIND,
  NOTION_MCP_SERVER_KEY,
  POSTHOG_MCP_ENDPOINT_URL,
  POSTHOG_MCP_OAUTH_CREDENTIAL_KIND,
  POSTHOG_MCP_SERVER_KEY,
  SLACK_MCP_ENDPOINT_URL,
  SLACK_MCP_OAUTH_CREDENTIAL_KIND,
  SLACK_MCP_SERVER_KEY,
} from "@/lib/mcp/data";
import type { McpOAuthAccountMetadata, McpOAuthPayload } from "@/lib/mcp/oauth-provider";
import { createMcpOAuthProvider } from "@/lib/mcp/oauth-provider";

// Per-provider MCP OAuth configuration. Adding a provider = one entry here plus the two
// thin route files under app/api/mcp/<key>/{start,callback}.

const SLACK_READ_SCOPES = [
  "search:read.public",
  "search:read.private",
  "search:read.mpim",
  "search:read.im",
  "search:read.files",
  "search:read.users",
  "channels:history",
  "groups:history",
  "mpim:history",
  "im:history",
  "files:read",
  "emoji:read",
  "users:read",
  "users:read.email",
  "channels:read",
  "groups:read",
  "mpim:read",
];

export const linearMcpOAuth = createMcpOAuthProvider({
  key: LINEAR_MCP_SERVER_KEY,
  displayName: "Linear",
  endpointUrl: LINEAR_MCP_ENDPOINT_URL,
  credentialKind: LINEAR_MCP_OAUTH_CREDENTIAL_KIND,
});

// Slack does not support dynamic client registration: client credentials come from env vars
// and are never persisted to credential storage. Slack also requires explicit read scopes.
// Production caveat: Slack reconnect is sensitive — keep this divergence intact.
export const slackMcpOAuth = createMcpOAuthProvider({
  key: SLACK_MCP_SERVER_KEY,
  displayName: "Slack",
  endpointUrl: SLACK_MCP_ENDPOINT_URL,
  credentialKind: SLACK_MCP_OAUTH_CREDENTIAL_KIND,
  authScope: SLACK_READ_SCOPES.join(" "),
  staticClientInformation: slackClientInformation,
  multipleAccounts: true,
  resolveAccountMetadata: resolveSlackMcpAccountMetadata,
  startFailureEnvHints: ["SLACK_MCP_CLIENT_ID", "SLACK_MCP_CLIENT_SECRET"],
});

export const posthogMcpOAuth = createMcpOAuthProvider({
  key: POSTHOG_MCP_SERVER_KEY,
  displayName: "PostHog",
  endpointUrl: POSTHOG_MCP_ENDPOINT_URL,
  credentialKind: POSTHOG_MCP_OAUTH_CREDENTIAL_KIND,
});

export const betterstackMcpOAuth = createMcpOAuthProvider({
  key: BETTERSTACK_MCP_SERVER_KEY,
  displayName: "Better Stack",
  endpointUrl: BETTERSTACK_MCP_ENDPOINT_URL,
  credentialKind: BETTERSTACK_MCP_OAUTH_CREDENTIAL_KIND,
});

export const braintrustMcpOAuth = createMcpOAuthProvider({
  key: BRAINTRUST_MCP_SERVER_KEY,
  displayName: "Braintrust",
  endpointUrl: BRAINTRUST_MCP_ENDPOINT_URL,
  credentialKind: BRAINTRUST_MCP_OAUTH_CREDENTIAL_KIND,
});

export const notionMcpOAuth = createMcpOAuthProvider({
  key: NOTION_MCP_SERVER_KEY,
  displayName: "Notion",
  endpointUrl: NOTION_MCP_ENDPOINT_URL,
  credentialKind: NOTION_MCP_OAUTH_CREDENTIAL_KIND,
});

export const mcpOAuthProviders = {
  linear: linearMcpOAuth,
  slack: slackMcpOAuth,
  posthog: posthogMcpOAuth,
  betterstack: betterstackMcpOAuth,
  braintrust: braintrustMcpOAuth,
  notion: notionMcpOAuth,
} as const;

function slackClientInformation(): OAuthClientInformation {
  return {
    client_id: requiredEnv("SLACK_MCP_CLIENT_ID"),
    client_secret: requiredEnv("SLACK_MCP_CLIENT_SECRET"),
  };
}

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for Slack MCP OAuth.`);
  return value;
}

async function resolveSlackMcpAccountMetadata(input: {
  payload: McpOAuthPayload;
  accountKey: string;
}): Promise<McpOAuthAccountMetadata> {
  const accessToken = input.payload.tokens?.access_token;
  const authTest = accessToken ? await fetchSlackAuthTest(accessToken).catch(() => null) : null;
  const tokenRecord: Record<string, unknown> = isRecord(input.payload.tokens)
    ? input.payload.tokens
    : {};
  const teamRecord = recordField(tokenRecord, "team");
  const authedUserRecord = recordField(tokenRecord, "authed_user");

  const teamId =
    authTest?.team_id ?? stringField(teamRecord.id) ?? stringField(tokenRecord.team_id);
  const teamName =
    authTest?.team ?? stringField(teamRecord.name) ?? stringField(tokenRecord.team_name);
  const userId =
    authTest?.user_id ?? stringField(authedUserRecord.id) ?? stringField(tokenRecord.user_id);
  const userName = authTest?.user ?? stringField(authedUserRecord.name);
  const externalAccountId = [teamId, userId].filter(Boolean).join(":") || null;

  return {
    nextAccountKey: externalAccountId
      ? `slack_${hashForAccountKey(externalAccountId)}`
      : input.accountKey,
    externalAccountId,
    accountLabel: slackAccountLabel({ teamName, userName, teamId, userId }),
    metadata: {
      ...(teamId ? { teamId } : {}),
      ...(teamName ? { teamName } : {}),
      ...(userId ? { userId } : {}),
      ...(userName ? { userName } : {}),
    },
  };
}

type SlackAuthTestResponse = {
  ok?: boolean;
  team?: string;
  team_id?: string;
  user?: string;
  user_id?: string;
};

async function fetchSlackAuthTest(accessToken: string): Promise<SlackAuthTestResponse | null> {
  const response = await fetch("https://slack.com/api/auth.test", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) return null;
  const body = (await response.json()) as SlackAuthTestResponse;
  return body.ok ? body : null;
}

function slackAccountLabel(input: {
  teamName?: string | undefined;
  userName?: string | undefined;
  teamId?: string | undefined;
  userId?: string | undefined;
}) {
  if (input.teamName && input.userName) return `${input.teamName} · ${input.userName}`;
  if (input.teamName) return input.teamName;
  if (input.teamId && input.userId) return `${input.teamId} · ${input.userId}`;
  if (input.teamId) return input.teamId;
  return "Slack account";
}

function hashForAccountKey(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function stringField(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function recordField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return isRecord(value) ? value : {};
}
