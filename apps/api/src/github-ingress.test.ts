import {
  createGitHubIntegrationState,
  exchangeGitHubUserCode,
  getGitHubInstallation,
  listGitHubInstallationRepositories,
  syncGitHubIntegrationRepositories,
  verifyGitHubUserInstallation,
} from "@opencompany/agent/integrations/github";
import { verifyGitHubWebhookSignature } from "@opencompany/agent/integrations/github-signature";
import { captureProductIngestionQuotaAnalytics } from "@opencompany/analytics/product";
import { upsertBrainSourceItemAndEnqueue } from "@opencompany/db/brain-ingest";
import {
  insertGitHubPullRequestEvents,
  listEnabledGitHubBrainSourceRoutes,
  listEnabledGitHubWikiSourceRoutes,
  listGitHubIntegrationsForInstallation,
} from "@opencompany/db/github";
import { markIntegrationStatus } from "@opencompany/db/integrations";
import {
  attributeWikiSourceEventClaims,
  claimWikiSourceEvents,
} from "@opencompany/db/wiki-event-claims";
import { upsertWikiSourceItemAndEnqueue } from "@opencompany/db/wiki-ingest";
import { listWorkspacesForUser } from "@opencompany/db/workspaces";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./errors";
import { createGitHubIngress } from "./github-ingress";

vi.mock("@opencompany/analytics/product", () => ({
  captureProductIngestionQuotaAnalytics: vi.fn(),
}));
vi.mock("@opencompany/db/brain-ingest", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  upsertBrainSourceItemAndEnqueue: vi.fn(),
}));
vi.mock("@opencompany/db/github", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  insertGitHubPullRequestEvents: vi.fn(),
  listEnabledGitHubBrainSourceRoutes: vi.fn(),
  listEnabledGitHubWikiSourceRoutes: vi.fn(),
  listGitHubIntegrationsForInstallation: vi.fn(),
}));
vi.mock("@opencompany/db/wiki-event-claims", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  attributeWikiSourceEventClaims: vi.fn(),
  claimWikiSourceEvents: vi.fn(),
}));
vi.mock("@opencompany/db/wiki-ingest", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  upsertWikiSourceItemAndEnqueue: vi.fn(),
}));
vi.mock("@opencompany/agent/integrations/github", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  exchangeGitHubUserCode: vi.fn(),
  verifyGitHubUserInstallation: vi.fn(),
  getGitHubInstallation: vi.fn(),
  listGitHubInstallationRepositories: vi.fn(),
  syncGitHubIntegrationRepositories: vi.fn(),
}));
vi.mock("@opencompany/agent/integrations/github-signature", () => ({
  verifyGitHubWebhookSignature: vi.fn(),
}));
vi.mock("@opencompany/db/integrations", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  markIntegrationStatus: vi.fn(),
}));

const sentinelDb = { sentinel: "db" };

vi.mock("@opencompany/db/workspaces", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listWorkspacesForUser: vi.fn(),
}));

function ingress(
  overrides: {
    role?: string;
    noWorkspaces?: boolean;
    authError?: ApiError;
    wakeWikiIngest?: () => Promise<unknown>;
  } = {},
) {
  vi.mocked(listWorkspacesForUser).mockResolvedValue(
    overrides.noWorkspaces
      ? []
      : ([
          {
            workspace: { id: "workspace_1", workosOrganizationId: null },
            role: overrides.role ?? "admin",
          },
        ] as never),
  );
  return createGitHubIngress({
    db: sentinelDb,
    identify: async () => {
      if (overrides.authError) throw overrides.authError;
      return {
        userId: "user_1",
        organizationId: null,
        method: "session",
        activeWorkspaceId: null,
        activeBrainId: null,
      };
    },
    ...(overrides.wakeWikiIngest ? { wakeWikiIngest: overrides.wakeWikiIngest } : {}),
  });
}

