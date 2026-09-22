import { createHmac } from "node:crypto";
import { ExpiringOAuthReauthRequired } from "@opencompany/agent/integrations/expiring-oauth-access-token";
import {
  createGitHubUserIntegrationState,
  exchangeGitHubAppUserCode,
  fetchGitHubUserIdentity,
  GitHubUserAccessAuthError,
  GitHubUserAccessRateLimitError,
  listGitHubUserRepositoryAccess,
  resolveGitHubUserInstallTarget,
  verifyGitHubAppUserInstallation,
} from "@opencompany/agent/integrations/github-user";
import { listGitHubUserIntegrationsForInstallation } from "@opencompany/db/github-user";
import { connectGitHubUserIntegration } from "@opencompany/db/integrations";
import {
  enqueueWorkflowEventRuns,
  listWorkflowEventTriggerRoutes,
} from "@opencompany/db/workflow-event-routes";
import { listWorkspacesForUser } from "@opencompany/db/workspaces";
import { PROTOCOL_VERSION } from "@opencompany/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./errors";
import { createGitHubUserIngress } from "./github-user-ingress";

vi.mock("@opencompany/agent/integrations/github-user", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  exchangeGitHubAppUserCode: vi.fn(),
  fetchGitHubUserIdentity: vi.fn(),
  listGitHubUserRepositoryAccess: vi.fn(),
  resolveGitHubUserInstallTarget: vi.fn(),
  verifyGitHubAppUserInstallation: vi.fn(async () => ({ id: 123 })),
}));
vi.mock("@opencompany/agent/integrations/analytics", () => ({
  captureConnectionAddedAnalytics: vi.fn(async () => undefined),
}));
vi.mock("@opencompany/db/integrations", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  connectGitHubUserIntegration: vi.fn(async () => ({ integrationId: "gint_github_user" })),
}));
vi.mock("@opencompany/db/github-user", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listGitHubUserIntegrationsForInstallation: vi.fn(),
}));
vi.mock("@opencompany/db/workflow-event-routes", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  enqueueWorkflowEventRuns: vi.fn(),
  listWorkflowEventTriggerRoutes: vi.fn(),
}));
vi.mock("@opencompany/db/workspaces", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listWorkspacesForUser: vi.fn(),
}));

const db = { sentinel: "db" };
const GITHUB_WEBHOOK_SECRET = "github-webhook-secret";

function webhookRequest(envelope: Record<string, unknown>, headers: Record<string, string> = {}) {
  const rawBody = JSON.stringify(envelope);
  return new Request("https://api.example.com/webhooks/github-user/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-github-delivery": "delivery_1",
      "x-hub-signature-256": `sha256=${createHmac("sha256", GITHUB_WEBHOOK_SECRET)
        .update(rawBody)
        .digest("hex")}`,
      ...headers,
    },
    body: rawBody,
  });
}

