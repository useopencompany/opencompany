import {
  GitHubUserAccessAuthError,
  GitHubUserAccessRateLimitError,
} from "@opencompany/agent/integrations/github-user";
import { describe, expect, it, vi } from "vitest";
import type { ApiIdentity } from "./auth";
import { createOnboardingRepositoryScanService } from "./onboarding-repository-scan";

const identity = { userId: "user_1" } as ApiIdentity;
const setup = {
  repository: { fullName: "acme/app", private: true },
  repositories: ["acme/app", "acme/site"],
  paths: ["package.json", "render.yaml"],
  files: [{ path: "package.json", text: JSON.stringify({ dependencies: { "posthog-js": "1" } }) }],
};

describe("onboarding repository scan", () => {
  it("returns the recommended plugins for the scanned repository", async () => {
    const recommend = vi.fn(async () => ({
      plugins: [{ plugin: "posthog" as const, reason: "posthog-js in package.json" }],
      recommendedBy: "jev" as const,
    }));
    const readSetupFiles = vi.fn(async () => setup);
    const service = createOnboardingRepositoryScanService({
      db: {},
      apiKey: "gateway-key",
      readSetupFiles,
      recommend,
    });

    await expect(service.scan(identity, { repository: "acme/app" })).resolves.toEqual({
      status: "scanned",
      repository: { fullName: "acme/app", private: true },
      repositories: ["acme/app", "acme/site"],
      plugins: [{ plugin: "posthog", reason: "posthog-js in package.json" }],
      recommendedBy: "jev",
    });
    expect(readSetupFiles).toHaveBeenCalledWith(
      expect.objectContaining({ userWorkosId: "user_1", repository: "acme/app" }),
    );
    expect(recommend).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "gateway-key",
        evidence: expect.objectContaining({ configFiles: ["render.yaml"] }),
      }),
    );
  });

  it("reports a missing or revoked GitHub connection as not connected", async () => {
    const service = createOnboardingRepositoryScanService({
      db: {},
      readSetupFiles: vi.fn(async () => {
        throw new GitHubUserAccessAuthError("Connect GitHub");
      }),
    });
    await expect(service.scan(identity, {})).resolves.toEqual({ status: "not_connected" });
  });

  it("reports an account without repositories", async () => {
    const service = createOnboardingRepositoryScanService({
      db: {},
      readSetupFiles: vi.fn(async () => null),
    });
    await expect(service.scan(identity, {})).resolves.toEqual({ status: "no_repositories" });
  });

  it("maps GitHub rate limits and failures to retryable API errors", async () => {
    const limited = createOnboardingRepositoryScanService({
      db: {},
      readSetupFiles: vi.fn(async () => {
        throw new GitHubUserAccessRateLimitError("limited", 30);
      }),
    });
    await expect(limited.scan(identity, {})).rejects.toMatchObject({ status: 429 });

    const failing = createOnboardingRepositoryScanService({
      db: {},
      readSetupFiles: vi.fn(async () => {
        throw new Error("GitHub repository tree read failed with 500.");
      }),
    });
    await expect(failing.scan(identity, {})).rejects.toMatchObject({ status: 503 });
  });
});
