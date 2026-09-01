import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAccessToken: vi.fn(),
  loadIntegration: vi.fn(),
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

  it("surfaces a plain error when a forced refresh proves the GitHub credential is valid", async () => {
    const connection = await loadGitHubUserMcpWorkerConnection({
      userWorkosId: "user_1",
      onAuthorizationRequired: () => {
        throw new Error("authorization required");
      },
    });
    if (!connection.ok) throw new Error("Expected a connected GitHub user.");

    await expect(
      connection.authProvider.validateResourceURL?.(
        GITHUB_USER_MCP_ENDPOINT_URL,
        GITHUB_USER_MCP_ENDPOINT_URL,
      ),
    ).rejects.toThrow("GitHub MCP rejected a freshly refreshed credential.");
    expect(mocks.getAccessToken).toHaveBeenLastCalledWith(
      {
        userWorkosId: "user_1",
        integrationId: "gint_github_user",
      },
      { forceRefresh: true },
    );
  });

  it("requests reauthorization only when the forced GitHub refresh also fails", async () => {
    const authorizationError = new Error("authorization required");
    mocks.getAccessToken
      .mockResolvedValueOnce("ghu_fresh_access")
      .mockRejectedValueOnce(new GitHubUserAccessAuthError("expired"));
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
  });
});
