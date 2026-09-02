import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadIntegration: vi.fn(),
  loadCredential: vi.fn(),
  markStatus: vi.fn(),
}));

vi.mock("./slack", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadSlackIntegration: mocks.loadIntegration,
}));
vi.mock("@opencompany/db/integrations", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadIntegrationCredential: mocks.loadCredential,
  markIntegrationStatus: mocks.markStatus,
}));

import {
  getSlackMcpIntegrationState,
  loadSlackMcpWorkerConnection,
  SLACK_MCP_ENDPOINT_URL,
} from "./slack-mcp";

const connectedRow = {
  id: "gint_slack",
  userWorkosId: "user_1",
  status: "connected",
  accountName: "Ada",
  connectionLabel: "Acme",
  statusReason: null,
  capabilityModes: { query: "ask" },
  toolModes: { slack_send_message: "off" },
};

describe("Slack MCP connection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadIntegration.mockResolvedValue(connectedRow);
    mocks.loadCredential.mockResolvedValue({ payload: { access_token: "xoxp-slack-user" } });
  });

  it("exposes the exact Slack endpoint and connection permission state", async () => {
    expect(SLACK_MCP_ENDPOINT_URL).toBe("https://mcp.slack.com/mcp");
    await expect(getSlackMcpIntegrationState({ userWorkosId: "user_1" })).resolves.toEqual({
      connected: true,
      integrationId: "gint_slack",
      capabilityModes: { query: "ask" },
      toolModes: { slack_send_message: "off" },
    });
  });

  it("loads the encrypted user token into the static bearer provider", async () => {
    const connection = await loadSlackMcpWorkerConnection({
      userWorkosId: "user_1",
      onAuthorizationRequired: () => {
        throw new Error("authorization required");
      },
    });
    expect(connection).toMatchObject({ ok: true, integrationId: "gint_slack" });
    if (!connection.ok) throw new Error("Expected a connected Slack account.");
    expect(await connection.authProvider.tokens()).toEqual({
      access_token: "xoxp-slack-user",
      token_type: "Bearer",
    });
  });

  it("fails closed when no usable connection or credential exists", async () => {
    mocks.loadIntegration.mockResolvedValueOnce(null);
    await expect(
      loadSlackMcpWorkerConnection({
        userWorkosId: "user_1",
        onAuthorizationRequired: () => {
          throw new Error("authorization required");
        },
      }),
    ).resolves.toEqual({ ok: false, reason: "not_connected" });

    mocks.loadIntegration.mockResolvedValueOnce(connectedRow);
    mocks.loadCredential.mockResolvedValueOnce({ payload: {} });
    await expect(
      loadSlackMcpWorkerConnection({
        userWorkosId: "user_1",
        onAuthorizationRequired: () => {
          throw new Error("authorization required");
        },
      }),
    ).resolves.toEqual({ ok: false, reason: "needs_reauth" });
  });

  it("marks the account for reconnect when Slack rejects its bearer token", async () => {
    const authorizationError = new Error("authorization required");
    const connection = await loadSlackMcpWorkerConnection({
      userWorkosId: "user_1",
      onAuthorizationRequired: () => {
        throw authorizationError;
      },
    });
    if (!connection.ok) throw new Error("Expected a connected Slack account.");

    await expect(
      connection.authProvider.validateResourceURL?.(SLACK_MCP_ENDPOINT_URL, SLACK_MCP_ENDPOINT_URL),
    ).rejects.toBe(authorizationError);
    expect(mocks.markStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        integrationId: "gint_slack",
        provider: "slack",
        status: "needs_reauth",
      }),
    );
  });
});
