import { upsertLinearMcpServer } from "@/lib/mcp/actions";
import { linearMcpOAuth } from "@/lib/mcp/oauth-providers";
import { createMcpOAuthCallbackRoute } from "@/lib/mcp/oauth-routes";

export const GET = createMcpOAuthCallbackRoute(linearMcpOAuth, upsertLinearMcpServer);