function pullRequestEnvelope(
  action: "opened" | "ready_for_review" | "reopened" = "opened",
  draft = false,
) {
  return {
    action,
    installation: { id: 123 },
    repository: { full_name: "useopencompany/opencompany" },
    pull_request: {
      number: 1991,
      title: "Add GitHub workflow events",
      body: "Please review this change.",
      draft,
      html_url: "https://github.com/useopencompany/opencompany/pull/1991",
      created_at: "2026-09-22T12:00:00.000Z",
      updated_at: "2026-09-22T13:00:00.000Z",
      user: { login: "octocat" },
      base: { ref: "main" },
      head: { ref: "github-events", sha: "abc123" },
    },
  };
}

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
    vi.stubEnv("GITHUB_USER_APP_WEBHOOK_SECRET", GITHUB_WEBHOOK_SECRET);
    vi.stubEnv("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 9).toString("base64"));
    vi.mocked(exchangeGitHubAppUserCode).mockResolvedValue({
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
    vi.mocked(resolveGitHubUserInstallTarget).mockResolvedValue("987");
    vi.mocked(listGitHubUserRepositoryAccess).mockResolvedValue({
      checkedAt: "2026-09-02T12:00:00.000Z",
      installations: [],
      target: null,
    });
    vi.mocked(listGitHubUserIntegrationsForInstallation).mockResolvedValue([
      {
        id: "gint_github_user",
        workspaceId: null,
        userWorkosId: "user_1",
        status: "connected",
      },
    ]);
    vi.mocked(listWorkflowEventTriggerRoutes).mockResolvedValue([
      {
        workflowId: "workflow_1",
        workspaceId: "workspace_1",
        userWorkosId: "user_1",
        workflowSlug: "review-prs",
        workflowName: "Review PRs",
        prompt: "Review this pull request.",
        harnessSpec: {} as never,
        provider: "github",
        event: "pull_request.opened",
        filters: {},
      },
    ]);
    vi.mocked(enqueueWorkflowEventRuns).mockResolvedValue(1);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("starts workflow runs when a pull request opens ready for review", async () => {
    const response = await ingress().webhook(webhookRequest(pullRequestEnvelope()));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, workflowRuns: 1 });
    expect(listGitHubUserIntegrationsForInstallation).toHaveBeenCalledWith("123", db);
    expect(listWorkflowEventTriggerRoutes).toHaveBeenCalledWith(
      {
        provider: "github",
        integrations: [
          {
            id: "gint_github_user",
            workspaceId: null,
            userWorkosId: "user_1",
            status: "connected",
          },
        ],
      },
      db,
    );
    expect(enqueueWorkflowEventRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: "delivery_1",
        eventAt: new Date("2026-09-22T12:00:00.000Z"),
        context: expect.objectContaining({ tag: "github_pull_request_context" }),
      }),
      db,
    );
  });

  it("uses the ready-for-review time when a draft becomes reviewable", async () => {
    const response = await ingress().webhook(
      webhookRequest(pullRequestEnvelope("ready_for_review")),
    );

    expect(response.status).toBe(200);
    expect(enqueueWorkflowEventRuns).toHaveBeenCalledWith(
      expect.objectContaining({ eventAt: new Date("2026-09-22T13:00:00.000Z") }),
      db,
    );
  });

  it.each([
    ["draft pull request", pullRequestEnvelope("opened", true)],
    ["reopened pull request", pullRequestEnvelope("reopened")],
  ])("ignores a %s", async (_label, envelope) => {
    const response = await ingress().webhook(webhookRequest(envelope));

    await expect(response.json()).resolves.toEqual({ ok: true, ignored: true });
    expect(listGitHubUserIntegrationsForInstallation).not.toHaveBeenCalled();
    expect(enqueueWorkflowEventRuns).not.toHaveBeenCalled();
  });

  it("rejects a delivery with an invalid signature", async () => {
    const response = await ingress().webhook(
      webhookRequest(pullRequestEnvelope(), { "x-hub-signature-256": "sha256=invalid" }),
    );

    expect(response.status).toBe(401);
    expect(listGitHubUserIntegrationsForInstallation).not.toHaveBeenCalled();
  });

  it("returns a retryable response when durable enqueueing fails", async () => {
    vi.mocked(enqueueWorkflowEventRuns).mockRejectedValueOnce(new Error("database unavailable"));

    const response = await ingress().webhook(webhookRequest(pullRequestEnvelope()));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "GitHub event processing failed; retry this delivery.",
    });
  });

  it("lets a workspace member start the personal App install and authorization flow", async () => {
    const response = await ingress().start(
      new Request(
        "https://api.example.com/integrations/github-user/start?returnTo=/plugins/github",
      ),
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.href).toContain("github.com/apps/opencompany-user/installations/new");
    expect(location.searchParams.get("state")).toBeTruthy();
  });

  it("targets the requested organization through GitHub's documented permissions route", async () => {
    const response = await ingress().start(
      new Request(
        "https://api.example.com/integrations/github-user/start?returnTo=/plugins/github&owner=opencompany",
      ),
    );

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe("/apps/opencompany-user/installations/new/permissions");
    expect(location.searchParams.get("suggested_target_id")).toBe("987");
    expect(resolveGitHubUserInstallTarget).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      owner: "opencompany",
      db,
      signal: expect.any(AbortSignal),
    });
  });

  it("lists repository access without rotating the shared token on explicit re-check", async () => {
    const service = ingress();
    const response = await service.installations(
      new Request(
        "https://api.example.com/integrations/github-user/installations?owner=opencompany&repo=private-repo",
      ),
      "request_access_1",
    );
    const refreshed = await service.installations(
      new Request(
        "https://api.example.com/integrations/github-user/installations?owner=opencompany&repo=private-repo",
        { method: "POST" },
      ),
      "request_access_2",
    );

    expect(response.status).toBe(200);
    expect(refreshed.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(listGitHubUserRepositoryAccess).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        userWorkosId: "user_1",
        owner: "opencompany",
        repo: "private-repo",
        db,
      }),
    );
    expect(listGitHubUserRepositoryAccess).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        userWorkosId: "user_1",
        owner: "opencompany",
        repo: "private-repo",
        db,
      }),
    );
    expect(vi.mocked(listGitHubUserRepositoryAccess).mock.calls[0]?.[0]).not.toHaveProperty(
      "forceRefresh",
    );
    expect(vi.mocked(listGitHubUserRepositoryAccess).mock.calls[1]?.[0]).not.toHaveProperty(
      "forceRefresh",
    );
  });

  it.each([
    new GitHubUserAccessAuthError("GitHub rejected the credential."),
    new ExpiringOAuthReauthRequired("Refresh expired.", "Reconnect GitHub."),
  ])("returns a canonical reconnect response for %s", async (error) => {
    vi.mocked(listGitHubUserRepositoryAccess).mockRejectedValueOnce(error);

    const response = await ingress().installations(
      new Request("https://api.example.com/integrations/github-user/installations"),
      "request_reconnect",
    );

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "authentication_required",
        message: "Reconnect GitHub in Settings to inspect repository access.",
        requestId: "request_reconnect",
        retryable: false,
      },
      meta: { apiVersion: "v1", protocolVersion: PROTOCOL_VERSION },
    });
  });

  it("returns a retryable rate-limit envelope without misclassifying it as auth", async () => {
    vi.mocked(listGitHubUserRepositoryAccess).mockRejectedValueOnce(
      new GitHubUserAccessRateLimitError("rate limited", 30),
    );

    const response = await ingress().installations(
      new Request("https://api.example.com/integrations/github-user/installations"),
      "request_rate_limit",
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("30");
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "rate_limited",
        requestId: "request_rate_limit",
        retryable: true,
      },
      meta: { apiVersion: "v1", protocolVersion: PROTOCOL_VERSION },
    });
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
      returnTo: "/plugins/github",
    });
    const response = await ingress({ refresh }).callback(
      new Request(
        `https://api.example.com/integrations/github-user/callback?state=${encodeURIComponent(state)}&code=authorization-code&installation_id=123&setup_action=install`,
      ),
    );

    expect(connectGitHubUserIntegration).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      githubUserId: "42",
      login: "octocat",
      name: "The Octocat",
      email: null,
      installationId: "123",
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
    expect(location.pathname).toBe("/plugins/github");
    expect(location.searchParams.get("integration")).toBe("github_user");
    expect(location.searchParams.get("setup")).toBe("connected");
    expect(verifyGitHubAppUserInstallation).toHaveBeenCalledWith({
      accessToken: "ghu_access",
      installationId: "123",
    });
  });

  it("rejects an installation that is not associated with the authorized GitHub user", async () => {
    vi.mocked(verifyGitHubAppUserInstallation).mockRejectedValueOnce(new Error("not available"));
    const state = createGitHubUserIntegrationState({
      userWorkosId: "user_1",
      returnTo: "/plugins/github",
    });
    const response = await ingress().callback(
      new Request(
        `https://api.example.com/integrations/github-user/callback?state=${encodeURIComponent(state)}&code=authorization-code&installation_id=123&setup_action=install`,
      ),
    );

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("reason")).toBe("installation_not_authorized");
    expect(connectGitHubUserIntegration).not.toHaveBeenCalled();
  });

  it("requires the combined install callback grant before exchanging the code", async () => {
    const state = createGitHubUserIntegrationState({
      userWorkosId: "user_1",
      returnTo: "/plugins/github",
    });
    const response = await ingress().callback(
      new Request(
        `https://api.example.com/integrations/github-user/callback?state=${encodeURIComponent(state)}&code=authorization-code`,
      ),
    );

    expect(new URL(response.headers.get("location") ?? "").searchParams.get("reason")).toBe(
      "missing_installation_id",
    );
    expect(exchangeGitHubAppUserCode).not.toHaveBeenCalled();
  });

  it("rejects state for another opencompany user before exchanging the code", async () => {
    const state = createGitHubUserIntegrationState({
      userWorkosId: "user_other",
      returnTo: "/plugins/github",
    });
    const response = await ingress().callback(
      new Request(
        `https://api.example.com/integrations/github-user/callback?state=${encodeURIComponent(state)}&code=authorization-code`,
      ),
    );

    expect(new URL(response.headers.get("location") ?? "").searchParams.get("reason")).toBe(
      "session_mismatch",
    );
    expect(exchangeGitHubAppUserCode).not.toHaveBeenCalled();
  });
});
