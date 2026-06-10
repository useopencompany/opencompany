import { upsertLinearMcpServer } from "@/lib/mcp/actions";
import { linearMcpOAuth } from "@/lib/mcp/oauth-providers";
import { createMcpOAuthStartRoute } from "@/lib/mcp/oauth-routes";

export const GET = createMcpOAuthStartRoute(linearMcpOAuth, upsertLinearMcpServer);
