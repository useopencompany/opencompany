import { createRemoteMcpIntegration, type RemoteMcpProviderState } from "./remote-mcp-oauth";

export const ATTIO_MCP_ENDPOINT_URL = "https://mcp.attio.com/mcp";

const ATTIO_MCP_SCOPES = ["openid", "offline_access", "mcp"] as const;

const attioMcpIntegration = createRemoteMcpIntegration({
  provider: "attio",
  displayName: "Attio",
  endpointUrl: ATTIO_MCP_ENDPOINT_URL,
  externalId: "attio_mcp",
  storedScopes: ATTIO_MCP_SCOPES,
  authScope: ATTIO_MCP_SCOPES.join(" "),
  routeSegment: "attio-mcp",
});

export type AttioMcpProviderState = RemoteMcpProviderState<"attio">;

export const getAttioMcpIntegrationState = attioMcpIntegration.getState;
export const loadAttioMcpWorkerConnection = attioMcpIntegration.loadWorkerConnection;
export const startAttioMcpOAuth = attioMcpIntegration.start;
export const completeAttioMcpOAuth = attioMcpIntegration.complete;
export const verifyAttioMcpState = attioMcpIntegration.verifyState;
export const appendAttioMcpStatus = attioMcpIntegration.appendStatus;
