import { createRemoteMcpIntegration } from "./remote-mcp-oauth";

export const STRIPE_MCP_ENDPOINT_URL = "https://mcp.stripe.com";

const stripeMcpIntegration = createRemoteMcpIntegration({
  provider: "stripe",
  displayName: "Stripe",
  endpointUrl: STRIPE_MCP_ENDPOINT_URL,
  externalId: "stripe_mcp",
  storedScopes: [],
});

export const getStripeOAuthIntegrationState = stripeMcpIntegration.getState;
export const loadStripeOAuthWorkerConnection = stripeMcpIntegration.loadWorkerConnection;
export const startStripeMcpOAuth = stripeMcpIntegration.start;
export const completeStripeMcpOAuth = stripeMcpIntegration.complete;
export const verifyStripeMcpState = stripeMcpIntegration.verifyState;
export const appendStripeMcpStatus = stripeMcpIntegration.appendStatus;
