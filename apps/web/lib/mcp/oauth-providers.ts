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
  POSTHOG_MCP_ENDPOINT_URL,
  POSTHOG_MCP_OAUTH_CREDENTIAL_KIND,
  POSTHOG_MCP_SERVER_KEY,
  SLACK_MCP_ENDPOINT_URL,
  SLACK_MCP_OAUTH_CREDENTIAL_KIND,
  SLACK_MCP_SERVER_KEY,
} from "@/lib/mcp/data";
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

export const mcpOAuthProviders = {
  linear: linearMcpOAuth,
  slack: slackMcpOAuth,
  posthog: posthogMcpOAuth,
  betterstack: betterstackMcpOAuth,
  braintrust: braintrustMcpOAuth,
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
