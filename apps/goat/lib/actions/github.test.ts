import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class ApiError extends Error {
    readonly status: number;
    readonly operation: "installation_token" | "request";

    constructor(status: number, operation: "installation_token" | "request" = "request") {
      super(`GitHub API request failed with ${status}.`);
      this.status = status;
      this.operation = operation;
    }
  }

  return {
    ApiError,
    connections: vi.fn(),
    searchIssues: vi.fn(),
  };
});

vi.mock("@/lib/integrations/github", () => ({
  GoatGitHubApiError: mocks.ApiError,
  listConnectedGoatGitHubInstallations: mocks.connections,
  searchGoatGitHubIssues: mocks.searchIssues,
}));

import { resolveGitHubActions } from "@/lib/actions/github";
import { GoatActionAuthError, type GoatActionExecuteContext } from "@/lib/actions/types";

const CONTEXT: GoatActionExecuteContext = {
  userWorkosId: "user_1",
  signal: new AbortController().signal,
  currentDate: new Date("2026-07-22T00:00:00.000Z"),
  userTimezone: "UTC",
};

function connection(accountName = "opencompany", installationId = "installation_1") {
  return {
    installationId,
    accountName,
  };
}

function findSearch(catalog: Awaited<ReturnType<typeof resolveGitHubActions>>) {
  const action = catalog?.actions.find((entry) => entry.id === "github.search_issues");
  if (!action) throw new Error("missing github.search_issues");
  return action;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connections.mockResolvedValue([connection()]);
});

describe("resolveGitHubActions", () => {
  it("is absent without a currently connected installation", async () => {
    mocks.connections.mockResolvedValue([]);
    expect(await resolveGitHubActions("workspace_1")).toBeNull();
    expect(mocks.connections).toHaveBeenCalledWith("workspace_1");
  });

  it("exposes one strict read-only search descriptor", async () => {
    const catalog = await resolveGitHubActions("workspace_1");
    expect(catalog).toMatchObject({
      id: "github",
      label: "GitHub (opencompany)",
      actions: [
        {
          id: "github.search_issues",
          provider: "github",
          params: {
            type: "object",
            additionalProperties: false,
            required: ["query"],
          },
        },
      ],
    });
    expect(catalog?.actions[0]?.params).toMatchObject({
      properties: {
        query: { type: "string", maxLength: 512 },
        limit: { type: "number", minimum: 1, maximum: 15 },
      },
    });
    expect(catalog?.actions.every((action) => !/create|update|delete|write/.test(action.id))).toBe(
      true,
    );
  });
});

