import { getDb } from "@opencompany/db/client";
import { workspaceMcpServers } from "@opencompany/db/schema";
import { and, eq } from "drizzle-orm";
import { loadMcpCredential } from "@/lib/mcp/credential-storage";

/**
 * Resolves the bearer token stored for a workspace's MCP server so server code
 * can call the provider's plain API directly (e.g. Linear GraphQL, PostHog
 * Query API). The MCP OAuth flow stores standard provider OAuth tokens — the
 * MCP endpoint is just where they were minted, not the only place they work.
 *
 * Returns null when the server isn't configured or holds no usable credential.
 */
export async function loadMcpAccessToken(
  workspaceId: string,
  serverKey: string,
): Promise<string | null> {
  const db = getDb();
  const [server] = await db
    .select({ id: workspaceMcpServers.id, status: workspaceMcpServers.status })
    .from(workspaceMcpServers)
    .where(
      and(
        eq(workspaceMcpServers.workspaceId, workspaceId),
        eq(workspaceMcpServers.serverKey, serverKey),
      ),
    )
    .limit(1);
  if (!server || server.status !== "configured") return null;

  const oauth = await loadMcpCredential({ workspaceId, serverId: server.id, kind: "oauth" });
  const oauthToken = readOAuthAccessToken(oauth?.payload);
  if (oauthToken) return oauthToken;

  // Linear historically also supported a raw bearer token credential.
  const bearer = await loadMcpCredential({
    workspaceId,
    serverId: server.id,
    kind: "bearer_token",
  });
  return bearer?.bearerToken ?? null;
}

function readOAuthAccessToken(payload: Record<string, unknown> | undefined): string | null {
  if (!payload) return null;
  const tokens = payload.tokens;
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) return null;
  const accessToken = (tokens as Record<string, unknown>).access_token;
  return typeof accessToken === "string" && accessToken.length > 0 ? accessToken : null;
}