describe("GitHub ingress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OPENCOMPANY_NEXT_PUBLIC_APP_URL", "https://opencompany.example.com");
    vi.stubEnv("GITHUB_INTEGRATION_APP_ID", "1234");
    vi.stubEnv("GITHUB_INTEGRATION_APP_PRIVATE_KEY", "key");
    vi.stubEnv("GITHUB_INTEGRATION_APP_SLUG", "goat-app");
    vi.stubEnv("GITHUB_INTEGRATION_APP_CLIENT_ID", "Iv1_client");
    vi.stubEnv("GITHUB_INTEGRATION_APP_CLIENT_SECRET", "client-secret");
    vi.stubEnv("GITHUB_INTEGRATION_STATE_SECRET", "state-secret-state-secret-state-secret");
    vi.mocked(verifyGitHubWebhookSignature).mockReturnValue(true);
    vi.mocked(listGitHubIntegrationsForInstallation).mockResolvedValue([
      { id: "gint_github_1", userWorkosId: "user_1", status: "connected" },
    ] as never);
    vi.mocked(listEnabledGitHubBrainSourceRoutes).mockResolvedValue([
      {
        integrationId: "gint_github_1",
        brainRef: "gbrain_1",
        config: {
          repos: [{ id: "4242", fullName: "acme/api" }],
          events: [
            "pull_request_opened",
            "pull_request_merged",
            "pull_request_commented",
            "issue_opened",
            "issue_commented",
          ],
        },
      },
    ] as never);
    vi.mocked(listEnabledGitHubWikiSourceRoutes).mockResolvedValue([]);
    vi.mocked(insertGitHubPullRequestEvents).mockResolvedValue(1);
    vi.mocked(upsertBrainSourceItemAndEnqueue).mockResolvedValue({
      sourceItemId: "gbsrc_1",
      jobId: "gbjob_1",
      jobIds: ["gbjob_1"],
      enqueued: true,
      skipped: false,
    } as never);
    vi.mocked(claimWikiSourceEvents).mockResolvedValue({
      claimedCount: 1,
      claimedEventKeys: ["777:github:acme/api:issue:45:delivery_123"],
    });
    vi.mocked(upsertWikiSourceItemAndEnqueue).mockResolvedValue({
      sourceItemId: "gwsrc_1",
      jobId: "gwjob_1",
      enqueued: true,
      skipped: false,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe("start", () => {
    it("redirects an admin to the GitHub install URL with signed state", async () => {
      const response = await ingress().start(
        new Request("https://api.example.com/integrations/github/start?returnTo=/settings"),
      );
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("location") ?? "");
      expect(location.origin).toBe("https://github.com");
      expect(location.pathname).toBe("/apps/goat-app/installations/new");
      expect(location.searchParams.get("state")).toBeTruthy();
    });

    it("sends non-admins back to the web app with the admin_required reason", async () => {
      const response = await ingress({ role: "member" }).start(
        new Request("https://api.example.com/integrations/github/start"),
      );
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("location") ?? "");
      expect(location.origin).toBe("https://opencompany.example.com");
      expect(location.searchParams.get("reason")).toBe("admin_required");
    });

    it("redirects anonymous browsers to the web sign-in", async () => {
      const response = await ingress({
        authError: new ApiError(401, "authentication_required", "Authentication required."),
      }).start(new Request("https://api.example.com/integrations/github/start"));
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("https://opencompany.example.com/signin");
    });

    it("redirects users without a visible workspace to onboarding", async () => {
      const response = await ingress({ noWorkspaces: true }).start(
        new Request("https://api.example.com/integrations/github/start"),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("https://opencompany.example.com/onboarding");
    });

    it("admits mid-onboarding admins whose workspace already exists", async () => {
      // The onboarding wizard connects GitHub before onboarded_at is set, so
      // ingress must not apply the /v1 onboarding gate. Identity resolution
      // here never checks onboarding state; a visible workspace is enough.
      const response = await ingress().start(
        new Request(
          "https://api.example.com/integrations/github/start?returnTo=/onboarding/connected",
        ),
      );
      expect(response.status).toBe(302);
      expect(new URL(response.headers.get("location") ?? "").origin).toBe("https://github.com");
    });
  });

  describe("callback", () => {
    it("rejects a state minted for a different user with session_mismatch", async () => {
      const state = createGitHubIntegrationState({
        userWorkosId: "user_other",
        workspaceId: "workspace_1",
        returnTo: "/settings",
      });
      const response = await ingress().callback(
        new Request(
          `https://api.example.com/integrations/github/callback?state=${encodeURIComponent(state)}`,
        ),
      );
      expect(new URL(response.headers.get("location") ?? "").searchParams.get("reason")).toBe(
        "session_mismatch",
      );
    });

    it("maps GitHub denial and a missing installation id to their reasons", async () => {
      const state = createGitHubIntegrationState({
        userWorkosId: "user_1",
        workspaceId: "workspace_1",
        returnTo: "/settings",
      });
      const denied = await ingress().callback(
        new Request(
          `https://api.example.com/integrations/github/callback?state=${encodeURIComponent(state)}&error=access_denied`,
        ),
      );
      expect(new URL(denied.headers.get("location") ?? "").searchParams.get("reason")).toBe(
        "github_denied",
      );

      const missing = await ingress().callback(
        new Request(
          `https://api.example.com/integrations/github/callback?state=${encodeURIComponent(state)}`,
        ),
      );
      expect(new URL(missing.headers.get("location") ?? "").searchParams.get("reason")).toBe(
        "missing_installation_id",
      );
    });

    it("rejects a tampered state with the invalid_state reason", async () => {
      const response = await ingress().callback(
        new Request("https://api.example.com/integrations/github/callback?state=garbage"),
      );
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("location") ?? "");
      expect(location.origin).toBe("https://opencompany.example.com");
      expect(location.searchParams.get("reason")).toBe("invalid_state");
    });

    it("requires the finishing session to still be an admin of the state workspace", async () => {
      const state = createGitHubIntegrationState({
        userWorkosId: "user_1",
        workspaceId: "workspace_1",
        returnTo: "/settings",
      });
      const response = await ingress({ role: "member" }).callback(
        new Request(
          `https://api.example.com/integrations/github/callback?state=${encodeURIComponent(state)}&installation_id=777&code=abc`,
        ),
      );
      expect(response.status).toBe(302);
      expect(new URL(response.headers.get("location") ?? "").searchParams.get("reason")).toBe(
        "admin_required",
      );
      expect(syncGitHubIntegrationRepositories).not.toHaveBeenCalled();
    });

    it("redirects to user authorization when the installation lands without a code", async () => {
      const state = createGitHubIntegrationState({
        userWorkosId: "user_1",
        workspaceId: "workspace_1",
        returnTo: "/settings",
      });
      const response = await ingress().callback(
        new Request(
          `https://api.example.com/integrations/github/callback?state=${encodeURIComponent(state)}&installation_id=777`,
        ),
      );
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("location") ?? "");
      expect(location.origin).toBe("https://github.com");
      expect(location.pathname).toBe("/login/oauth/authorize");
      expect(location.searchParams.get("redirect_uri")).toBe(
        "https://opencompany.example.com/api/integrations/github/callback",
      );
    });

    it("syncs repositories through the injected database and reports connected", async () => {
      vi.mocked(exchangeGitHubUserCode).mockResolvedValue("user-token");
      vi.mocked(verifyGitHubUserInstallation).mockResolvedValue({
        id: 777,
        account: { login: "acme", type: "Organization" },
      } as never);
      vi.mocked(getGitHubInstallation).mockResolvedValue({
        id: 777,
        account: { login: "acme", type: "Organization" },
      } as never);
      vi.mocked(listGitHubInstallationRepositories).mockResolvedValue([
        { githubRepoId: "4242", fullName: "acme/api", defaultBranch: "main", private: true },
      ]);
      vi.mocked(syncGitHubIntegrationRepositories).mockResolvedValue(undefined as never);

      const state = createGitHubIntegrationState({
        userWorkosId: "user_1",
        workspaceId: "workspace_1",
        returnTo: "/settings",
      });
      const response = await ingress().callback(
        new Request(
          `https://api.example.com/integrations/github/callback?state=${encodeURIComponent(state)}&installation_id=777&code=abc`,
        ),
      );
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("location") ?? "");
      expect(location.searchParams.get("setup")).toBe("connected");
      expect(syncGitHubIntegrationRepositories).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: "workspace_1", installationId: "777" }),
        expect.objectContaining({ sentinel: "db" }),
      );
    });
  });

  describe("webhook", () => {
    function githubRequest(eventName: string, payload: Record<string, unknown>) {
      return new Request("https://api.example.com/webhooks/github/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": eventName,
          "x-github-delivery": "delivery_123",
          "x-hub-signature-256": "valid-signature",
        },
        body: JSON.stringify(payload),
      });
    }

    it("rejects deliveries with an invalid signature", async () => {
      vi.mocked(verifyGitHubWebhookSignature).mockReturnValue(false);
      const response = await ingress().webhook(githubRequest("issues", issuePayload()));
      expect(response.status).toBe(401);
    });

    it("marks integrations needs_reauth on uninstall through the injected db", async () => {
      const response = await ingress().webhook(
        githubRequest("installation", { action: "deleted", installation: { id: 777 } }),
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true, marked: 1 });
      expect(markIntegrationStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          integrationId: "gint_github_1",
          status: "needs_reauth",
          db: expect.objectContaining({ sentinel: "db" }),
        }),
      );
    });

    it("acknowledges ping deliveries", async () => {
      const response = await ingress().webhook(githubRequest("ping", { zen: "Keep it simple." }));
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
    });

    it("buffers pull-request activity instead of enqueueing it directly", async () => {
      const response = await ingress().webhook(githubRequest("pull_request", pullRequestPayload()));
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true, buffered: 1 });
      expect(insertGitHubPullRequestEvents).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            integrationId: "gint_github_1",
            userWorkosId: "user_1",
            installationId: "777",
            repositoryId: "4242",
            pullRequestNumber: 123,
            deliveryId: "delivery_123",
            eventType: "pull_request_opened",
          }),
        ],
        expect.objectContaining({ sentinel: "db" }),
      );
      expect(upsertBrainSourceItemAndEnqueue).not.toHaveBeenCalled();
      expect(captureProductIngestionQuotaAnalytics).not.toHaveBeenCalled();
    });

    it("buffers pull-request activity for a wiki-only repository route", async () => {
      vi.mocked(listEnabledGitHubBrainSourceRoutes).mockResolvedValue([]);
      vi.mocked(listEnabledGitHubWikiSourceRoutes).mockResolvedValue([
        {
          integrationId: "gint_github_1",
          workspaceId: "workspace_1",
          config: {
            repos: [{ id: "4242", fullName: "acme/api" }],
            events: ["pull_request_opened"],
          },
        },
      ] as never);

      const response = await ingress().webhook(githubRequest("pull_request", pullRequestPayload()));

      expect(await response.json()).toEqual({ ok: true, buffered: 1 });
      expect(insertGitHubPullRequestEvents).toHaveBeenCalledOnce();
      expect(upsertBrainSourceItemAndEnqueue).not.toHaveBeenCalled();
      expect(upsertWikiSourceItemAndEnqueue).not.toHaveBeenCalled();
    });

    it("keeps issue activity on the immediate ingest path with the injected db", async () => {
      const response = await ingress().webhook(githubRequest("issues", issuePayload()));
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true, enqueued: 1 });
      expect(insertGitHubPullRequestEvents).not.toHaveBeenCalled();
      expect(upsertBrainSourceItemAndEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          integrationId: "gint_github_1",
          brainRefs: ["gbrain_1"],
          db: expect.objectContaining({ sentinel: "db" }),
        }),
      );
    });

    it("claims and enqueues an in-scope issue for a wiki-only route, then wakes the runner", async () => {
      vi.mocked(listEnabledGitHubBrainSourceRoutes).mockResolvedValue([]);
      vi.mocked(listEnabledGitHubWikiSourceRoutes).mockResolvedValue([
        {
          integrationId: "gint_github_1",
          workspaceId: "workspace_1",
          config: {
            repos: [{ id: "4242", fullName: "acme/api" }],
            events: ["issue_opened"],
          },
        },
      ] as never);
      const wakeWikiIngest = vi.fn(async () => undefined);

      const response = await ingress({ wakeWikiIngest }).webhook(
        githubRequest("issues", issuePayload()),
      );

      expect(await response.json()).toEqual({ ok: true, enqueued: 1 });
      expect(upsertBrainSourceItemAndEnqueue).not.toHaveBeenCalled();
      expect(claimWikiSourceEvents).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: "workspace_1", sourceProvider: "github" }),
      );
      expect(upsertWikiSourceItemAndEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: "workspace_1",
          integrationId: "gint_github_1",
          db: expect.objectContaining({ sentinel: "db" }),
        }),
      );
      expect(attributeWikiSourceEventClaims).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: "workspace_1", sourceItemId: "gwsrc_1" }),
      );
      expect(wakeWikiIngest).toHaveBeenCalledOnce();
    });

    it("does not enqueue or wake an out-of-scope wiki issue", async () => {
      vi.mocked(listEnabledGitHubBrainSourceRoutes).mockResolvedValue([]);
      vi.mocked(listEnabledGitHubWikiSourceRoutes).mockResolvedValue([
        {
          integrationId: "gint_github_1",
          workspaceId: "workspace_1",
          config: {
            repos: [{ id: "9999", fullName: "acme/other" }],
            events: ["issue_opened"],
          },
        },
      ] as never);
      const wakeWikiIngest = vi.fn(async () => undefined);

      const response = await ingress({ wakeWikiIngest }).webhook(
        githubRequest("issues", issuePayload()),
      );

      expect(await response.json()).toEqual({ ok: true, dropped: true });
      expect(claimWikiSourceEvents).not.toHaveBeenCalled();
      expect(upsertWikiSourceItemAndEnqueue).not.toHaveBeenCalled();
      expect(wakeWikiIngest).not.toHaveBeenCalled();
    });

    it("keeps a successful GitHub response when the best-effort wiki wake fails", async () => {
      vi.mocked(listEnabledGitHubBrainSourceRoutes).mockResolvedValue([]);
      vi.mocked(listEnabledGitHubWikiSourceRoutes).mockResolvedValue([
        {
          integrationId: "gint_github_1",
          workspaceId: "workspace_1",
          config: {
            repos: [{ id: "4242", fullName: "acme/api" }],
            events: ["issue_opened"],
          },
        },
      ] as never);
      const wakeWikiIngest = vi.fn(async () => {
        throw new Error("runner unavailable");
      });

      const response = await ingress({ wakeWikiIngest }).webhook(
        githubRequest("issues", issuePayload()),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, enqueued: 1 });
      expect(wakeWikiIngest).toHaveBeenCalledOnce();
    });

    it("returns a retryable response when pull-request buffering fails", async () => {
      vi.mocked(insertGitHubPullRequestEvents).mockRejectedValueOnce(
        new Error("database unavailable"),
      );
      const response = await ingress().webhook(githubRequest("pull_request", pullRequestPayload()));
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: "Unable to process GitHub event.",
      });
    });
  });
});

function pullRequestPayload() {
  return {
    action: "opened",
    installation: { id: 777 },
    repository: { id: 4242, full_name: "acme/api", private: true },
    pull_request: {
      number: 123,
      merged: false,
      title: "Add usage-based billing",
      body: "Implements metered billing per workspace.",
      html_url: "https://github.com/acme/api/pull/123",
      user: { login: "ada" },
      created_at: "2026-07-01T09:30:00Z",
      base: { ref: "main" },
      head: { ref: "billing" },
      additions: 120,
      deletions: 12,
      changed_files: 9,
      commits: 4,
      labels: [{ name: "feature" }],
    },
  };
}

function issuePayload() {
  return {
    action: "opened",
    installation: { id: 777 },
    repository: { id: 4242, full_name: "acme/api", private: true },
    issue: {
      number: 45,
      title: "Billing webhook drops retries",
      body: "Stripe retries are acked before processing.",
      html_url: "https://github.com/acme/api/issues/45",
      user: { login: "ada" },
      created_at: "2026-07-01T10:00:00Z",
      labels: [{ name: "bug" }],
    },
  };
}
