import { upsertBraintrustMcpServer } from "@/lib/mcp/actions";
import { braintrustMcpOAuth } from "@/lib/mcp/oauth-providers";
import { createMcpOAuthCallbackRoute } from "@/lib/mcp/oauth-routes";

export const GET = createMcpOAuthCallbackRoute(braintrustMcpOAuth, upsertBraintrustMcpServer);
