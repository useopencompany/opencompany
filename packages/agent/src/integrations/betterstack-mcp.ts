import { createRemoteMcpIntegration, type RemoteMcpProviderState } from "./remote-mcp-oauth";

export const BETTERSTACK_MCP_ENDPOINT_URL = "https://mcp.betterstack.com";

const betterStackMcpIntegration = createRemoteMcpIntegration({
  provider: "betterstack",
  displayName: "Better Stack",
  endpointUrl: BETTERSTACK_MCP_ENDPOINT_URL,
  externalId: "betterstack_mcp",
  storedScopes: ["read", "write"],
  authScope: "read write",
});

export type BetterStackProviderState = RemoteMcpProviderState<"betterstack">;

export const getBetterStackIntegrationState = betterStackMcpIntegration.getState;
export const loadBetterStackMcpWorkerConnection = betterStackMcpIntegration.loadWorkerConnection;
export const startBetterStackMcpOAuth = betterStackMcpIntegration.start;
export const completeBetterStackMcpOAuth = betterStackMcpIntegration.complete;
export const verifyBetterStackMcpState = betterStackMcpIntegration.verifyState;
export const appendBetterStackMcpStatus = betterStackMcpIntegration.appendStatus;
