import { createRemoteMcpIntegration, type RemoteMcpProviderState } from "./remote-mcp-oauth";

// Agent Plugin packages are immutable, so the official integration currently
// supports SigNoz's US Cloud MCP endpoint only. The fixed URL is also the
// credential trust boundary enforced by plugin-gateway.ts.
export const SIGNOZ_MCP_ENDPOINT_URL = "https://mcp.us.signoz.cloud/mcp";

const signozMcpIntegration = createRemoteMcpIntegration({
  provider: "signoz",
  displayName: "SigNoz",
  endpointUrl: SIGNOZ_MCP_ENDPOINT_URL,
  externalId: "signoz_mcp_us",
  // SigNoz's protected-resource metadata does not advertise OAuth scopes.
  // Read/write controls are opencompany capability modes, not claimed grants.
  storedScopes: [],
});

export type SigNozProviderState = RemoteMcpProviderState<"signoz">;

export const getSigNozIntegrationState = signozMcpIntegration.getState;
export const loadSigNozMcpWorkerConnection = signozMcpIntegration.loadWorkerConnection;
export const startSigNozMcpOAuth = signozMcpIntegration.start;
export const completeSigNozMcpOAuth = signozMcpIntegration.complete;
export const verifySigNozMcpState = signozMcpIntegration.verifyState;
export const appendSigNozMcpStatus = signozMcpIntegration.appendStatus;
