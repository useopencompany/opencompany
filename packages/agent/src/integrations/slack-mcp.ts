import { loadIntegrationCredential, markIntegrationStatus } from "@opencompany/db/integrations";
import type { RemoteMcpConnectionState } from "../actions/remote-mcp";
import { createRemoteMcpStaticBearerAuthProvider } from "./remote-mcp-static-bearer";
import { loadSlackIntegration } from "./slack";

export const SLACK_MCP_ENDPOINT_URL = "https://mcp.slack.com/mcp";

export async function getSlackMcpIntegrationState(
  identity: string | { userWorkosId: string },
): Promise<RemoteMcpConnectionState> {
  const userWorkosId = typeof identity === "string" ? identity : identity.userWorkosId;
  const row = await loadSlackIntegration({ userWorkosId });
  if (!row || row.status === "disconnected") {
    return {
      connected: false,
      integrationId: null,
      capabilityModes: {},
      toolModes: {},
    };
  }
  return {
    connected: row.status === "connected",
    integrationId: row.id,
    capabilityModes: row.capabilityModes,
    toolModes: row.toolModes,
  };
}

export async function loadSlackMcpWorkerConnection(input: {
  userWorkosId: string;
  onAuthorizationRequired: () => never;
}) {
  const row = await loadSlackIntegration({ userWorkosId: input.userWorkosId });
  if (!row || row.status === "disconnected") return { ok: false, reason: "not_connected" } as const;
  if (row.status !== "connected") return { ok: false, reason: "needs_reauth" } as const;

  const credential = await loadIntegrationCredential({
    userWorkosId: row.userWorkosId,
    integrationId: row.id,
    provider: "slack",
    kind: "oauth_token",
  });
  const accessToken = credential?.payload.access_token;
  if (typeof accessToken !== "string" || !accessToken.trim()) {
    return { ok: false, reason: "needs_reauth" } as const;
  }

  return {
    ok: true,
    integrationId: row.id,
    authProvider: createRemoteMcpStaticBearerAuthProvider({
      accessToken: accessToken.trim(),
      onAuthorizationRequired: async () => {
        await markIntegrationStatus({
          userWorkosId: row.userWorkosId,
          integrationId: row.id,
          provider: "slack",
          status: "needs_reauth",
          statusReason: "Slack rejected the connected account credential.",
        });
        return input.onAuthorizationRequired();
      },
    }),
  } as const;
}
