// Slack's hosted MCP server only accepts the user scopes advertised by its
// protected-resource metadata. This list also distinguishes official plugin
// grants from the narrower tokens created by the retired ingestion flow.
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

export const SLACK_MCP_RECONNECT_REASON =
  "Reconnect Slack to grant the permissions required by the official plugin.";

export function slackMcpScopesSatisfied(scopes: readonly string[]): boolean {
  const granted = new Set(scopes);
  return SLACK_MCP_USER_SCOPES.every((scope) => granted.has(scope));
}
