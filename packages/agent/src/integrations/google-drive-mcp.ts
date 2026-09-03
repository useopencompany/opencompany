import type { RemoteMcpConnectionState } from "../actions/remote-mcp";
import { GoogleAccessAuthError, getGoogleAccessToken } from "./google-access-token";
import { loadGoogleDriveIntegration } from "./google-data";
import {
  createGoogleDriveMcpTicket,
  type GoogleDriveMcpOperation,
} from "./google-drive-mcp-ticket";
import { googleDriveMcpScopesSatisfied } from "./google-drive-scopes";
import { createRemoteMcpStaticBearerAuthProvider } from "./remote-mcp-static-bearer";

export const GOOGLE_DRIVE_MCP_ENDPOINT_URL =
  "https://api.opencompany.chat/mcp/plugins/google-drive";

export function googleDriveMcpRuntimeEndpointUrl() {
  const configuredOrigin = process.env.OPENCOMPANY_API_ORIGIN?.trim();
  if (!configuredOrigin) return GOOGLE_DRIVE_MCP_ENDPOINT_URL;
  try {
    const origin = new URL(configuredOrigin);
    if (origin.protocol !== "https:" && origin.hostname !== "localhost") {
      return GOOGLE_DRIVE_MCP_ENDPOINT_URL;
    }
    return new URL("/mcp/plugins/google-drive", origin).toString();
  } catch {
    return GOOGLE_DRIVE_MCP_ENDPOINT_URL;
  }
}

export async function getGoogleDriveMcpIntegrationState(
  identity: string | { userWorkosId: string },
): Promise<RemoteMcpConnectionState> {
  const userWorkosId = typeof identity === "string" ? identity : identity.userWorkosId;
  const row = await loadGoogleDriveIntegration({ userWorkosId });
  if (!row || row.status === "disconnected") {
    return {
      connected: false,
      integrationId: null,
      capabilityModes: {},
      toolModes: {},
    };
  }
  return {
    connected: row.status === "connected" && googleDriveMcpScopesSatisfied(row.scopes ?? []),
    integrationId: row.id,
    capabilityModes: row.capabilityModes,
    toolModes: row.toolModes,
  };
}

export async function loadGoogleDriveMcpWorkerConnection(input: {
  userWorkosId: string;
  workspaceId: string;
  registrationId: string;
  operation: GoogleDriveMcpOperation;
  onAuthorizationRequired: () => never;
}) {
  const row = await loadGoogleDriveIntegration({ userWorkosId: input.userWorkosId });
  if (!row || row.status === "disconnected") {
    return { ok: false, reason: "not_connected" } as const;
  }
  if (row.status !== "connected" || !googleDriveMcpScopesSatisfied(row.scopes ?? [])) {
    return { ok: false, reason: "needs_reauth" } as const;
  }

  const connection = {
    userWorkosId: row.userWorkosId,
    integrationId: row.id,
    provider: "google_drive" as const,
  };
  try {
    // Validate or refresh the Google credential before the handshake. The
    // provider token is never used as the MCP bearer credential.
    await getGoogleAccessToken(connection);
  } catch (error) {
    if (error instanceof GoogleAccessAuthError) {
      return { ok: false, reason: "needs_reauth" } as const;
    }
    throw error;
  }

  const internalSecret = process.env.API_INTERNAL_TOKEN?.trim();
  if (!internalSecret) {
    throw new Error("Google Drive MCP is not configured: API_INTERNAL_TOKEN is missing.");
  }
  const { ticket } = createGoogleDriveMcpTicket({
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
      onAuthorizationRequired: async () => input.onAuthorizationRequired(),
    }),
  } as const;
}
