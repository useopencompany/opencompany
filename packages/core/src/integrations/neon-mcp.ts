import {
  createGoatRemoteMcpIntegration,
  type GoatRemoteMcpProviderState,
} from "./remote-mcp-oauth";

// OAuth scope and URL configuration both force Neon's hosted MCP into read-only
// mode. Categories narrow provider discovery before Goat applies its own strict
// tool allowlist in actions/neon.ts.
export const GOAT_NEON_MCP_ENDPOINT_URL =
  "https://mcp.neon.tech/mcp?readonly=true&category=projects&category=branches&category=schema&category=querying";

const neonMcpIntegration = createGoatRemoteMcpIntegration({
  provider: "neon",
  displayName: "Neon",
  endpointUrl: GOAT_NEON_MCP_ENDPOINT_URL,
  externalId: "neon_mcp",
  storedScopes: ["read"],
  authScope: "read",
});

export type GoatNeonProviderState = GoatRemoteMcpProviderState<"neon">;

export const getGoatNeonIntegrationState = neonMcpIntegration.getState;
export const loadGoatNeonMcpWorkerConnection = neonMcpIntegration.loadWorkerConnection;
export const startGoatNeonMcpOAuth = neonMcpIntegration.start;
export const completeGoatNeonMcpOAuth = neonMcpIntegration.complete;
export const verifyGoatNeonMcpState = neonMcpIntegration.verifyState;
export const appendGoatNeonMcpStatus = neonMcpIntegration.appendStatus;
