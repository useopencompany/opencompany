import { createRemoteMcpIntegration, type RemoteMcpProviderState } from "./remote-mcp-oauth";

// The immutable package and credential binding support AWS Ireland only.
export const DASH0_MCP_ENDPOINT_URL = "https://api.eu-west-1.aws.dash0.com/mcp";

const dash0McpIntegration = createRemoteMcpIntegration({
  provider: "dash0",
  displayName: "Dash0 (AWS Ireland)",
  endpointUrl: DASH0_MCP_ENDPOINT_URL,
  externalId: "dash0_mcp_eu_west_1",
  // Dash0 advertises only this scope. Capability modes still gate individual tools.
  storedScopes: ["*"],
  authScope: "*",
});

export type Dash0ProviderState = RemoteMcpProviderState<"dash0">;
export const getDash0IntegrationState = dash0McpIntegration.getState;
export const loadDash0McpWorkerConnection = dash0McpIntegration.loadWorkerConnection;
export const startDash0McpOAuth = dash0McpIntegration.start;
export const completeDash0McpOAuth = dash0McpIntegration.complete;
export const verifyDash0McpState = dash0McpIntegration.verifyState;
export const appendDash0McpStatus = dash0McpIntegration.appendStatus;
