import {
  createGitHubUserIntegrationState,
  exchangeGitHubUserCode,
  fetchGitHubUserIdentity,
} from "@opencompany/agent/integrations/github-user";
import { connectGitHubUserIntegration } from "@opencompany/db/integrations";
import { listWorkspacesForUser } from "@opencompany/db/workspaces";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./errors";
import { createGitHubUserIngress } from "./github-user-ingress";

vi.mock("@opencompany/agent/integrations/github-user", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  exchangeGitHubUserCode: vi.fn(),
  fetchGitHubUserIdentity: vi.fn(),
}));
vi.mock("@opencompany/agent/integrations/analytics", () => ({
  captureIntegrationAddedAnalytics: vi.fn(async () => undefined),
}));
vi.mock("@opencompany/db/integrations", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  connectGitHubUserIntegration: vi.fn(async () => ({ integrationId: "gint_github_user" })),
}));
vi.mock("@opencompany/db/workspaces", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listWorkspacesForUser: vi.fn(),
}));

const db = { sentinel: "db" };

function ingress(
  input: {
    authError?: ApiError;
    refresh?: (input: { userWorkosId: string; workspaceIds: string[] }) => Promise<void>;
  } = {},
) {
  vi.mocked(listWorkspacesForUser).mockResolvedValue([
    {
      workspace: { id: "workspace_1", workosOrganizationId: null },
      role: "member",
    },
  ] as never);
  return createGitHubUserIngress({
    db,
    identify: async () => {
      if (input.authError) throw input.authError;
      return {
        userId: "user_1",
        organizationId: null,
        method: "session",
        credentialKind: "browser_cookie",
        activeWorkspaceId: null,
        activeBrainId: null,
      };
    },
    ...(input.refresh ? { refreshPluginRegistrations: input.refresh } : {}),
  });
}

describe("GitHub user ingress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OPENCOMPANY_NEXT_PUBLIC_APP_URL", "https://opencompany.example.com");
    vi.stubEnv("GITHUB_USER_APP_SLUG", "opencompany-user");
    vi.stubEnv("GITHUB_USER_APP_CLIENT_ID", "Iv1_user_client");
    vi.stubEnv("GITHUB_USER_APP_CLIENT_SECRET", "client-secret");
    vi.stubEnv("GITHUB_USER_APP_STATE_SECRET", "state-secret-state-secret-state-secret");
    vi.stubEnv("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 9).toString("base64"));
    vi.mocked(exchangeGitHubUserCode).mockResolvedValue({
      accessToken: "ghu_access",
      refreshToken: "ghr_refresh",
      tokenType: "bearer",
      accessTokenExpiresAt: new Date("2026-09-01T20:00:00.000Z"),
      refreshTokenExpiresAt: new Date("2027-03-04T12:00:00.000Z"),
    });
    vi.mocked(fetchGitHubUserIdentity).mockResolvedValue({
      id: "42",
      login: "octocat",
      name: "The Octocat",
      email: null,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("lets a workspace member start the personal App install and authorization flow", async () => {
    const response = await ingress().start(
      new Request(
        "https://api.example.com/integrations/github-user/start?returnTo=/settings/plugins/github",
      ),
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.href).toContain("github.com/apps/opencompany-user/installations/new");
    expect(location.searchParams.get("state")).toBeTruthy();
  });

  it("redirects anonymous users to sign in", async () => {
    const response = await ingress({
      authError: new ApiError(401, "authentication_required", "Authentication required."),
    }).start(new Request("https://api.example.com/integrations/github-user/start"));

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://opencompany.example.com/signin");
  });

  it("stores the personal token pair and refreshes plugin discovery for visible workspaces", async () => {
    const refresh = vi.fn(async () => undefined);
    const state = createGitHubUserIntegrationState({
      userWorkosId: "user_1",
      returnTo: "/settings/plugins/github",
    });
    const response = await ingress({ refresh }).callback(
      new Request(
        `https://api.example.com/integrations/github-user/callback?state=${encodeURIComponent(state)}&code=authorization-code&installation_id=123`,
      ),
    );

    expect(connectGitHubUserIntegration).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      githubUserId: "42",
      login: "octocat",
      name: "The Octocat",
      email: null,
      accessToken: "ghu_access",
      refreshToken: "ghr_refresh",
      tokenType: "bearer",
      accessTokenExpiresAt: new Date("2026-09-01T20:00:00.000Z"),
      refreshTokenExpiresAt: new Date("2027-03-04T12:00:00.000Z"),
      db,
    });
    expect(refresh).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      workspaceIds: ["workspace_1"],
    });
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe("/settings/plugins/github");
    expect(location.searchParams.get("integration")).toBe("github_user");
    expect(location.searchParams.get("setup")).toBe("connected");
  });

  it("rejects state for another opencompany user before exchanging the code", async () => {
    const state = createGitHubUserIntegrationState({
      userWorkosId: "user_other",
      returnTo: "/settings/plugins/github",
    });
    const response = await ingress().callback(
      new Request(
        `https://api.example.com/integrations/github-user/callback?state=${encodeURIComponent(state)}&code=authorization-code`,
      ),
    );

    expect(new URL(response.headers.get("location") ?? "").searchParams.get("reason")).toBe(
      "session_mismatch",
    );
    expect(exchangeGitHubUserCode).not.toHaveBeenCalled();
  });
});
