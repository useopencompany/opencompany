import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAccessToken: vi.fn(),
  loadIntegration: vi.fn(),
  markStatus: vi.fn(async () => undefined),
}));

vi.mock("@opencompany/db/integrations", () => ({
  markIntegrationStatus: mocks.markStatus,
}));
vi.mock("./github-user", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGitHubUserAccessToken: mocks.getAccessToken,
  loadGitHubUserIntegration: mocks.loadIntegration,
}));

import { GitHubUserAccessAuthError } from "./github-user";
import { GITHUB_USER_MCP_ENDPOINT_URL, loadGitHubUserMcpWorkerConnection } from "./github-user-mcp";

const connectedRow = {
  id: "gint_github_user",
  userWorkosId: "user_1",
  status: "connected",
  accountName: "The Octocat",
  statusReason: null,
  capabilityModes: {},
  toolModes: {},
};

describe("GitHub user MCP connection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadIntegration.mockResolvedValue(connectedRow);
    mocks.getAccessToken.mockResolvedValue("ghu_fresh_access");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads a refreshed user token into the reusable static bearer provider", async () => {
    const connection = await loadGitHubUserMcpWorkerConnection({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
      onAuthorizationRequired: () => {
        throw new Error("authorization required");
      },
    });

    expect(GITHUB_USER_MCP_ENDPOINT_URL).toBe("https://api.githubcopilot.com/mcp/");
    expect(mocks.getAccessToken).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      integrationId: "gint_github_user",
    });
    expect(connection).toMatchObject({ ok: true, integrationId: "gint_github_user" });
    if (!connection.ok) throw new Error("Expected a connected GitHub user.");
    expect(await connection.authProvider.tokens()).toEqual({
      access_token: "ghu_fresh_access",
      token_type: "Bearer",
    });
  });

  it("returns connection states without attempting MCP OAuth", async () => {
    mocks.loadIntegration.mockResolvedValueOnce(null);
    await expect(
      loadGitHubUserMcpWorkerConnection({
        userWorkosId: "user_1",
        onAuthorizationRequired: () => {
          throw new Error("authorization required");
        },
      }),
    ).resolves.toEqual({ ok: false, reason: "not_connected" });

    mocks.loadIntegration.mockResolvedValueOnce(connectedRow);
    mocks.getAccessToken.mockRejectedValueOnce(new GitHubUserAccessAuthError("expired"));
    await expect(
      loadGitHubUserMcpWorkerConnection({
        userWorkosId: "user_1",
        onAuthorizationRequired: () => {
          throw new Error("authorization required");
        },
      }),
    ).resolves.toEqual({ ok: false, reason: "needs_reauth" });
  });

  it("marks the connection for reauthorization when the MCP vendor rejects the bearer", async () => {
    const authorizationError = new Error("authorization required");
    const connection = await loadGitHubUserMcpWorkerConnection({
      userWorkosId: "user_1",
      onAuthorizationRequired: () => {
        throw authorizationError;
      },
    });
    if (!connection.ok) throw new Error("Expected a connected GitHub user.");

    await expect(
      connection.authProvider.validateResourceURL?.(
        GITHUB_USER_MCP_ENDPOINT_URL,
        GITHUB_USER_MCP_ENDPOINT_URL,
      ),
    ).rejects.toBe(authorizationError);
    expect(mocks.markStatus).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      integrationId: "gint_github_user",
      provider: "github_user",
      status: "needs_reauth",
      statusReason: "GitHub authorization expired. Reconnect GitHub in Settings.",
    });
  });
});
