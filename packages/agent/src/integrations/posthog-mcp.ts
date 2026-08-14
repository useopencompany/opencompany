import { createRemoteMcpIntegration, type RemoteMcpProviderState } from "./remote-mcp-oauth";

const POSTHOG_TOOL_NAMES = [
  "dashboards-get-all",
  "dashboard-get",
  "dashboard-insights-run",
  "insights-list",
  "insight-get",
  "insight-query",
  "read-data-schema",
  "query-trends",
  "query-funnel",
  "query-retention",
  "query-paths",
  "query-stickiness",
  "query-lifecycle",
  "insight-create",
] as const;

const POSTHOG_OAUTH_SCOPES = [
  "dashboard:read",
  "insight:read",
  "query:read",
  "event_definition:read",
  "property_definition:read",
  "insight:write",
] as const;

export const POSTHOG_MCP_ENDPOINT_URL = `https://mcp.posthog.com/mcp?mode=tools&tools=${POSTHOG_TOOL_NAMES.join(
  ",",
)}`;

const posthogMcpIntegration = createRemoteMcpIntegration({
  provider: "posthog",
  displayName: "PostHog",
  endpointUrl: POSTHOG_MCP_ENDPOINT_URL,
  externalId: "posthog_mcp",
  storedScopes: POSTHOG_OAUTH_SCOPES,
  authScope: POSTHOG_OAUTH_SCOPES.join(" "),
});

export type PostHogProviderState = RemoteMcpProviderState<"posthog">;

export const getPostHogIntegrationState = posthogMcpIntegration.getState;
export const loadPostHogMcpWorkerConnection = posthogMcpIntegration.loadWorkerConnection;
export const startPostHogMcpOAuth = posthogMcpIntegration.start;
export const completePostHogMcpOAuth = posthogMcpIntegration.complete;
export const verifyPostHogMcpState = posthogMcpIntegration.verifyState;
export const appendPostHogMcpStatus = posthogMcpIntegration.appendStatus;
