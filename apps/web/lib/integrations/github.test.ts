import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createGitHubIntegrationState,
  isGitHubWorkIntegrationConfigured,
  verifyGitHubIntegrationState,
} from "@/lib/integrations/github";

const githubEnvNames = [
  "GITHUB_INTEGRATION_APP_ID",
  "GITHUB_INTEGRATION_APP_PRIVATE_KEY",
  "GITHUB_INTEGRATION_APP_SLUG",
  "GITHUB_INTEGRATION_APP_CLIENT_ID",
  "GITHUB_INTEGRATION_APP_CLIENT_SECRET",
] as const;
const originalGithubEnv = Object.fromEntries(
  githubEnvNames.map((name) => [name, process.env[name]]),
);

beforeEach(() => {
  process.env.GITHUB_INTEGRATION_APP_CLIENT_SECRET = "test-secret";
});

afterEach(() => {
  for (const name of githubEnvNames) {
    const original = originalGithubEnv[name];
    if (original === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = original;
    }
  }
});

describe("GitHub integration state", () => {
  it("round-trips signed setup state", () => {
    const state = createGitHubIntegrationState({
      workspaceId: "wks_123",
      userId: "usr_123",
      intent: "agent",
      returnTo: "/agents/code-agent",
    });

    expect(verifyGitHubIntegrationState(state)).toEqual(
      expect.objectContaining({
        workspaceId: "wks_123",
        userId: "usr_123",
        intent: "agent",
        returnTo: "/agents/code-agent",
      }),
    );
  });

  it("rejects tampered setup state", () => {
    const state = createGitHubIntegrationState({
      workspaceId: "wks_123",
      userId: "usr_123",
      intent: "settings",
      returnTo: "/settings/integrations",
    });
    const [body, signature] = state.split(".");
    const payload = JSON.parse(Buffer.from(body!, "base64url").toString("utf8"));
    payload.workspaceId = "wks_other";
    const tampered = `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${signature}`;

    expect(() => verifyGitHubIntegrationState(tampered)).toThrow(
      "Invalid GitHub integration state signature.",
    );
  });

  it("sanitizes external return paths", () => {
    const state = createGitHubIntegrationState({
      workspaceId: "wks_123",
      userId: "usr_123",
      intent: "settings",
      returnTo: "https://example.com/phish",
    });

    expect(verifyGitHubIntegrationState(state).returnTo).toBe("/settings/integrations");
  });

  it("reports whether work integration env vars are configured", () => {
    for (const name of githubEnvNames) {
      delete process.env[name];
    }
    expect(isGitHubWorkIntegrationConfigured()).toBe(false);

    process.env.GITHUB_INTEGRATION_APP_ID = "123456";
    process.env.GITHUB_INTEGRATION_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\\n...";
    process.env.GITHUB_INTEGRATION_APP_SLUG = "opencompany-test";
    process.env.GITHUB_INTEGRATION_APP_CLIENT_ID = "Iv1.test";
    process.env.GITHUB_INTEGRATION_APP_CLIENT_SECRET = "test-secret";

    expect(isGitHubWorkIntegrationConfigured()).toBe(true);
  });
});
