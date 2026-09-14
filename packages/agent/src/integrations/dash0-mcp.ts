import { createDash0McpClient, DASH0_MCP_ENDPOINT_URL } from "./dash0-mcp-transport";
import { createRemoteMcpIntegration, type RemoteMcpProviderState } from "./remote-mcp-oauth";

export { DASH0_MCP_ENDPOINT_URL } from "./dash0-mcp-transport";

const dash0McpIntegration = createRemoteMcpIntegration({
  provider: "dash0",
  displayName: "Dash0",
  endpointUrl: DASH0_MCP_ENDPOINT_URL,
  // Preserve existing connections; Ireland is the bootstrap endpoint, not the organization region.
  externalId: "dash0_mcp_eu_west_1",
  // Dash0 advertises only this scope. Capability modes still gate individual tools.
  storedScopes: ["*"],
  authScope: "*",
});

export type Dash0ProviderState = RemoteMcpProviderState<"dash0">;
export const getDash0IntegrationState = dash0McpIntegration.getState;
export async function loadDash0McpWorkerConnection(
  input: Parameters<typeof dash0McpIntegration.loadWorkerConnection>[0],
) {
  const connection = await dash0McpIntegration.loadWorkerConnection(input);
  return connection.ok ? { ...connection, createClient: createDash0McpClient } : connection;
}
export const startDash0McpOAuth = dash0McpIntegration.start;
export const completeDash0McpOAuth = dash0McpIntegration.complete;
export const verifyDash0McpState = dash0McpIntegration.verifyState;
export const appendDash0McpStatus = dash0McpIntegration.appendStatus;
