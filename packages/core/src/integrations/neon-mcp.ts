import { createRemoteMcpIntegration, type RemoteMcpProviderState } from "./remote-mcp-oauth";

// OAuth scope and URL configuration both force Neon's hosted MCP into read-only
// mode. Categories narrow provider discovery before Goat applies its own strict
// tool allowlist in actions/neon.ts.
export const GOAT_NEON_MCP_ENDPOINT_URL =
  "https://mcp.neon.tech/mcp?readonly=true&category=projects&category=branches&category=schema&category=querying";

const neonMcpIntegration = createRemoteMcpIntegration({
  provider: "neon",
  displayName: "Neon",
  endpointUrl: GOAT_NEON_MCP_ENDPOINT_URL,
  externalId: "neon_mcp",
  storedScopes: ["read"],
  authScope: "read",
});

export type NeonProviderState = RemoteMcpProviderState<"neon">;

export const getNeonIntegrationState = neonMcpIntegration.getState;
export const loadNeonMcpWorkerConnection = neonMcpIntegration.loadWorkerConnection;
export const startNeonMcpOAuth = neonMcpIntegration.start;
export const completeNeonMcpOAuth = neonMcpIntegration.complete;
export const verifyNeonMcpState = neonMcpIntegration.verifyState;
export const appendNeonMcpStatus = neonMcpIntegration.appendStatus;
