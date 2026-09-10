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
  scopes: ["tweet.read", "tweet.write", "users.read"],
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

  it("preserves a per-tool denial saved under X's previous spelling", async () => {
    mocks.rows.mockResolvedValue([{ ...connectedRow, toolModes: { getPostsByIds: "off" } }]);
    await expect(getXMcpIntegrationState("user_1")).resolves.toMatchObject({
      toolModes: { get_posts_by_ids: "off" },
    });
    mocks.rows.mockResolvedValue([
      { ...connectedRow, toolModes: { getPostsByIds: "off", get_posts_by_ids: "on" } },
    ]);
    await expect(getXMcpIntegrationState("user_1")).resolves.toMatchObject({
      toolModes: { get_posts_by_ids: "on" },
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

  it.each([
    ["upload_image", "media.write"],
    ["set_media_alt_text", "media.write"],
    ["get_users_bookmarks", "bookmark.read"],
    ["create_users_bookmark", "bookmark.write"],
  ])("requires reconnect for %s without disabling existing read access", async (tool, scope) => {
    await expect(
      loadXMcpWorkerConnection({
        userWorkosId: "user_1",
        operation: { type: "tools/call", tool, capability: "write" },
        onAuthorizationRequired: () => {
          throw new Error("authorization required");
        },
      }),
    ).rejects.toThrow(`grant ${scope}`);
    expect(mocks.getAccessToken).not.toHaveBeenCalled();
    await expect(getXMcpIntegrationState("user_1")).resolves.toMatchObject({ connected: true });
  });

  it("allows existing connections to publish and reconnected accounts to upload", async () => {
    for (const tool of ["create_posts", "get_posts_analytics", "search_posts_recent"]) {
      await expect(
        loadXMcpWorkerConnection({
          userWorkosId: "user_1",
          operation: { type: "tools/call", tool, capability: "write" },
          onAuthorizationRequired: () => {
            throw new Error("authorization required");
          },
        }),
      ).resolves.toMatchObject({ ok: true, createClient: expect.any(Function) });
    }
    mocks.rows.mockResolvedValue([
      { ...connectedRow, scopes: [...connectedRow.scopes, "media.write"] },
    ]);
    await expect(
      loadXMcpWorkerConnection({
        userWorkosId: "user_1",
        operation: { type: "tools/call", tool: "upload_image", capability: "write" },
        onAuthorizationRequired: () => {
          throw new Error("authorization required");
        },
      }),
    ).resolves.toMatchObject({ ok: true });
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
