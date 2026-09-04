import type { OAuthClientInformation } from "@ai-sdk/mcp";
import { createRemoteMcpIntegration, type RemoteMcpProviderState } from "./remote-mcp-oauth";

export const HUBSPOT_MCP_ENDPOINT_URL = "https://mcp.hubspot.com";

export function hubspotMcpClientInformation(): OAuthClientInformation {
  return {
    client_id: requiredEnv("OPENCOMPANY_HUBSPOT_MCP_CLIENT_ID"),
    client_secret: requiredEnv("OPENCOMPANY_HUBSPOT_MCP_CLIENT_SECRET"),
  };
}

const hubspotMcpIntegration = createRemoteMcpIntegration({
  provider: "hubspot",
  displayName: "HubSpot",
  endpointUrl: HUBSPOT_MCP_ENDPOINT_URL,
  externalId: "hubspot_mcp",
  storedScopes: [],
  routeSegment: "hubspot-mcp",
  staticClientInformation: hubspotMcpClientInformation,
});

export type HubSpotProviderState = RemoteMcpProviderState<"hubspot">;

export const getHubSpotMcpIntegrationState = hubspotMcpIntegration.getState;
export const loadHubSpotMcpWorkerConnection = hubspotMcpIntegration.loadWorkerConnection;
export const startHubSpotMcpOAuth = hubspotMcpIntegration.start;
export const completeHubSpotMcpOAuth = hubspotMcpIntegration.complete;
export const verifyHubSpotMcpState = hubspotMcpIntegration.verifyState;
export const appendHubSpotMcpStatus = hubspotMcpIntegration.appendStatus;

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`HubSpot MCP is not configured: ${name} is missing.`);
  return value;
}
