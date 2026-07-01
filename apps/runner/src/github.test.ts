import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getGitHubWorkInstallationToken, gitHubPermissionErrorHint } from "./github";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("gitHubPermissionErrorHint", () => {
  const permissionError =
    "HTTP 403: Resource not accessible by integration (https://api.github.com/repos/o/r/issues)";

  it("turns a 'resource not accessible by integration' error into an actionable hint", () => {
    const hint = gitHubPermissionErrorHint(permissionError, {
      path: "/repos/o/r/issues",
      method: "POST",
    });
    expect(hint).toMatch(/Issues: Read & write/);
    expect(hint).toMatch(/re-approve/);
  });

  it.each([
    ["Actions runs", { path: "/repos/o/r/actions/runs", method: "GET" }, ["Actions: Read"]],
    [
      "Actions workflows",
      { path: "/repos/o/r/actions/workflows", method: "GET" },
      ["Actions: Read"],
    ],
    ["Statuses", { path: "/repos/o/r/commits/abc123/status", method: "GET" }, ["Statuses: Read"]],
    [
      "Checks from check suites",
      { path: "/repos/o/r/commits/abc123/check-suites", method: "GET" },
      ["Checks: Read"],
    ],
    [
      "Checks from check runs",
      { path: "/repos/o/r/check-runs/123", method: "GET" },
      ["Checks: Read"],
    ],
    [
      "Checks from commit check runs",
      { path: "/repos/o/r/commits/abc123/check-runs", method: "GET" },
      ["Checks: Read"],
    ],
    ["Check suite by id", { path: "/repos/o/r/check-suites/123", method: "GET" }, ["Checks: Read"]],
    [
      "Check runs in check suite",
      { path: "/repos/o/r/check-suites/123/check-runs", method: "GET" },
      ["Checks: Read"],
    ],
    [
      "Legacy statuses by ref",
      { path: "/repos/o/r/statuses/abc123", method: "GET" },
      ["Statuses: Read"],
    ],
    ["Check run create", { path: "/repos/o/r/check-runs", method: "POST" }, ["Checks: Write"]],
    ["Check run update", { path: "/repos/o/r/check-runs/123", method: "PATCH" }, ["Checks: Write"]],
    [
      "Actions rerun workflow run",
      { path: "/repos/o/r/actions/runs/123/rerun", method: "POST" },
      ["Actions: Write"],
    ],
    [
      "Actions cancel workflow run",
      { path: "/repos/o/r/actions/runs/123/cancel", method: "POST" },
      ["Actions: Write"],
    ],
    ["Issues read", { path: "/repos/o/r/issues", method: "GET" }, ["Issues: Read"]],
    ["Issues write", { path: "/repos/o/r/issues", method: "POST" }, ["Issues: Read & write"]],
    ["Pull requests read", { path: "/repos/o/r/pulls", method: "GET" }, ["Pull requests: Read"]],
    [
      "Pull requests write",
      { path: "/repos/o/r/pulls", method: "POST" },
      ["Pull requests: Read & write"],
    ],
    [
      "Pull request comments write",
      { path: "/repos/o/r/pulls/123/comments", method: "POST" },
      ["Pull requests: Read & write"],
    ],
    [
      "Pull request merge",
      { path: "/repos/o/r/pulls/123/merge", method: "PUT" },
      ["Contents: Read & write"],
    ],
    [
      "Branch protection read",
      { path: "/repos/o/r/branches/main/protection", method: "GET" },
      ["Administration: Read"],
    ],
    [
      "Branch protection write",
      { path: "/repos/o/r/branches/main/protection", method: "PUT" },
      ["Administration: Write"],
    ],
  ])("names the required repository permission for %s", (_name, operation, permissions) => {
    const hint = gitHubPermissionErrorHint(permissionError, operation);
    for (const permission of permissions) {
      expect(hint).toContain(permission);
    }
  });

  it("uses the least-privilege Contents permission for the REST merge endpoint", () => {
    const hint = gitHubPermissionErrorHint(permissionError, {
      path: "/repos/o/r/pulls/123/merge",
      method: "PUT",
    });
    expect(hint).toContain("Contents: Read & write");
    expect(hint).not.toContain("Administration: Write");
    expect(hint).not.toContain("Pull requests: Read & write");
  });

  it.each([
    ["gh run list", { ghArgv: ["run", "list"] }, ["Actions: Read"]],
    ["gh run rerun", { ghArgv: ["run", "rerun", "123"] }, ["Actions: Write"]],
    ["gh run cancel", { ghArgv: ["run", "cancel", "123"] }, ["Actions: Write"]],
    ["gh pr checks", { ghArgv: ["pr", "checks", "12"] }, ["Checks: Read", "Statuses: Read"]],
    [
      "gh pr merge",
      { ghArgv: ["pr", "merge", "12", "--squash"] },
      ["Administration: Write", "Pull requests: Read & write", "Contents: Read & write"],
    ],
    ["gh pr create", { ghArgv: ["pr", "create", "--fill"] }, ["Pull requests: Read & write"]],
    ["gh pr comment", { ghArgv: ["pr", "comment", "12"] }, ["Pull requests: Read & write"]],
    [
      "gh issue create",
      { ghArgv: ["issue", "create", "--title", "Bug"] },
      ["Issues: Read & write"],
    ],
    [
      "gh api endpoint",
      { ghArgv: ["api", "/repos/o/r/commits/abc123/check-suites"] },
      ["Checks: Read"],
    ],
    [
      "gh api endpoint with trailing method",
      { ghArgv: ["api", "/repos/o/r/issues", "--method", "POST"] },
      ["Issues: Read & write"],
    ],
    [
      "gh api endpoint with request body",
      { ghArgv: ["api", "/repos/o/r/issues", "-f", "title=x"] },
      ["Issues: Read & write"],
    ],
    [
      "gh api endpoint with attached short body field",
      { ghArgv: ["api", "/repos/o/r/issues", "-ftitle=x"] },
      ["Issues: Read & write"],
    ],
    [
      "gh api endpoint with attached long body field",
      { ghArgv: ["api", "/repos/o/r/issues", "--field=title=x"] },
      ["Issues: Read & write"],
    ],
    [
      "gh api endpoint with attached raw body field",
      { ghArgv: ["api", "/repos/o/r/issues", "--raw-field=title=x"] },
      ["Issues: Read & write"],
    ],
  ])("names the required repository permission for %s", (_name, operation, permissions) => {
    const hint = gitHubPermissionErrorHint(permissionError, operation);
    for (const permission of permissions) {
      expect(hint).toContain(permission);
    }
  });

  it("uses a generic repository permission hint for unknown operations", () => {
    const hint = gitHubPermissionErrorHint(permissionError, {
      path: "/repos/o/r/deployments",
      method: "POST",
    });
    expect(hint).toContain("one or more repository permissions");
    expect(hint).not.toContain("Issues: Read");
  });

  it("uses a generic repository permission hint for unknown gh run subcommands", () => {
    const hint = gitHubPermissionErrorHint(permissionError, {
      ghArgv: ["run", "unknown", "123"],
    });
    expect(hint).toContain("one or more repository permissions");
    expect(hint).not.toContain("Actions: Read");
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
