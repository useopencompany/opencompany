import { createRemoteMcpIntegration, type RemoteMcpProviderState } from "./remote-mcp-oauth";

export const FATHOM_MCP_ENDPOINT_URL = "https://api.fathom.ai/mcp";
export const FATHOM_MCP_EXTERNAL_ID = "fathom_mcp";

const fathomMcpIntegration = createRemoteMcpIntegration({
  provider: "fathom",
  displayName: "Fathom",
  endpointUrl: FATHOM_MCP_ENDPOINT_URL,
  externalId: FATHOM_MCP_EXTERNAL_ID,
  storedScopes: ["mcp"],
  authScope: "mcp",
  clientGrantTypes: ["authorization_code"],
  routeSegment: "fathom-mcp",
});

export type FathomMcpProviderState = RemoteMcpProviderState<"fathom">;

export const getFathomMcpIntegrationState = fathomMcpIntegration.getState;
export const loadFathomMcpWorkerConnection = fathomMcpIntegration.loadWorkerConnection;
export const startFathomMcpOAuth = fathomMcpIntegration.start;
export const completeFathomMcpOAuth = fathomMcpIntegration.complete;
export const verifyFathomMcpState = fathomMcpIntegration.verifyState;
export const appendFathomMcpStatus = fathomMcpIntegration.appendStatus;
