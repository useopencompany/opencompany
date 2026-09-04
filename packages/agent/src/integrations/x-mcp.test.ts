import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAccessToken: vi.fn(),
  rows: vi.fn(),
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({ limit: mocks.rows }),
        }),
      }),
    }),
  }),
}));
vi.mock("./x-access-token", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getXAccessToken: mocks.getAccessToken,
}));

import { XAccessAuthError } from "./x-access-token";
import { getXMcpIntegrationState, loadXMcpWorkerConnection, X_MCP_ENDPOINT_URL } from "./x-mcp";

const connectedRow = {
  id: "gint_x",
  status: "connected",
  capabilityModes: { read: "on", query: "ask", write: "ask" },
  toolModes: {},
};

describe("X MCP connection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rows.mockResolvedValue([connectedRow]);
    mocks.getAccessToken.mockResolvedValue("x-fresh-access");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exposes the latest connected X account with its permission modes", async () => {
    await expect(getXMcpIntegrationState("user_1")).resolves.toEqual({
      connected: true,
      integrationId: "gint_x",
      capabilityModes: connectedRow.capabilityModes,
      toolModes: {},
    });
  });

  it("loads a refreshed OAuth token for X's fixed hosted MCP endpoint", async () => {
    const connection = await loadXMcpWorkerConnection({
      userWorkosId: "user_1",
      onAuthorizationRequired: () => {
        throw new Error("authorization required");
      },
    });

    expect(X_MCP_ENDPOINT_URL).toBe("https://api.x.com/mcp");
    expect(mocks.getAccessToken).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      integrationId: "gint_x",
    });
    expect(connection).toMatchObject({ ok: true, integrationId: "gint_x" });
    if (!connection.ok) throw new Error("Expected a connected X account.");
    expect(await connection.authProvider.tokens()).toEqual({
      access_token: "x-fresh-access",
      token_type: "Bearer",
    });
  });

  it("returns needs_reauth when the saved refresh credential is invalid", async () => {
    mocks.getAccessToken.mockRejectedValueOnce(new XAccessAuthError("expired"));

    await expect(
      loadXMcpWorkerConnection({
        userWorkosId: "user_1",
        onAuthorizationRequired: () => {
          throw new Error("authorization required");
        },
      }),
    ).resolves.toEqual({ ok: false, reason: "needs_reauth" });
  });

  it("forces one provider refresh before asking the user to reconnect", async () => {
    const authorizationError = new Error("authorization required");
    mocks.getAccessToken
      .mockResolvedValueOnce("x-fresh-access")
      .mockRejectedValueOnce(new XAccessAuthError("expired"));
    const connection = await loadXMcpWorkerConnection({
      userWorkosId: "user_1",
      onAuthorizationRequired: () => {
        throw authorizationError;
      },
    });
    if (!connection.ok) throw new Error("Expected a connected X account.");

    await expect(
      connection.authProvider.validateResourceURL?.(X_MCP_ENDPOINT_URL, X_MCP_ENDPOINT_URL),
    ).rejects.toBe(authorizationError);
    expect(mocks.getAccessToken).toHaveBeenLastCalledWith(
      { userWorkosId: "user_1", integrationId: "gint_x" },
      { forceRefresh: true },
    );
  });
});
