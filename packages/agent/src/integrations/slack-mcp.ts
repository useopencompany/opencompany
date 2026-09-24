import type { RemoteMcpConnectionState } from "../actions/remote-mcp";
import { createRemoteMcpStaticBearerAuthProvider } from "./remote-mcp-static-bearer";
import { loadSlackIntegration } from "./slack";
import { createSlackMcpTicket, type SlackMcpOperation } from "./slack-mcp-ticket";
import { slackMcpScopesSatisfied } from "./slack-scopes";

export const SLACK_MCP_ENDPOINT_URL = "https://mcp.slack.com/mcp";
export const SLACK_MCP_RUNTIME_ENDPOINT_URL = "https://api.opencompany.chat/mcp/plugins/slack";

export function slackMcpRuntimeEndpointUrl() {
  const configuredOrigin = process.env.OPENCOMPANY_API_ORIGIN?.trim();
  if (!configuredOrigin) return SLACK_MCP_RUNTIME_ENDPOINT_URL;
  try {
    const origin = new URL(configuredOrigin);
    if (origin.protocol !== "https:" && origin.hostname !== "localhost") {
      return SLACK_MCP_RUNTIME_ENDPOINT_URL;
    }
    return new URL("/mcp/plugins/slack", origin).toString();
  } catch {
    return SLACK_MCP_RUNTIME_ENDPOINT_URL;
  }
}

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
    connected: row.status === "connected" && slackMcpScopesSatisfied(row.scopes ?? []),
    integrationId: row.id,
    capabilityModes: row.capabilityModes,
    toolModes: row.toolModes,
  };
}

export async function loadSlackMcpWorkerConnection(input: {
  userWorkosId: string;
  workspaceId: string;
  registrationId: string;
  operation: SlackMcpOperation;
  onAuthorizationRequired: () => never;
}) {
  const row = await loadSlackIntegration({ userWorkosId: input.userWorkosId });
  if (!row || row.status === "disconnected") return { ok: false, reason: "not_connected" } as const;
  if (row.status !== "connected" || !slackMcpScopesSatisfied(row.scopes ?? [])) {
    return { ok: false, reason: "needs_reauth" } as const;
  }

  const internalSecret = process.env.API_INTERNAL_TOKEN?.trim();
  if (!internalSecret) {
    throw new Error("Slack MCP is not configured: API_INTERNAL_TOKEN is missing.");
  }
  const { ticket } = createSlackMcpTicket({
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
