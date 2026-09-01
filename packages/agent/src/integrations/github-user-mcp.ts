import { markIntegrationStatus } from "@opencompany/db/integrations";
import {
  GitHubUserAccessAuthError,
  getGitHubUserAccessToken,
  getGitHubUserIntegrationState,
  loadGitHubUserIntegration,
} from "./github-user";
import { createRemoteMcpStaticBearerAuthProvider } from "./remote-mcp-static-bearer";

export const GITHUB_USER_MCP_ENDPOINT_URL = "https://api.githubcopilot.com/mcp/";

export const getGitHubUserMcpIntegrationState = getGitHubUserIntegrationState;

export async function loadGitHubUserMcpWorkerConnection(input: {
  userWorkosId: string;
  workspaceId?: string;
  onAuthorizationRequired: () => never;
}) {
  const row = await loadGitHubUserIntegration({ userWorkosId: input.userWorkosId });
  if (!row || row.status === "disconnected") return { ok: false, reason: "not_connected" } as const;
  if (row.status !== "connected") return { ok: false, reason: "needs_reauth" } as const;

  let accessToken: string;
  try {
    accessToken = await getGitHubUserAccessToken({
      userWorkosId: row.userWorkosId,
      integrationId: row.id,
    });
  } catch (error) {
    if (error instanceof GitHubUserAccessAuthError) {
      return { ok: false, reason: "needs_reauth" } as const;
    }
    throw error;
  }

  return {
    ok: true,
    integrationId: row.id,
    authProvider: createRemoteMcpStaticBearerAuthProvider({
      accessToken,
      onAuthorizationRequired: async () => {
        await markIntegrationStatus({
          userWorkosId: row.userWorkosId,
          integrationId: row.id,
          provider: "github_user",
          status: "needs_reauth",
          statusReason: "GitHub authorization expired. Reconnect GitHub in Settings.",
        });
        return input.onAuthorizationRequired();
      },
    }),
  } as const;
}
