import { createRemoteMcpIntegration, type RemoteMcpProviderState } from "./remote-mcp-oauth";

export const LATITUDE_MCP_ENDPOINT_URL = "https://api.latitude.so/v1/mcp";
const LATITUDE_PROVIDER = "latitude" as const;

const latitudeMcpIntegration = createRemoteMcpIntegration({
  provider: LATITUDE_PROVIDER,
  displayName: "Latitude",
  endpointUrl: LATITUDE_MCP_ENDPOINT_URL,
  externalId: "latitude_mcp",
  // Latitude's protected-resource metadata does not advertise MCP scopes.
  // Read/write controls are app capability modes, not claimed OAuth grants.
  storedScopes: [],
});

export type LatitudeProviderState = RemoteMcpProviderState<"latitude">;

export const getLatitudeIntegrationState = latitudeMcpIntegration.getState;
export const loadLatitudeMcpWorkerConnection = latitudeMcpIntegration.loadWorkerConnection;
export const startLatitudeMcpOAuth = latitudeMcpIntegration.start;
export const completeLatitudeMcpOAuth = latitudeMcpIntegration.complete;
export const verifyLatitudeMcpState = latitudeMcpIntegration.verifyState;
export const appendLatitudeMcpStatus = latitudeMcpIntegration.appendStatus;
