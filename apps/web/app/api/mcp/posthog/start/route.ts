import { upsertPostHogMcpServer } from "@/lib/mcp/actions";
import { posthogMcpOAuth } from "@/lib/mcp/oauth-providers";
import { createMcpOAuthStartRoute } from "@/lib/mcp/oauth-routes";

export const GET = createMcpOAuthStartRoute(posthogMcpOAuth, upsertPostHogMcpServer);
