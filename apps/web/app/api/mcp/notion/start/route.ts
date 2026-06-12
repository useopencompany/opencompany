import { upsertNotionMcpServer } from "@/lib/mcp/actions";
import { notionMcpOAuth } from "@/lib/mcp/oauth-providers";
import { createMcpOAuthStartRoute } from "@/lib/mcp/oauth-routes";

export const GET = createMcpOAuthStartRoute(notionMcpOAuth, upsertNotionMcpServer);
