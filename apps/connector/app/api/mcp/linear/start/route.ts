import { upsertConnectorLinearMcpServer } from "@/lib/mcp/data";
import { connectorLinearMcpOAuth } from "@/lib/mcp/oauth-providers";
import { createConnectorMcpOAuthStartRoute } from "@/lib/mcp/oauth-routes";

export const GET = createConnectorMcpOAuthStartRoute(
  connectorLinearMcpOAuth,
  upsertConnectorLinearMcpServer,
);
