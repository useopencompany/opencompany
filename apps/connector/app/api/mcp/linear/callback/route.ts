import { upsertConnectorLinearMcpServer } from "@/lib/mcp/data";
import { connectorLinearMcpOAuth } from "@/lib/mcp/oauth-providers";
import { createConnectorMcpOAuthCallbackRoute } from "@/lib/mcp/oauth-routes";

export const GET = createConnectorMcpOAuthCallbackRoute(
  connectorLinearMcpOAuth,
  upsertConnectorLinearMcpServer,
);
