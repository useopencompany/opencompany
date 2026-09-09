import { createRemoteMcpIntegration, type RemoteMcpProviderState } from "./remote-mcp-oauth";

export const RESEND_MCP_ENDPOINT_URL = "https://mcp.resend.com/mcp";

const resendMcpIntegration = createRemoteMcpIntegration({
  provider: "resend",
  displayName: "Resend",
  endpointUrl: RESEND_MCP_ENDPOINT_URL,
  externalId: "resend_mcp",
  storedScopes: ["full_access"],
  authScope: "full_access",
});

export type ResendMcpProviderState = RemoteMcpProviderState<"resend">;

export const getResendMcpIntegrationState = resendMcpIntegration.getState;
export const loadResendMcpWorkerConnection = resendMcpIntegration.loadWorkerConnection;
export const startResendMcpOAuth = resendMcpIntegration.start;
export const completeResendMcpOAuth = resendMcpIntegration.complete;
export const verifyResendMcpState = resendMcpIntegration.verifyState;
export const appendResendMcpStatus = resendMcpIntegration.appendStatus;
