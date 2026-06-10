import { upsertSlackMcpServer } from "@/lib/mcp/actions";
import { slackMcpOAuth } from "@/lib/mcp/oauth-providers";
import { createMcpOAuthCallbackRoute } from "@/lib/mcp/oauth-routes";

export const GET = createMcpOAuthCallbackRoute(slackMcpOAuth, upsertSlackMcpServer);
