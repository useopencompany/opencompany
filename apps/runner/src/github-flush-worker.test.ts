import { describe, expect, it } from "vitest";
import { buildGitHubActivityAgentIngestPrompt } from "./brain-agent-ingest";
import {
  type BufferedGitHubPullRequestEventRow,
  buildGitHubPullRequestWindowItem,
  type GitHubDueWindow,
} from "./github-flush-worker";

const window: GitHubDueWindow = {
  integrationId: "gint_github_1",
  userWorkosId: "user_1",
  installationId: "777",
  repositoryId: "4242",
  pullRequestNumber: 123,
};

describe("buildGitHubPullRequestWindowItem", () => {
  it("preserves opened, discussion, and merged activity in one item", () => {
    const item = buildGitHubPullRequestWindowItem({
      window,
      events: [mergedEvent(), openedEvent(), commentEvent()],
      flushedAt: new Date("2026-07-01T12:45:00.000Z"),
    });

    expect(item.sourceProvider).toBe("github");
    expect(item.sourceType).toBe("activity");
    expect(item.externalId).toMatch(/^gghprwin_/);
    expect(item.sourceRef).toBe("github:acme/api:pull:123");
    expect(item.occurredAt).toBe("2026-07-01T09:30:00Z");
    expect(item.content.activity).toMatchObject({
      kind: "pull_request",
      repository: { id: "4242", fullName: "acme/api", private: true },
      number: 123,
      state: "merged",
      windowStart: "2026-07-01T09:30:00Z",
      windowEnd: "2026-07-01T11:58:00Z",
    });
    expect(item.content.activity.events?.map((event) => event.state)).toEqual([
      "opened",
      "commented",
      "merged",
    ]);
    expect(item.content.activity.events?.[1]).toMatchObject({
      sourceRef: "github:acme/api:pull:123:comment:987654321",
      author: "grace",
      body: "Please keep the retry cutoff at 24 hours.",
    });

    const prompt = buildGitHubActivityAgentIngestPrompt(item);
    expect(prompt).toContain("one activity window");
    expect(prompt).toContain("### 1. opened");
    expect(prompt).toContain("### 2. commented");
    expect(prompt).toContain("### 3. merged");
    expect(prompt).toContain("Please keep the retry cutoff at 24 hours.");
  });

  it("rejects a buffered payload that does not match its window key", () => {
    expect(() =>
      buildGitHubPullRequestWindowItem({
        window,
        events: [
          {
            ...openedEvent(),
            payload: pullRequestPayload("opened", {
              number: 999,
              merged: false,
              merged_at: null,
            }),
          },
        ],
        flushedAt: new Date("2026-07-01T12:45:00.000Z"),
      }),
    ).toThrow("no longer matches its pull-request window");
  });
});

function openedEvent(): BufferedGitHubPullRequestEventRow {
  return {
    id: "gghprevt_opened",
    deliveryId: "delivery_opened",
    eventType: "pull_request_opened",
    payload: pullRequestPayload("opened", { merged: false, merged_at: null }),
    eventTime: "2026-07-01T09:30:00Z",
    receivedAt: "2026-07-01T09:30:01Z",
  };
}

function commentEvent(): BufferedGitHubPullRequestEventRow {
  return {
    id: "gghprevt_comment",
    deliveryId: "delivery_comment",
    eventType: "pull_request_commented",
    payload: {
      action: "created",
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
    },
    eventTime: "2026-07-01T11:00:00Z",
    receivedAt: "2026-07-01T11:00:01Z",
  };
}

function mergedEvent(): BufferedGitHubPullRequestEventRow {
  return {
    id: "gghprevt_merged",
    deliveryId: "delivery_merged",
    eventType: "pull_request_merged",
    payload: pullRequestPayload("closed", { merged: true }),
    eventTime: "2026-07-01T11:58:00Z",
    receivedAt: "2026-07-01T11:58:01Z",
  };
}

function pullRequestPayload(action: string, overrides: Record<string, unknown>) {
  return {
    action,
    repository: { id: 4242, full_name: "acme/api", private: true },
    pull_request: {
      number: 123,
      merged: true,
      title: "Add usage-based billing",
      body: "Implements metered billing per workspace.",
      html_url: "https://github.com/acme/api/pull/123",
      user: { login: "ada" },
      merged_by: { login: "grace" },
      created_at: "2026-07-01T09:30:00Z",
      merged_at: "2026-07-01T11:58:00Z",
      base: { ref: "main" },
      head: { ref: "billing" },
      additions: 120,
      deletions: 12,
      changed_files: 9,
      commits: 4,
      labels: [{ name: "feature" }],
      ...overrides,
    },
  };
}
