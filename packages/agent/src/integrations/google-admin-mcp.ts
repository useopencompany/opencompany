import type { RemoteMcpConnectionState } from "../actions/remote-mcp";
import { GoogleAccessAuthError, getGoogleAccessToken } from "./google-access-token";
import {
  createGoogleAdminMcpTicket,
  type GoogleAdminMcpOperation,
} from "./google-admin-mcp-ticket";
import { googleAdminMcpScopesSatisfied } from "./google-admin-scopes";
import { loadGoogleAdminIntegration } from "./google-data";
import { createRemoteMcpStaticBearerAuthProvider } from "./remote-mcp-static-bearer";

export const GOOGLE_ADMIN_MCP_ENDPOINT_URL =
  "https://api.opencompany.chat/mcp/plugins/google-admin";

export function googleAdminMcpRuntimeEndpointUrl() {
  const configuredOrigin = process.env.OPENCOMPANY_API_ORIGIN?.trim();
  if (!configuredOrigin) return GOOGLE_ADMIN_MCP_ENDPOINT_URL;
  try {
    const origin = new URL(configuredOrigin);
    if (
      origin.protocol !== "https:" &&
      !(origin.protocol === "http:" && origin.hostname === "localhost")
    ) {
      return GOOGLE_ADMIN_MCP_ENDPOINT_URL;
    }
    return new URL("/mcp/plugins/google-admin", origin).toString();
  } catch {
    return GOOGLE_ADMIN_MCP_ENDPOINT_URL;
  }
}

export async function getGoogleAdminMcpIntegrationState(
  identity: string | { userWorkosId: string },
): Promise<RemoteMcpConnectionState> {
  const userWorkosId = typeof identity === "string" ? identity : identity.userWorkosId;
  const row = await loadGoogleAdminIntegration({ userWorkosId });
  if (!row || row.status === "disconnected") {
    return {
      connected: false,
      integrationId: null,
      capabilityModes: {},
      toolModes: {},
    };
  }
  return {
    connected: row.status === "connected" && googleAdminMcpScopesSatisfied(row.scopes ?? []),
    integrationId: row.id,
    capabilityModes: row.capabilityModes,
    toolModes: row.toolModes,
  };
}

export async function loadGoogleAdminMcpWorkerConnection(input: {
  userWorkosId: string;
  workspaceId: string;
  registrationId: string;
  operation: GoogleAdminMcpOperation;
  onAuthorizationRequired: () => never;
}) {
  const row = await loadGoogleAdminIntegration({ userWorkosId: input.userWorkosId });
  if (!row || row.status === "disconnected") {
    return { ok: false, reason: "not_connected" } as const;
  }
  if (row.status !== "connected" || !googleAdminMcpScopesSatisfied(row.scopes ?? [])) {
    return { ok: false, reason: "needs_reauth" } as const;
  }

  const connection = {
    userWorkosId: row.userWorkosId,
    integrationId: row.id,
    provider: "google_admin" as const,
  };
  try {
    // Validate/refresh the provider credential before starting the MCP
    // handshake, but never use that broad Google token as MCP authentication.
    await getGoogleAccessToken(connection);
  } catch (error) {
    if (error instanceof GoogleAccessAuthError) {
      return { ok: false, reason: "needs_reauth" } as const;
    }
    throw error;
  }

  const internalSecret = process.env.API_INTERNAL_TOKEN?.trim();
  if (!internalSecret) {
    throw new Error("Google Admin MCP is not configured: API_INTERNAL_TOKEN is missing.");
  }
  const { ticket } = createGoogleAdminMcpTicket({
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
