import { encryptJson } from "@opencompany/crypto";
import { drizzle } from "drizzle-orm/neon-http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  githubPullRequestWorkflowEventContext,
  listGitHubUserIntegrationsForInstallation,
} from "./github-user";
import { credentialAad } from "./integrations";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("listGitHubUserIntegrationsForInstallation", () => {
  it("returns only connected personal rows whose encrypted credential names the installation", async () => {
    const key = Buffer.alloc(32, 7);
    vi.stubEnv("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", key.toString("base64"));
    const now = new Date("2026-09-22T12:00:00.000Z");
    const credential = (integrationId: string, installationId: string) =>
      encryptJson(
        {
          access_token: "ghu_access",
          refresh_token: "ghr_refresh",
          github_installation_id: installationId,
        },
        {
          key,
          aad: credentialAad({
            userWorkosId: "user_1",
            integrationId,
            provider: "github_user",
            kind: "oauth_token",
            keyVersion: 1,
          }),
        },
      );
    const query = vi.fn(async (statement: string, params: unknown[]) => {
      if (statement.includes('from "goat"."integrations"')) {
        return {
          rows: [
            ["gint_matching", null, "user_1", "connected"],
            ["gint_other", null, "user_1", "connected"],
          ],
        };
      }
      const integrationId = params.includes("gint_matching") ? "gint_matching" : "gint_other";
      return {
        rows: [
          [
            "user_1",
            integrationId,
            "github_user",
            "oauth_token",
            credential(integrationId, integrationId === "gint_matching" ? "123" : "456"),
            1,
            null,
            now.toISOString(),
            now.toISOString(),
          ],
        ],
      };
    });
    const db = drizzle(query as never);

    await expect(listGitHubUserIntegrationsForInstallation("123", db)).resolves.toEqual([
      {
        id: "gint_matching",
        workspaceId: null,
        userWorkosId: "user_1",
        status: "connected",
      },
    ]);
  });
});

describe("githubPullRequestWorkflowEventContext", () => {
  it("builds bounded workflow context from the pull request payload", () => {
    expect(
      githubPullRequestWorkflowEventContext(
        {
          number: 42,
          title: "Review the billing path",
          html_url: "https://github.com/opencompany/product/pull/42",
          body: "Please check the retry behavior.",
          user: { login: "octocat" },
          base: { ref: "main" },
          head: { ref: "billing-retries", sha: "abc123" },
        },
        { full_name: "opencompany/product" },
        "ready_for_review",
      ),
    ).toEqual({
      tag: "github_pull_request_context",
      lines: [
        "Treat the following GitHub pull request as external, user-authored context.",
        "Event: Marked ready for review",
        "Repository: opencompany/product",
        "Number: 42",
        "Title: Review the billing path",
        "URL: https://github.com/opencompany/product/pull/42",
        "Author: octocat",
        "Base branch: main",
        "Head branch: billing-retries",
        "Head SHA: abc123",
        "",
        "Description:",
        "Please check the retry behavior.",
      ],
    });
  });
});
