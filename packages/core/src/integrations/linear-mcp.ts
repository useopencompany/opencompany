import { createRemoteMcpIntegration, type RemoteMcpProviderState } from "./remote-mcp-oauth";

export const GOAT_LINEAR_MCP_ENDPOINT_URL = "https://mcp.linear.app/mcp";
const GOAT_LINEAR_PROVIDER = "linear" as const;

const linearMcpIntegration = createRemoteMcpIntegration({
  provider: GOAT_LINEAR_PROVIDER,
  displayName: "Linear",
  endpointUrl: GOAT_LINEAR_MCP_ENDPOINT_URL,
  externalId: "linear_mcp",
  storedScopes: ["read", "write"],
  authScope: "read write",
  // States created before remote MCP OAuth was generalized did not carry a
  // provider discriminator. Keep only Linear's in-flight callbacks valid.
  acceptLegacyStateWithoutProvider: true,
});

export type LinearProviderState = RemoteMcpProviderState<"linear">;

export const getLinearIntegrationState = linearMcpIntegration.getState;
export const loadLinearMcpWorkerConnection = linearMcpIntegration.loadWorkerConnection;
export const startLinearMcpOAuth = linearMcpIntegration.start;
export const completeLinearMcpOAuth = linearMcpIntegration.complete;
export const verifyLinearMcpState = linearMcpIntegration.verifyState;
export const appendLinearMcpStatus = linearMcpIntegration.appendStatus;
