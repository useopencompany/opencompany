import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getGitHubWorkInstallationToken, gitHubPermissionErrorHint } from "./github";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("gitHubPermissionErrorHint", () => {
  it("turns a 'resource not accessible by integration' error into an actionable hint", () => {
    const hint = gitHubPermissionErrorHint(
      "HTTP 403: Resource not accessible by integration (https://api.github.com/repos/o/r/issues)",
    );
    expect(hint).toMatch(/Issues: Read/);
    expect(hint).toMatch(/re-approve/);
  });

  it("returns null for unrelated errors so normal failures pass through untouched", () => {
    expect(gitHubPermissionErrorHint("HTTP 404: Not Found")).toBeNull();
    expect(gitHubPermissionErrorHint("")).toBeNull();
  });
});

describe("GitHub installation tokens", () => {
  it("explains work repository installation 404s as an app credential mismatch", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    vi.stubEnv("GITHUB_INTEGRATION_APP_ID", "12345");
    vi.stubEnv(
      "GITHUB_INTEGRATION_APP_PRIVATE_KEY",
      privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      }),
    );

    await expect(getGitHubWorkInstallationToken({ installationId: "135242330" })).rejects.toThrow(
      "GitHub work repository integration installation 135242330 is not accessible to the configured GitHub App.",
    );
  });

  it("scopes work repository tokens to the requested repository", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    vi.stubEnv("GITHUB_INTEGRATION_APP_ID", "12345");
    vi.stubEnv(
      "GITHUB_INTEGRATION_APP_PRIVATE_KEY",
      privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
    );
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({ token: "ghs_test", expires_at: "2099-01-01T00:00:00Z" }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      getGitHubWorkInstallationToken({
        installationId: "135242330",
        repositoryFullName: "opencompany/app",
      }),
    ).resolves.toBe("ghs_test");

    const requestInit = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>)[0]?.[1];
    expect(JSON.parse(String(requestInit?.body))).toEqual({
      repositories: ["app"],
    });
  });

  it("scopes work repository tokens to all requested repositories, sorted and deduped", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    vi.stubEnv("GITHUB_INTEGRATION_APP_ID", "12345");
    vi.stubEnv(
      "GITHUB_INTEGRATION_APP_PRIVATE_KEY",
      privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
    );
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({ token: "ghs_multi", expires_at: "2099-01-01T00:00:00Z" }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      getGitHubWorkInstallationToken({
        installationId: "135242330",
        repositoryFullNames: ["opencompany/web", "opencompany/app", "opencompany/web"],
      }),
    ).resolves.toBe("ghs_multi");

    const requestInit = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>)[0]?.[1];
    expect(JSON.parse(String(requestInit?.body))).toEqual({
      repositories: ["app", "web"],
    });
  });
});
