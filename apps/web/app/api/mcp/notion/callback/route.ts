import { upsertNotionMcpServer } from "@/lib/mcp/actions";
import { notionMcpOAuth } from "@/lib/mcp/oauth-providers";
import { createMcpOAuthCallbackRoute } from "@/lib/mcp/oauth-routes";

export const GET = createMcpOAuthCallbackRoute(notionMcpOAuth, upsertNotionMcpServer);
