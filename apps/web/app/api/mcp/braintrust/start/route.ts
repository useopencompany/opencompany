import { upsertBraintrustMcpServer } from "@/lib/mcp/actions";
import { braintrustMcpOAuth } from "@/lib/mcp/oauth-providers";
import { createMcpOAuthStartRoute } from "@/lib/mcp/oauth-routes";

export const GET = createMcpOAuthStartRoute(braintrustMcpOAuth, upsertBraintrustMcpServer);
