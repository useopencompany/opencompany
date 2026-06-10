import { upsertPostHogMcpServer } from "@/lib/mcp/actions";
import { posthogMcpOAuth } from "@/lib/mcp/oauth-providers";
import { createMcpOAuthCallbackRoute } from "@/lib/mcp/oauth-routes";

export const GET = createMcpOAuthCallbackRoute(posthogMcpOAuth, upsertPostHogMcpServer);
