import { captureIngestionQuotaAnalytics } from "@opencompany/analytics/app";
import { upsertBrainSourceItemAndEnqueue } from "@opencompany/db/brain-ingest";
import {
  insertGitHubPullRequestEvents,
  listEnabledGitHubBrainSourceRoutes,
  listGitHubIntegrationsForInstallation,
} from "@opencompany/db/github";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyGitHubWebhookSignature } from "@/lib/integrations/github-signature";
import { triggerBrainIngestWake } from "@/lib/task-runner";
import { POST } from "./route";

vi.mock("@opencompany/analytics/app", () => ({
  captureIngestionQuotaAnalytics: vi.fn(),
}));
vi.mock("@opencompany/db/brain-ingest", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  upsertBrainSourceItemAndEnqueue: vi.fn(),
}));
vi.mock("@opencompany/db/github", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  insertGitHubPullRequestEvents: vi.fn(),
  listEnabledGitHubBrainSourceRoutes: vi.fn(),
  listGitHubIntegrationsForInstallation: vi.fn(),
}));
vi.mock("@/lib/integrations/github-signature", () => ({
  verifyGitHubWebhookSignature: vi.fn(),
}));
vi.mock("@/lib/task-runner", () => ({
  triggerBrainIngestWake: vi.fn(),
}));

describe("POST /api/webhooks/github/events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(verifyGitHubWebhookSignature).mockReturnValue(true);
    vi.mocked(listGitHubIntegrationsForInstallation).mockResolvedValue([
      { id: "gint_github_1", userWorkosId: "user_1", status: "connected" },
    ]);
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
    ]);
    vi.mocked(insertGitHubPullRequestEvents).mockResolvedValue(1);
    vi.mocked(upsertBrainSourceItemAndEnqueue).mockResolvedValue({
      sourceItemId: "gbsrc_1",
      jobId: "gbjob_1",
      jobIds: ["gbjob_1"],
      enqueued: true,
      skipped: false,
    });
    vi.mocked(triggerBrainIngestWake).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("buffers pull-request activity instead of enqueueing it directly", async () => {
    const response = await POST(githubRequest("pull_request", pullRequestPayload()));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, buffered: 1 });
    expect(insertGitHubPullRequestEvents).toHaveBeenCalledWith([
      expect.objectContaining({
        integrationId: "gint_github_1",
        userWorkosId: "user_1",
        installationId: "777",
        repositoryId: "4242",
        pullRequestNumber: 123,
        deliveryId: "delivery_123",
        eventType: "pull_request_opened",
      }),
    ]);
    expect(upsertBrainSourceItemAndEnqueue).not.toHaveBeenCalled();
    expect(captureIngestionQuotaAnalytics).not.toHaveBeenCalled();
  });

  it("buffers pull-request discussion under the parent PR window", async () => {
    const response = await POST(githubRequest("issue_comment", pullRequestCommentPayload()));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, buffered: 1 });
    expect(insertGitHubPullRequestEvents).toHaveBeenCalledWith([
      expect.objectContaining({
        repositoryId: "4242",
        pullRequestNumber: 123,
        eventType: "pull_request_commented",
      }),
    ]);
    expect(upsertBrainSourceItemAndEnqueue).not.toHaveBeenCalled();
  });

  it("keeps issue activity on the immediate ingest path", async () => {
    const response = await POST(githubRequest("issues", issuePayload()));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, enqueued: 1 });
    expect(insertGitHubPullRequestEvents).not.toHaveBeenCalled();
    expect(upsertBrainSourceItemAndEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        integrationId: "gint_github_1",
        brainRefs: ["gbrain_1"],
      }),
    );
    expect(triggerBrainIngestWake).toHaveBeenCalledOnce();
  });

  it("returns a retryable response when pull-request buffering fails", async () => {
    vi.mocked(insertGitHubPullRequestEvents).mockRejectedValueOnce(
      new Error("database unavailable"),
    );

    const response = await POST(githubRequest("pull_request", pullRequestPayload()));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Unable to process GitHub event.",
    });
    expect(console.error).toHaveBeenCalledWith(
      "[github] Failed to process GitHub event",
      expect.objectContaining({
        eventName: "pull_request",
        action: "opened",
        error: "database unavailable",
      }),
    );
  });
});

function githubRequest(eventName: string, payload: Record<string, unknown>) {
  return new Request("https://app.example.com/api/webhooks/github/events", {
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

function pullRequestCommentPayload() {
  return {
    action: "created",
    installation: { id: 777 },
    repository: { id: 4242, full_name: "acme/api", private: true },
    issue: {
      number: 123,
      title: "Add usage-based billing",
      labels: [{ name: "feature" }],
      pull_request: { url: "https://api.github.com/repos/acme/api/pulls/123" },
    },
    comment: {
      id: 987654321,
      body: "Please keep the retry cutoff at 24 hours.",
      html_url: "https://github.com/acme/api/pull/123#issuecomment-987654321",
      user: { login: "grace" },
      created_at: "2026-07-01T11:00:00Z",
    },
  };
}
