import { upsertSlackMcpServer } from "@/lib/mcp/actions";
import { slackMcpOAuth } from "@/lib/mcp/oauth-providers";
import { createMcpOAuthStartRoute } from "@/lib/mcp/oauth-routes";

export const GET = createMcpOAuthStartRoute(slackMcpOAuth, upsertSlackMcpServer);
