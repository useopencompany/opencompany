import {
  createGoatRemoteMcpIntegration,
  type GoatRemoteMcpProviderState,
} from "./remote-mcp-oauth";

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

export const GOAT_POSTHOG_MCP_ENDPOINT_URL = `https://mcp.posthog.com/mcp?mode=tools&tools=${POSTHOG_TOOL_NAMES.join(
  ",",
)}`;

const posthogMcpIntegration = createGoatRemoteMcpIntegration({
  provider: "posthog",
  displayName: "PostHog",
  endpointUrl: GOAT_POSTHOG_MCP_ENDPOINT_URL,
  externalId: "posthog_mcp",
  storedScopes: POSTHOG_OAUTH_SCOPES,
  authScope: POSTHOG_OAUTH_SCOPES.join(" "),
});

export type GoatPostHogProviderState = GoatRemoteMcpProviderState<"posthog">;

export const getGoatPostHogIntegrationState = posthogMcpIntegration.getState;
export const loadGoatPostHogMcpWorkerConnection = posthogMcpIntegration.loadWorkerConnection;
export const startGoatPostHogMcpOAuth = posthogMcpIntegration.start;
export const completeGoatPostHogMcpOAuth = posthogMcpIntegration.complete;
export const verifyGoatPostHogMcpState = posthogMcpIntegration.verifyState;
export const appendGoatPostHogMcpStatus = posthogMcpIntegration.appendStatus;
