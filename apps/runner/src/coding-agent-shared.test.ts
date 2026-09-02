import { beforeEach, describe, expect, it, vi } from "vitest";

const githubUserMocks = vi.hoisted(() => ({
  getAccessToken: vi.fn(),
  loadIntegration: vi.fn(),
}));
const githubWorkMocks = vi.hoisted(() => ({ getInstallationToken: vi.fn() }));
const dbMocks = vi.hoisted(() => ({
  legacyRows: [] as Array<{ installationId: string | null }>,
  db: {} as Record<string, unknown>,
}));

const queryBuilder = {
  select: vi.fn(() => queryBuilder),
  from: vi.fn(() => queryBuilder),
  where: vi.fn(() => queryBuilder),
  orderBy: vi.fn(() => queryBuilder),
  limit: vi.fn(async () => dbMocks.legacyRows),
};
Object.assign(dbMocks.db, queryBuilder);

vi.mock("@opencompany/agent/integrations/github-user", () => ({
  getGitHubUserAccessToken: githubUserMocks.getAccessToken,
  loadGitHubUserIntegration: githubUserMocks.loadIntegration,
}));

vi.mock("./db", () => ({ getDb: () => dbMocks.db }));

vi.mock("./github", () => ({
  getGitHubWorkInstallationToken: githubWorkMocks.getInstallationToken,
}));

import {
  buildGitHubCommandEnv,
  loadGitHubAuthForUser,
  loadGitHubUserAuthForUser,
} from "./coding-agent-shared";

describe("GitHub sandbox auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.legacyRows = [];
    githubUserMocks.loadIntegration.mockResolvedValue(null);
    githubWorkMocks.getInstallationToken.mockResolvedValue(null);
  });

  it("refreshes and returns the connected personal GitHub credential", async () => {
    githubUserMocks.loadIntegration.mockResolvedValue({
      id: "integration_personal",
      status: "connected",
    });
    githubUserMocks.getAccessToken.mockResolvedValue("ghu_personal");

    const auth = await loadGitHubAuthForUser("user_1");

    expect(githubUserMocks.getAccessToken).toHaveBeenCalledWith(
      { userWorkosId: "user_1", integrationId: "integration_personal" },
      { db: dbMocks.db },
    );
    expect(auth).toMatchObject({ githubToken: "ghu_personal", provider: "github_user" });
    expect(decodeGitAuthHeader(auth?.githubAuthHeader)).toBe("x-access-token:ghu_personal");
    expect(githubWorkMocks.getInstallationToken).not.toHaveBeenCalled();
  });

  it("keeps the legacy workspace installation as a fallback", async () => {
    dbMocks.legacyRows = [{ installationId: "installation_legacy" }];
    githubWorkMocks.getInstallationToken.mockResolvedValue("ghs_workspace");

    const auth = await loadGitHubAuthForUser("user_1");

    expect(githubWorkMocks.getInstallationToken).toHaveBeenCalledWith({
      installationId: "installation_legacy",
    });
    expect(auth).toMatchObject({ githubToken: "ghs_workspace", provider: "github" });
    expect(decodeGitAuthHeader(auth?.githubAuthHeader)).toBe("x-access-token:ghs_workspace");
  });

  it("does not silently switch identities when personal refresh fails", async () => {
    githubUserMocks.loadIntegration.mockResolvedValue({
      id: "integration_personal",
      status: "connected",
    });
    githubUserMocks.getAccessToken.mockRejectedValue(new Error("Reconnect GitHub in Settings."));
    dbMocks.legacyRows = [{ installationId: "installation_legacy" }];

    await expect(loadGitHubAuthForUser("user_1")).rejects.toThrow("Reconnect GitHub in Settings.");
    expect(githubWorkMocks.getInstallationToken).not.toHaveBeenCalled();
  });

  it("ignores a personal integration that is no longer connected", async () => {
    githubUserMocks.loadIntegration.mockResolvedValue({
      id: "integration_personal",
      status: "needs_reauth",
    });

    await expect(loadGitHubUserAuthForUser("user_1")).resolves.toBeNull();
    expect(githubUserMocks.getAccessToken).not.toHaveBeenCalled();
  });

  it("injects the personal token into gh and git through the existing environment contract", () => {
    const env = buildGitHubCommandEnv({
      githubAuthHeader: "Authorization: Basic encoded-personal-token",
      githubToken: "ghu_personal",
      repositoryFullName: "opencompany/app",
      toolCallId: "turn/unsafe",
    });

    expect(env).toMatchObject({
      GH_TOKEN: "ghu_personal",
      GH_REPO: "opencompany/app",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: "Authorization: Basic encoded-personal-token",
    });
  });
});

function decodeGitAuthHeader(value: string | undefined) {
  if (!value) return null;
  return Buffer.from(value.replace("Authorization: Basic ", ""), "base64").toString("utf8");
}
