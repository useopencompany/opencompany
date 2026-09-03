import type { RemoteMcpConnectionState } from "../actions/remote-mcp";
import { GoogleAccessAuthError, getGoogleAccessToken } from "./google-access-token";
import { googleCalendarMcpScopesSatisfied } from "./google-calendar-scopes";
import { loadGoogleCalendarIntegration } from "./google-data";
import { createRemoteMcpStaticBearerAuthProvider } from "./remote-mcp-static-bearer";

export const GOOGLE_CALENDAR_MCP_ENDPOINT_URL = "https://calendarmcp.googleapis.com/mcp/v1";

export async function getGoogleCalendarMcpIntegrationState(
  identity: string | { userWorkosId: string },
): Promise<RemoteMcpConnectionState> {
  const userWorkosId = typeof identity === "string" ? identity : identity.userWorkosId;
  const row = await loadGoogleCalendarIntegration({ userWorkosId });
  if (!row || row.status === "disconnected") {
    return {
      connected: false,
      integrationId: null,
      capabilityModes: {},
      toolModes: {},
    };
  }
  return {
    connected: row.status === "connected" && googleCalendarMcpScopesSatisfied(row.scopes ?? []),
    integrationId: row.id,
    capabilityModes: row.capabilityModes,
    toolModes: row.toolModes,
  };
}

export async function loadGoogleCalendarMcpWorkerConnection(input: {
  userWorkosId: string;
  onAuthorizationRequired: () => never;
}) {
  const row = await loadGoogleCalendarIntegration({ userWorkosId: input.userWorkosId });
  if (!row || row.status === "disconnected") {
    return { ok: false, reason: "not_connected" } as const;
  }
  if (row.status !== "connected" || !googleCalendarMcpScopesSatisfied(row.scopes ?? [])) {
    return { ok: false, reason: "needs_reauth" } as const;
  }

  const connection = {
    userWorkosId: row.userWorkosId,
    integrationId: row.id,
    provider: "google_calendar" as const,
  };
  let accessToken: string;
  try {
    accessToken = await getGoogleAccessToken(connection);
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
          await getGoogleAccessToken(connection, { forceRefresh: true });
        } catch (error) {
          if (error instanceof GoogleAccessAuthError) return input.onAuthorizationRequired();
          throw error;
        }
        throw new Error("Google Calendar MCP rejected a freshly refreshed credential.");
      },
    }),
  } as const;
}
