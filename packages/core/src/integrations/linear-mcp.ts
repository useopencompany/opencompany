import {
  createGoatRemoteMcpIntegration,
  type GoatRemoteMcpProviderState,
} from "./remote-mcp-oauth";

export const GOAT_LINEAR_MCP_ENDPOINT_URL = "https://mcp.linear.app/mcp";
const GOAT_LINEAR_PROVIDER = "linear" as const;

const linearMcpIntegration = createGoatRemoteMcpIntegration({
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

export type GoatLinearProviderState = GoatRemoteMcpProviderState<"linear">;

export const getGoatLinearIntegrationState = linearMcpIntegration.getState;
export const loadGoatLinearMcpWorkerConnection = linearMcpIntegration.loadWorkerConnection;
export const startGoatLinearMcpOAuth = linearMcpIntegration.start;
export const completeGoatLinearMcpOAuth = linearMcpIntegration.complete;
export const verifyGoatLinearMcpState = linearMcpIntegration.verifyState;
export const appendGoatLinearMcpStatus = linearMcpIntegration.appendStatus;
