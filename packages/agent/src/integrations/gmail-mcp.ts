import type { RemoteMcpConnectionState } from "../actions/remote-mcp";
import { gmailMcpScopesSatisfied } from "./gmail-scopes";
import { GoogleAccessAuthError, getGoogleAccessToken } from "./google-access-token";
import { loadGmailIntegration } from "./google-data";
import { createRemoteMcpStaticBearerAuthProvider } from "./remote-mcp-static-bearer";

export const GMAIL_MCP_ENDPOINT_URL = "https://gmailmcp.googleapis.com/mcp/v1";

export async function getGmailMcpIntegrationState(
  identity: string | { userWorkosId: string },
): Promise<RemoteMcpConnectionState> {
  const userWorkosId = typeof identity === "string" ? identity : identity.userWorkosId;
  const row = await loadGmailIntegration({ userWorkosId });
  if (!row || row.status === "disconnected") {
    return {
      connected: false,
      integrationId: null,
      capabilityModes: {},
      toolModes: {},
    };
  }
  return {
    connected: row.status === "connected" && gmailMcpScopesSatisfied(row.scopes),
    integrationId: row.id,
    capabilityModes: row.capabilityModes,
    toolModes: row.toolModes,
  };
}

export async function loadGmailMcpWorkerConnection(input: {
  userWorkosId: string;
  onAuthorizationRequired: () => never;
}) {
  const row = await loadGmailIntegration({ userWorkosId: input.userWorkosId });
  if (!row || row.status === "disconnected") return { ok: false, reason: "not_connected" } as const;
  if (row.status !== "connected" || !gmailMcpScopesSatisfied(row.scopes)) {
    return { ok: false, reason: "needs_reauth" } as const;
  }

  let accessToken: string;
  try {
    accessToken = await getGoogleAccessToken({
      userWorkosId: row.userWorkosId,
      integrationId: row.id,
      provider: "gmail",
    });
  } catch (error) {
    if (error instanceof GoogleAccessAuthError) {
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
        try {
          await getGoogleAccessToken(
            {
              userWorkosId: row.userWorkosId,
              integrationId: row.id,
              provider: "gmail",
            },
            { forceRefresh: true },
          );
        } catch (error) {
          if (error instanceof GoogleAccessAuthError) return input.onAuthorizationRequired();
          throw error;
        }
        throw new Error("Gmail MCP rejected a freshly refreshed credential.");
      },
    }),
  } as const;
}
