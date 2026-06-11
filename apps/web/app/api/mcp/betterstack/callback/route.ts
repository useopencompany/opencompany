import { upsertBetterStackMcpServer } from "@/lib/mcp/actions";
import { betterstackMcpOAuth } from "@/lib/mcp/oauth-providers";
import { createMcpOAuthCallbackRoute } from "@/lib/mcp/oauth-routes";

export const GET = createMcpOAuthCallbackRoute(betterstackMcpOAuth, upsertBetterStackMcpServer);
