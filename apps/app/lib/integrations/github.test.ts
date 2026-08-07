import { generateKeyPairSync } from "node:crypto";
import {
  createGitHubIntegrationState,
  GitHubApiError,
  listConnectedGitHubInstallations,
  searchGitHubIssues,
  syncGitHubIntegrationRepositories,
  verifyGitHubIntegrationState,
} from "@opencompany/core/integrations/github";
import { integrationResources, integrations } from "@opencompany/db/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

const db = vi.hoisted(() => ({
  insert: vi.fn(),
  select: vi.fn(),
  update: vi.fn(),
  selectRows: [] as unknown[],
  insertValues: [] as Array<{
    table: unknown;
    values: Record<string, unknown> | Record<string, unknown>[];
  }>,
  conflictUpdates: [] as Array<{ table: unknown; options: { set?: Record<string, unknown> } }>,
  updateValues: [] as Array<{ table: unknown; values: Record<string, unknown> }>,
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: () => db,
}));

beforeEach(() => {
  vi.clearAllMocks();
  db.insertValues.length = 0;
  db.selectRows.length = 0;
  db.conflictUpdates.length = 0;
  db.updateValues.length = 0;
  db.insert.mockImplementation((table) => ({
    values: vi.fn((values) => {
      db.insertValues.push({ table, values });
      return {
        onConflictDoUpdate: vi.fn((options) => {
          db.conflictUpdates.push({ table, options });
          return {
            returning: vi.fn(async () => [{ id: "gint_123", userWorkosId: "user_123" }]),
          };
        }),
      };
    }),
  }));
  db.select.mockImplementation(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        orderBy: vi.fn(async () => db.selectRows),
      })),
    })),
  }));
  db.update.mockImplementation((table) => ({
    set: vi.fn((values) => {
      db.updateValues.push({ table, values });
      return {
        where: vi.fn(),
      };
    }),
  }));
  vi.stubEnv("GITHUB_INTEGRATION_STATE_SECRET", "test-state-secret");
  vi.stubEnv("GITHUB_INTEGRATION_APP_ID", "12345");
  vi.stubEnv("GITHUB_INTEGRATION_APP_PRIVATE_KEY", TEST_PRIVATE_KEY);
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.com");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("GitHub integration", () => {
  it("round-trips signed state for a user", () => {
    const state = createGitHubIntegrationState({
      userWorkosId: "user_123",
      workspaceId: "gws_123",
      returnTo: "/settings",
    });

    expect(verifyGitHubIntegrationState(state)).toMatchObject({
      userWorkosId: "user_123",
      workspaceId: "gws_123",
      returnTo: "/settings",
    });
  });

  it("returns every connected installation and excludes unusable connection state", async () => {
    db.selectRows.push(
      { installationId: "connected-1", accountName: "opencompany", status: "connected" },
      { installationId: "connected-2", accountName: "acme", status: "connected" },
      { installationId: "expired", accountName: "old", status: "needs_reauth" },
      { installationId: null, accountName: "broken", status: "connected" },
    );

    await expect(listConnectedGitHubInstallations("workspace_1")).resolves.toEqual([
      { installationId: "connected-1", accountName: "opencompany" },
      { installationId: "connected-2", accountName: "acme" },
    ]);
  });

  it("mints an installation token and searches issues with the caller's abort signal", async () => {
    const controller = new AbortController();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: "installation-token" }), { status: 201 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ total_count: 0, items: [] }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      searchGitHubIssues({
        installationId: "12345",
        query: "repo:opencompany/goat state:open",
        limit: 7,
        signal: controller.signal,
      }),
    ).resolves.toEqual({ total_count: 0, items: [] });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.github.com/app/installations/12345/access_tokens",
      expect.objectContaining({
        method: "POST",
        signal: controller.signal,
        headers: expect.objectContaining({ Authorization: expect.stringMatching(/^Bearer /) }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.github.com/search/issues?q=repo%3Aopencompany%2Fgoat+state%3Aopen&per_page=7",
      expect.objectContaining({
        method: "GET",
        signal: controller.signal,
        headers: expect.objectContaining({ Authorization: "Bearer installation-token" }),
      }),
    );
  });

  it("returns a typed API error without exposing an untrusted provider error body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("sensitive provider payload", { status: 404 })),
    );

    const error = await searchGitHubIssues({
      installationId: "missing",
      query: "is:issue",
      limit: 10,
      signal: new AbortController().signal,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error).toMatchObject({ status: 404, operation: "installation_token" });
    expect((error as Error).message).not.toContain("sensitive provider payload");
  });

  it("syncs repositories into integration resources", async () => {
    await syncGitHubIntegrationRepositories({
      userWorkosId: "user_123",
      workspaceId: "gws_123",
      installationId: "12345",
      accountLogin: "octo",
      accountType: "User",
      repositories: [
        {
          githubRepoId: "1",
          fullName: "octo/private-repo",
          defaultBranch: "main",
          private: true,
        },
      ],
    });

    expect(db.insert).toHaveBeenCalledWith(integrations);
    expect(db.insert).toHaveBeenCalledWith(integrationResources);
    expect(db.insertValues).toEqual(
      expect.arrayContaining([
        {
          table: integrations,
          values: expect.objectContaining({
            userWorkosId: "user_123",
            provider: "github",
            externalId: "12345",
            accountName: "octo",
            accountType: "User",
            status: "sync_failed",
          }),
        },
        {
          table: integrationResources,
          values: [
            expect.objectContaining({
              userWorkosId: "user_123",
              integrationId: "gint_123",
              provider: "github",
              resourceType: "repository",
              externalId: "1",
              name: "octo/private-repo",
              status: "available",
              metadata: {
                defaultBranch: "main",
                private: true,
              },
            }),
          ],
        },
      ]),
    );
    expect(db.updateValues).toEqual(
      expect.arrayContaining([
        {
          table: integrations,
          values: expect.objectContaining({
            status: "connected",
            statusReason: null,
          }),
        },
      ]),
    );
  });
});
