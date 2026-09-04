import { createRemoteMcpIntegration, type RemoteMcpProviderState } from "./remote-mcp-oauth";

export const GRANOLA_MCP_ENDPOINT_URL = "https://mcp.granola.ai/mcp";
export const GRANOLA_MCP_EXTERNAL_ID = "granola_mcp";

const granolaMcpIntegration = createRemoteMcpIntegration({
  provider: "granola",
  displayName: "Granola",
  endpointUrl: GRANOLA_MCP_ENDPOINT_URL,
  externalId: GRANOLA_MCP_EXTERNAL_ID,
  storedScopes: ["mcp"],
  routeSegment: "granola-mcp",
});

export type GranolaMcpProviderState = RemoteMcpProviderState<"granola">;

export const getGranolaMcpIntegrationState = granolaMcpIntegration.getState;
export const loadGranolaMcpWorkerConnection = granolaMcpIntegration.loadWorkerConnection;
export const startGranolaMcpOAuth = granolaMcpIntegration.start;
export const completeGranolaMcpOAuth = granolaMcpIntegration.complete;
export const verifyGranolaMcpState = granolaMcpIntegration.verifyState;
export const appendGranolaMcpStatus = granolaMcpIntegration.appendStatus;
