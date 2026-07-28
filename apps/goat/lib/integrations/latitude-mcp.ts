import {
  createGoatRemoteMcpIntegration,
  type GoatRemoteMcpProviderState,
} from "@/lib/integrations/remote-mcp-oauth";

export const GOAT_LATITUDE_MCP_ENDPOINT_URL = "https://api.latitude.so/v1/mcp";
const GOAT_LATITUDE_PROVIDER = "latitude" as const;

const latitudeMcpIntegration = createGoatRemoteMcpIntegration({
  provider: GOAT_LATITUDE_PROVIDER,
  displayName: "Latitude",
  endpointUrl: GOAT_LATITUDE_MCP_ENDPOINT_URL,
  externalId: "latitude_mcp",
  // Latitude's protected-resource metadata does not advertise MCP scopes.
  // Read/write controls are Goat capability modes, not claimed OAuth grants.
  storedScopes: [],
});

export type GoatLatitudeProviderState = GoatRemoteMcpProviderState<"latitude">;

export const getGoatLatitudeIntegrationState = latitudeMcpIntegration.getState;
export const loadGoatLatitudeMcpWorkerConnection = latitudeMcpIntegration.loadWorkerConnection;
export const startGoatLatitudeMcpOAuth = latitudeMcpIntegration.start;
export const completeGoatLatitudeMcpOAuth = latitudeMcpIntegration.complete;
export const verifyGoatLatitudeMcpState = latitudeMcpIntegration.verifyState;
export const appendGoatLatitudeMcpStatus = latitudeMcpIntegration.appendStatus;