describe("github.search_issues", () => {
  it("executes against the installation and shapes untrusted issue and pull-request fields", async () => {
    mocks.searchIssues.mockResolvedValue({
      total_count: 2,
      incomplete_results: false,
      items: [
        {
          repository_url: "https://api.github.com/repos/opencompany/goat",
          number: 42,
          title: "Fix account switching",
          state: "open",
          draft: true,
          pull_request: { url: "https://api.github.com/pulls/42" },
          user: { login: "octocat" },
          assignees: [{ login: "hubot" }],
          labels: [{ name: "bug" }],
          updated_at: "2026-07-21T12:00:00Z",
          body: "The active account can become stale.",
          html_url: "https://github.com/opencompany/goat/pull/42",
          ignored_secret_field: "do not return",
        },
        { number: "invalid", title: "Skipped invalid record" },
      ],
    });

    const search = findSearch(await resolveGitHubActions("workspace_1"));
    const result = await search.execute({ query: "state:open is:pr", limit: 5 }, CONTEXT);

    expect(mocks.searchIssues).toHaveBeenCalledWith({
      installationId: "installation_1",
      query: "state:open is:pr",
      limit: 5,
      signal: CONTEXT.signal,
    });
    expect(result).toEqual({
      account: "opencompany",
      query: "state:open is:pr",
      totalCount: 2,
      incompleteResults: false,
      items: [
        {
          repository: "opencompany/goat",
          number: 42,
          type: "pull_request",
          title: "Fix account switching",
          state: "open",
          draft: true,
          author: "octocat",
          assignees: ["hubot"],
          labels: ["bug"],
          updatedAt: "2026-07-21T12:00:00Z",
          bodyPreview: "The active account can become stale.",
          url: "https://github.com/opencompany/goat/pull/42",
        },
      ],
    });
  });

  it("validates required, bounded, and unexpected parameters before the provider call", async () => {
    const search = findSearch(await resolveGitHubActions("workspace_1"));

    await expect(search.execute({}, CONTEXT)).rejects.toThrow('"query" is required');
    await expect(search.execute({ query: "bug", limit: 0 }, CONTEXT)).rejects.toThrow(
      '"limit" must be an integer',
    );
    await expect(search.execute({ query: "bug", limit: 1.5 }, CONTEXT)).rejects.toThrow(
      '"limit" must be an integer',
    );
    await expect(search.execute({ query: "x".repeat(513) }, CONTEXT)).rejects.toThrow(
      '"query" must be at most 512',
    );
    await expect(search.execute({ query: "bug", mutate: true }, CONTEXT)).rejects.toThrow(
      "Unexpected parameter",
    );
    expect(mocks.searchIssues).not.toHaveBeenCalled();
  });

  it("maps missing or expired installation authentication to a reconnect error", async () => {
    const search = findSearch(await resolveGitHubActions("workspace_1"));

    for (const status of [401, 404]) {
      mocks.searchIssues.mockRejectedValueOnce(new mocks.ApiError(status));
      await expect(search.execute({ query: "is:issue" }, CONTEXT)).rejects.toMatchObject({
        name: "GoatActionAuthError",
        code: "auth_expired",
        provider: "github",
        message: expect.stringContaining("Settings → Integrations"),
      } satisfies Partial<GoatActionAuthError>);
    }

    mocks.searchIssues.mockRejectedValueOnce(new mocks.ApiError(403, "installation_token"));
    await expect(search.execute({ query: "is:issue" }, CONTEXT)).rejects.toBeInstanceOf(
      GoatActionAuthError,
    );
  });

  it("surfaces provider failures and malformed responses", async () => {
    const search = findSearch(await resolveGitHubActions("workspace_1"));

    mocks.searchIssues.mockRejectedValueOnce(new mocks.ApiError(500));
    await expect(search.execute({ query: "is:issue" }, CONTEXT)).rejects.toThrow(
      "GitHub API request failed with 500",
    );

    mocks.searchIssues.mockRejectedValueOnce(new mocks.ApiError(403));
    await expect(search.execute({ query: "is:issue" }, CONTEXT)).rejects.toThrow(
      "GitHub API request failed with 403",
    );

    mocks.searchIssues.mockResolvedValueOnce({ items: "not-an-array" });
    await expect(search.execute({ query: "is:issue" }, CONTEXT)).rejects.toThrow(
      "invalid search response",
    );
  });

  it("requires an explicit account when multiple installations are connected", async () => {
    mocks.connections.mockResolvedValue([
      connection("opencompany", "installation_1"),
      connection("acme", "installation_2"),
    ]);
    mocks.searchIssues.mockResolvedValue({ total_count: 0, items: [] });

    const catalog = await resolveGitHubActions("workspace_1");
    const search = findSearch(catalog);
    expect(catalog?.actions[0]?.params).toMatchObject({
      required: ["query", "account"],
      properties: { account: { type: "string" } },
    });
    await expect(search.execute({ query: "is:issue" }, CONTEXT)).rejects.toThrow(
      "Multiple GitHub accounts",
    );
    await expect(
      search.execute({ query: "is:issue", account: "missing" }, CONTEXT),
    ).rejects.toThrow("No connected GitHub account");

    await search.execute({ query: "is:issue", account: "acme" }, CONTEXT);
    expect(mocks.searchIssues).toHaveBeenLastCalledWith(
      expect.objectContaining({ installationId: "installation_2" }),
    );
  });

  it("uses installation ids to disambiguate duplicate account labels", async () => {
    mocks.connections.mockResolvedValue([
      connection("opencompany", "installation_1"),
      connection("opencompany", "installation_2"),
    ]);
    mocks.searchIssues.mockResolvedValue({ total_count: 0, items: [] });

    const catalog = await resolveGitHubActions("workspace_1");
    expect(catalog?.actions[0]?.params).toMatchObject({
      properties: {
        account: {
          description: expect.stringContaining('"installation_1", "installation_2"'),
        },
      },
    });

    const search = findSearch(catalog);
    await search.execute({ query: "is:issue", account: "installation_2" }, CONTEXT);
    expect(mocks.searchIssues).toHaveBeenLastCalledWith(
      expect.objectContaining({ installationId: "installation_2" }),
    );
  });

  it("caps result counts and truncates large external fields", async () => {
    const item = (number: number) => ({
      repository_url: "https://evil.example/repos/private/repo",
      number,
      title: "t".repeat(400),
      state: "open",
      user: { login: "octocat" },
      assignees: Array.from({ length: 8 }, (_, index) => ({ login: `user-${index}` })),
      labels: Array.from({ length: 14 }, (_, index) => ({ name: `label-${index}` })),
      body: "b".repeat(800),
      html_url: "javascript:alert(1)",
    });
    mocks.searchIssues.mockResolvedValue({
      total_count: 30,
      items: Array.from({ length: 30 }, (_, index) => item(index + 1)),
    });

    const search = findSearch(await resolveGitHubActions("workspace_1"));
    const result = (await search.execute({ query: "is:issue", limit: 15 }, CONTEXT)) as {
      items: Array<{
        repository?: string;
        title?: string;
        bodyPreview?: string;
        assignees: string[];
        labels: string[];
        url?: string;
      }>;
    };

    expect(result.items).toHaveLength(15);
    expect(result.items[0]?.title).toHaveLength(301);
    expect(result.items[0]?.bodyPreview).toHaveLength(501);
    expect(result.items[0]?.assignees).toHaveLength(5);
    expect(result.items[0]?.labels).toHaveLength(10);
    expect(result.items[0]?.repository).toBeUndefined();
    expect(result.items[0]?.url).toBeUndefined();
  });
});
