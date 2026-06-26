import {
  CONNECTOR_LINEAR_MCP_DISPLAY_NAME,
  CONNECTOR_LINEAR_MCP_ENDPOINT_URL,
  CONNECTOR_LINEAR_MCP_OAUTH_CREDENTIAL_KIND,
  CONNECTOR_LINEAR_MCP_SERVER_KEY,
} from "./data";
import { createConnectorMcpOAuthProvider } from "./oauth-provider";

export const connectorLinearMcpOAuth = createConnectorMcpOAuthProvider({
  key: CONNECTOR_LINEAR_MCP_SERVER_KEY,
  displayName: CONNECTOR_LINEAR_MCP_DISPLAY_NAME,
  endpointUrl: CONNECTOR_LINEAR_MCP_ENDPOINT_URL,
  credentialKind: CONNECTOR_LINEAR_MCP_OAUTH_CREDENTIAL_KIND,
});
