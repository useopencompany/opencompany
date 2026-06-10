import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGitHubIntegrationState,
  deleteGitHubWorkInstallation,
  GitHubInstallationNotFoundError,
  isGitHubWorkIntegrationConfigured,
  verifyGitHubIntegrationState,
} from "@/lib/integrations/github";

const githubEnvNames = [
  "GITHUB_INTEGRATION_APP_ID",
  "GITHUB_INTEGRATION_APP_PRIVATE_KEY",
  "GITHUB_INTEGRATION_APP_SLUG",
  "GITHUB_INTEGRATION_APP_CLIENT_ID",
  "GITHUB_INTEGRATION_APP_CLIENT_SECRET",
  "GITHUB_INTEGRATION_STATE_SECRET",
  "INTEGRATION_CREDENTIAL_ENCRYPTION_KEY",
] as const;
const originalGithubEnv = Object.fromEntries(
  githubEnvNames.map((name) => [name, process.env[name]]),
);

beforeEach(() => {
  process.env.GITHUB_INTEGRATION_APP_CLIENT_SECRET = "test-secret";
  process.env.GITHUB_INTEGRATION_STATE_SECRET = "test-state-secret";
});

afterEach(() => {
  vi.unstubAllGlobals();
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

    expect(verifyGitHubIntegrationState(state).returnTo).toBe("/company/settings/integrations");
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
    process.env.GITHUB_INTEGRATION_STATE_SECRET = "test-state-secret";
    expect(isGitHubWorkIntegrationConfigured()).toBe(false);

    process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");

    expect(isGitHubWorkIntegrationConfigured()).toBe(true);
  });
});

describe("GitHub installation management", () => {
  it("deletes installations with the integration app JWT", async () => {
    setIntegrationAppCredentials();
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      deleteGitHubWorkInstallation({ installationId: "12345" }),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/app/installations/12345",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("maps inaccessible installations to a typed not found error", async () => {
    setIntegrationAppCredentials();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })),
    );

    await expect(
      deleteGitHubWorkInstallation({ installationId: "missing" }),
    ).rejects.toBeInstanceOf(GitHubInstallationNotFoundError);
  });
});

function setIntegrationAppCredentials() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.GITHUB_INTEGRATION_APP_ID = "123456";
  process.env.GITHUB_INTEGRATION_APP_PRIVATE_KEY = privateKey
    .export({ type: "pkcs1", format: "pem" })
    .toString();
}
