import type { RemoteMcpConnectionState } from "../actions/remote-mcp";
import { createGmailMcpTicket, type GmailMcpOperation } from "./gmail-mcp-ticket";
import { gmailMcpScopesSatisfied } from "./gmail-scopes";
import { GoogleAccessAuthError, getGoogleAccessToken } from "./google-access-token";
import { loadGmailIntegration } from "./google-data";
import { createRemoteMcpStaticBearerAuthProvider } from "./remote-mcp-static-bearer";

export const GMAIL_MCP_ENDPOINT_URL = "https://api.opencompany.chat/mcp/plugins/gmail";

export function gmailMcpRuntimeEndpointUrl() {
  const configuredOrigin = process.env.OPENCOMPANY_API_ORIGIN?.trim();
  if (!configuredOrigin) return GMAIL_MCP_ENDPOINT_URL;
  try {
    const origin = new URL(configuredOrigin);
    if (origin.protocol !== "https:" && origin.hostname !== "localhost") {
      return GMAIL_MCP_ENDPOINT_URL;
    }
    return new URL("/mcp/plugins/gmail", origin).toString();
  } catch {
    return GMAIL_MCP_ENDPOINT_URL;
  }
}

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
  workspaceId: string;
  registrationId: string;
  operation: GmailMcpOperation;
  onAuthorizationRequired: () => never;
}) {
  const row = await loadGmailIntegration({ userWorkosId: input.userWorkosId });
  if (!row || row.status === "disconnected") return { ok: false, reason: "not_connected" } as const;
  if (row.status !== "connected" || !gmailMcpScopesSatisfied(row.scopes)) {
    return { ok: false, reason: "needs_reauth" } as const;
  }

  try {
    // Validate/refresh the provider credential before starting the MCP
    // handshake, but never use that broad Google token as MCP authentication.
    await getGoogleAccessToken({
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

  const internalSecret = process.env.API_INTERNAL_TOKEN?.trim();
  if (!internalSecret) {
    throw new Error("Gmail MCP is not configured: API_INTERNAL_TOKEN is missing.");
  }
  const { ticket } = createGmailMcpTicket({
    userWorkosId: input.userWorkosId,
    workspaceId: input.workspaceId,
    integrationId: row.id,
    registrationId: input.registrationId,
    operation: input.operation,
    secret: internalSecret,
  });

  return {
    ok: true,
    integrationId: row.id,
    authProvider: createRemoteMcpStaticBearerAuthProvider({
      accessToken: ticket,
      onAuthorizationRequired: async () => {
        return input.onAuthorizationRequired();
      },
    }),
  } as const;
}
