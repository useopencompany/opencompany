import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isGitHubAppWebhookConfigured,
  parseGitHubAppWebhook,
  verifyGitHubWebhookSignature,
} from "./github-app-events";

const SECRET = "github-app-webhook-secret";

function sign(body: string, secret = SECRET) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function issueDelivery(overrides: Record<string, unknown> = {}) {
  return {
    action: "opened",
    installation: { id: 7 },
    sender: { login: "ada", type: "User" },
    repository: { id: 42, full_name: "acme/app" },
    issue: {
      number: 12,
      title: "Checkout fails",
      body: "Steps to reproduce",
      html_url: "https://github.com/acme/app/issues/12",
      created_at: "2026-09-23T10:00:00Z",
      user: { login: "ada" },
      labels: [{ name: "bug" }],
    },
    ...overrides,
  };
}

describe("GitHub App webhook signatures", () => {
  beforeEach(() => vi.stubEnv("GITHUB_USER_APP_WEBHOOK_SECRET", SECRET));
  afterEach(() => vi.unstubAllEnvs());

  it("accepts the App's sha256 signature over the raw body", () => {
    const body = JSON.stringify(issueDelivery());
    expect(isGitHubAppWebhookConfigured()).toBe(true);
    expect(verifyGitHubWebhookSignature({ rawBody: body, signature: sign(body) })).toBe(true);
  });

  it("rejects a wrong secret, a changed body, and a missing prefix", () => {
    const body = JSON.stringify(issueDelivery());
    expect(verifyGitHubWebhookSignature({ rawBody: body, signature: sign(body, "other") })).toBe(
      false,
    );
    expect(verifyGitHubWebhookSignature({ rawBody: `${body} `, signature: sign(body) })).toBe(
      false,
    );
    expect(verifyGitHubWebhookSignature({ rawBody: body, signature: sign(body).slice(7) })).toBe(
      false,
    );
  });

  it("rejects everything while the secret is unset", () => {
    vi.stubEnv("GITHUB_USER_APP_WEBHOOK_SECRET", "");
    const body = JSON.stringify(issueDelivery());
    expect(isGitHubAppWebhookConfigured()).toBe(false);
    expect(verifyGitHubWebhookSignature({ rawBody: body, signature: sign(body) })).toBe(false);
  });
});

describe("GitHub App webhook parsing", () => {
  it("maps an opened issue to the company event with untrusted context", () => {
    const parsed = parseGitHubAppWebhook({ eventName: "issues", payload: issueDelivery() });
    expect(parsed).toMatchObject({
      kind: "workflow_event",
      event: "issue.opened",
      installationId: "7",
      repositoryId: "42",
      occurredAt: new Date("2026-09-23T10:00:00Z"),
    });
    if (parsed.kind !== "workflow_event") throw new Error("expected an event");
    expect(parsed.context.tag).toBe("github_issue_context");
    expect(parsed.context.lines).toEqual(
      expect.arrayContaining([
        expect.stringContaining("untrusted"),
        "Repository: acme/app",
        "Issue: #12",
        "Labels: bug",
        "Steps to reproduce",
      ]),
    );
  });

  it("maps an opened pull request, including drafts", () => {
    const parsed = parseGitHubAppWebhook({
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 7 },
        sender: { type: "User" },
        repository: { id: 42, full_name: "acme/app" },
        pull_request: {
          number: 3,
          title: "Fix checkout",
          draft: true,
          head: { label: "ada:fix" },
          base: { ref: "main" },
          created_at: "2026-09-23T11:00:00Z",
        },
      },
    });
    expect(parsed).toMatchObject({ kind: "workflow_event", event: "pull_request.opened" });
    if (parsed.kind !== "workflow_event") throw new Error("expected an event");
    expect(parsed.context.lines).toEqual(
      expect.arrayContaining(["Draft: yes", "Branches: ada:fix → main"]),
    );
  });

  it("ignores bots, other actions, and pull requests reported as issues", () => {
    expect(
      parseGitHubAppWebhook({
        eventName: "issues",
        payload: issueDelivery({ sender: { login: "renovate[bot]", type: "Bot" } }),
      }),
    ).toEqual({ kind: "ignored", reason: "bot_sender" });
    expect(
      parseGitHubAppWebhook({ eventName: "issues", payload: issueDelivery({ action: "closed" }) }),
    ).toEqual({ kind: "ignored", reason: "unsupported_action" });
    expect(
      parseGitHubAppWebhook({
        eventName: "issues",
        payload: issueDelivery({ issue: { number: 1, pull_request: {} } }),
      }),
    ).toEqual({ kind: "ignored", reason: "not_an_issue" });
    expect(parseGitHubAppWebhook({ eventName: "push", payload: issueDelivery() })).toEqual({
      kind: "ignored",
      reason: "unsupported_event",
    });
  });

  it("reports an uninstall", () => {
    expect(
      parseGitHubAppWebhook({
        eventName: "installation",
        payload: { action: "deleted", installation: { id: 7 } },
      }),
    ).toEqual({ kind: "installation_removed", installationId: "7" });
  });
});
