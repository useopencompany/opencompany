import { createRemoteMcpIntegration, type RemoteMcpProviderState } from "./remote-mcp-oauth";

export const VERCEL_MCP_ENDPOINT_URL = "https://mcp.vercel.com";

const vercelMcpIntegration = createRemoteMcpIntegration({
  provider: "vercel",
  displayName: "Vercel",
  endpointUrl: VERCEL_MCP_ENDPOINT_URL,
  externalId: "vercel_mcp",
  storedScopes: ["openid"],
  authScope: "openid",
});

export type VercelProviderState = RemoteMcpProviderState<"vercel">;

export const getVercelIntegrationState = vercelMcpIntegration.getState;
export const loadVercelMcpWorkerConnection = vercelMcpIntegration.loadWorkerConnection;
export const startVercelMcpOAuth = vercelMcpIntegration.start;
export const completeVercelMcpOAuth = vercelMcpIntegration.complete;
export const verifyVercelMcpState = vercelMcpIntegration.verifyState;
export const appendVercelMcpStatus = vercelMcpIntegration.appendStatus;
