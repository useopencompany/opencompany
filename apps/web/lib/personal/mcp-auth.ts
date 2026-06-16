import { authenticatePersonalMcpOAuthAccessToken } from "@/lib/personal/mcp-oauth";
import { authenticatePersonalMcpToken } from "@/lib/personal/mcp-tokens";

export type OpenCompanyMcpAuth = {
  workspaceId: string;
  userId: string;
  tokenId: string;
  kind: "personal_token" | "oauth";
  clientId?: string;
};

export async function authenticateOpenCompanyMcpAuthorization(
  authorizationHeader: string | null,
): Promise<OpenCompanyMcpAuth | null> {
  const personalToken = await authenticatePersonalMcpToken(authorizationHeader);
  if (personalToken) return { ...personalToken, kind: "personal_token" };

  const oauthToken = await authenticatePersonalMcpOAuthAccessToken(authorizationHeader);
  if (!oauthToken) return null;
  return {
    tokenId: oauthToken.tokenId,
    workspaceId: oauthToken.workspaceId,
    userId: oauthToken.userId,
    clientId: oauthToken.clientId,
    kind: "oauth",
  };
}
