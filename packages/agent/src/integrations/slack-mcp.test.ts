import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadIntegration: vi.fn(),
}));

vi.mock("./slack", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadSlackIntegration: mocks.loadIntegration,
}));

import {
  getSlackMcpIntegrationState,
  loadSlackMcpWorkerConnection,
  SLACK_MCP_ENDPOINT_URL,
  SLACK_MCP_RUNTIME_ENDPOINT_URL,
  slackMcpRuntimeEndpointUrl,
} from "./slack-mcp";
import { verifySlackMcpTicket } from "./slack-mcp-ticket";
import { SLACK_MCP_USER_SCOPES } from "./slack-scopes";

const SECRET = "shared-test-secret";
const connectedRow = {
  id: "gint_slack",
  userWorkosId: "user_1",
  status: "connected",
  accountName: "Ada",
  connectionLabel: "Acme",
  statusReason: null,
  capabilityModes: { query: "ask" },
  toolModes: { slack_send_message: "off" },
  scopes: [...SLACK_MCP_USER_SCOPES],
};

function workerInput() {
  return {
    userWorkosId: "user_1",
    workspaceId: "workspace_1",
    registrationId: "registration_1",
    operation: {
      type: "tools/call" as const,
      tool: "slack_read_channel",
      capability: "query" as const,
    },
    onAuthorizationRequired: () => {
      throw new Error("authorization required");
    },
  };
}

describe("Slack MCP connection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.API_INTERNAL_TOKEN = SECRET;
    mocks.loadIntegration.mockResolvedValue(connectedRow);
  });

  it("keeps the hosted endpoint as the package trust anchor and uses our API at runtime", async () => {
    expect(SLACK_MCP_ENDPOINT_URL).toBe("https://mcp.slack.com/mcp");
    expect(SLACK_MCP_RUNTIME_ENDPOINT_URL).toBe("https://api.opencompany.chat/mcp/plugins/slack");
    expect(slackMcpRuntimeEndpointUrl()).toBe(SLACK_MCP_RUNTIME_ENDPOINT_URL);
    await expect(getSlackMcpIntegrationState({ userWorkosId: "user_1" })).resolves.toEqual({
      connected: true,
      integrationId: "gint_slack",
      capabilityModes: { query: "ask" },
      toolModes: { slack_send_message: "off" },
    });
  });

  it("uses a short-lived operation ticket", async () => {
    const connection = await loadSlackMcpWorkerConnection(workerInput());
    expect(connection).toMatchObject({ ok: true, integrationId: "gint_slack" });
    if (!connection.ok) throw new Error("Expected a connected Slack account.");
    const tokens = await connection.authProvider.tokens();
    if (!tokens) throw new Error("Expected a Slack MCP ticket.");
    expect(verifySlackMcpTicket({ ticket: tokens.access_token, secret: SECRET })).toMatchObject({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
      integrationId: "gint_slack",
      registrationId: "registration_1",
      operation: {
        type: "tools/call",
        tool: "slack_read_channel",
        capability: "query",
      },
    });
  });

  it("fails closed when no usable connection exists", async () => {
    mocks.loadIntegration.mockResolvedValueOnce(null);
    await expect(loadSlackMcpWorkerConnection(workerInput())).resolves.toEqual({
      ok: false,
      reason: "not_connected",
    });
  });

  it("requires legacy ingestion connections to reconnect for the plugin grant", async () => {
    const legacyRow = {
      ...connectedRow,
      scopes: ["channels:history", "channels:read", "search:read"],
    };
    mocks.loadIntegration.mockResolvedValueOnce(legacyRow);
    await expect(getSlackMcpIntegrationState({ userWorkosId: "user_1" })).resolves.toMatchObject({
      connected: false,
      integrationId: "gint_slack",
    });

    mocks.loadIntegration.mockResolvedValueOnce(legacyRow);
    await expect(loadSlackMcpWorkerConnection(workerInput())).resolves.toEqual({
      ok: false,
      reason: "needs_reauth",
    });
  });
});
