import { beforeEach, describe, expect, it, vi } from "vitest";

const githubUserMocks = vi.hoisted(() => ({
  getAccessToken: vi.fn(),
  loadIdentity: vi.fn(),
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
  GitHubUserAccessAuthError: class GitHubUserAccessAuthError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "GitHubUserAccessAuthError";
    }
  },
  getGitHubUserAccessToken: githubUserMocks.getAccessToken,
  loadGitHubUserCredentialIdentity: githubUserMocks.loadIdentity,
  loadGitHubUserIntegration: githubUserMocks.loadIntegration,
}));

vi.mock("./db", () => ({ getDb: () => dbMocks.db }));

vi.mock("./github", () => ({
  getGitHubWorkInstallationToken: githubWorkMocks.getInstallationToken,
}));

import {
  buildGitHubCommandEnv,
  GITHUB_RECONNECT_NOTICE,
  loadGitHubAuthForUser,
  loadGitHubUserAuthForUser,
  shouldAppendGitHubAuthNotice,
} from "./coding-agent-shared";

describe("GitHub sandbox auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.legacyRows = [];
    githubUserMocks.loadIntegration.mockResolvedValue(null);
    githubUserMocks.loadIdentity.mockResolvedValue(null);
    githubWorkMocks.getInstallationToken.mockResolvedValue(null);
  });

  it("refreshes and returns the connected personal GitHub credential", async () => {
    githubUserMocks.loadIntegration.mockResolvedValue({
      id: "integration_personal",
      status: "connected",
      connectionLabel: "@octocat",
      accountName: "The Octocat",
      accountEmail: "octocat@github.com",
    });
    githubUserMocks.getAccessToken.mockResolvedValue("ghu_personal");

    const auth = await loadGitHubAuthForUser("user_1");

    expect(githubUserMocks.getAccessToken).toHaveBeenCalledWith(
      { userWorkosId: "user_1", integrationId: "integration_personal" },
      { db: dbMocks.db },
    );
    expect(auth).toMatchObject({
      githubToken: "ghu_personal",
      provider: "github_user",
      gitAuthorName: "The Octocat",
      gitAuthorEmail: "octocat@github.com",
    });
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

  it("does not fall back to the workspace App when personal GitHub needs reauthorization", async () => {
    githubUserMocks.loadIntegration.mockResolvedValue({
      id: "integration_personal",
      status: "needs_reauth",
    });
    dbMocks.legacyRows = [{ installationId: "installation_legacy" }];

    await expect(loadGitHubAuthForUser("user_1")).rejects.toMatchObject({
      name: "GitHubUserAccessAuthError",
    });
    expect(githubWorkMocks.getInstallationToken).not.toHaveBeenCalled();
  });

  it("degrades sync failures to no auth without falling back or requiring reconnect", async () => {
    githubUserMocks.loadIntegration.mockResolvedValue({
      id: "integration_personal",
      status: "sync_failed",
    });
    dbMocks.legacyRows = [{ installationId: "installation_legacy" }];

    await expect(loadGitHubAuthForUser("user_1")).resolves.toBeNull();
    expect(githubUserMocks.getAccessToken).not.toHaveBeenCalled();
    expect(githubWorkMocks.getInstallationToken).not.toHaveBeenCalled();
  });

  it("injects the personal token into gh and git through the existing environment contract", () => {
    const env = buildGitHubCommandEnv({
      githubAuthHeader: "Authorization: Basic encoded-personal-token",
      githubToken: "ghu_personal",
      repositoryFullName: "opencompany/app",
      toolCallId: "turn/unsafe",
      gitAuthorName: "The Octocat",
      gitAuthorEmail: "octocat@github.com",
    });

    expect(env).toMatchObject({
      GH_TOKEN: "ghu_personal",
      GH_REPO: "opencompany/app",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: "Authorization: Basic encoded-personal-token",
      GIT_AUTHOR_NAME: "The Octocat",
      GIT_AUTHOR_EMAIL: "octocat@github.com",
      GIT_COMMITTER_NAME: "The Octocat",
      GIT_COMMITTER_EMAIL: "octocat@github.com",
    });
  });

  it("does not override git identity when an existing connection has no verified email", async () => {
    githubUserMocks.loadIntegration.mockResolvedValue({
      id: "integration_personal",
      status: "connected",
      connectionLabel: "@octocat",
      accountName: "The\nOctocat",
      accountEmail: null,
    });
    githubUserMocks.getAccessToken.mockResolvedValue("ghu_personal");

    const auth = await loadGitHubAuthForUser("user_1");

    expect(auth).not.toHaveProperty("gitAuthorName");
    expect(auth).not.toHaveProperty("gitAuthorEmail");
  });

  it("derives the canonical no-reply identity for an existing private-email connection", async () => {
    githubUserMocks.loadIntegration.mockResolvedValue({
      id: "integration_personal",
      status: "connected",
      connectionLabel: "@octocat",
      accountName: "The Octocat",
      accountEmail: null,
    });
    githubUserMocks.getAccessToken.mockResolvedValue("ghu_personal");
    githubUserMocks.loadIdentity.mockResolvedValue({
      githubUserId: "42",
      githubLogin: "octocat",
    });

    await expect(loadGitHubAuthForUser("user_1")).resolves.toMatchObject({
      gitAuthorName: "The Octocat",
      gitAuthorEmail: "42+octocat@users.noreply.github.com",
    });
  });

  it("sanitizes forbidden git identity characters with a canonical no-reply email", async () => {
    githubUserMocks.loadIntegration.mockResolvedValue({
      id: "integration_personal",
      status: "connected",
      connectionLabel: "@octocat",
      accountName: "The <Octocat>",
      accountEmail: "42+octocat@users.noreply.github.com",
    });
    githubUserMocks.getAccessToken.mockResolvedValue("ghu_personal");

    await expect(loadGitHubAuthForUser("user_1")).resolves.toMatchObject({
      gitAuthorName: "The Octocat",
      gitAuthorEmail: "42+octocat@users.noreply.github.com",
    });
  });
});

describe("GitHub auth notices", () => {
  it("suppresses a repeated reconnect notice from recent durable history", () => {
    const history = {
      messages: [{ role: "assistant" as const, content: GITHUB_RECONNECT_NOTICE, attachments: [] }],
      materializableAttachments: [],
      omittedTurnCount: 0,
      omittedAttachmentCount: 0,
    };

    expect(shouldAppendGitHubAuthNotice(history, GITHUB_RECONNECT_NOTICE)).toBe(false);
  });

  it("keeps transient unavailability notices turn-specific", () => {
    const history = {
      messages: [],
      materializableAttachments: [],
      omittedTurnCount: 0,
      omittedAttachmentCount: 0,
    };

    expect(
      shouldAppendGitHubAuthNotice(
        history,
        "GitHub access is temporarily unavailable. This turn continued without GitHub access.",
      ),
    ).toBe(true);
  });
});

function decodeGitAuthHeader(value: string | undefined) {
  if (!value) return null;
  return Buffer.from(value.replace("Authorization: Basic ", ""), "base64").toString("utf8");
}
