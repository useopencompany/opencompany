import { goatIntegrationResources, goatIntegrations } from "@opencompany/db/goat-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGoatGitHubIntegrationState,
  syncGoatGitHubIntegrationRepositories,
  verifyGoatGitHubIntegrationState,
} from "./github";

const db = vi.hoisted(() => ({
  insert: vi.fn(),
  update: vi.fn(),
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
  db.update.mockImplementation((table) => ({
    set: vi.fn((values) => {
      db.updateValues.push({ table, values });
      return {
        where: vi.fn(),
      };
    }),
  }));
  vi.stubEnv("GITHUB_INTEGRATION_STATE_SECRET", "test-state-secret");
  vi.stubEnv("GOAT_NEXT_PUBLIC_APP_URL", "https://goat.example.com");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Goat GitHub integration", () => {
  it("round-trips signed state for a Goat user", () => {
    const state = createGoatGitHubIntegrationState({
      userWorkosId: "user_123",
      workspaceId: "gws_123",
      returnTo: "/settings",
    });

    expect(verifyGoatGitHubIntegrationState(state)).toMatchObject({
      userWorkosId: "user_123",
      workspaceId: "gws_123",
      returnTo: "/settings",
    });
  });

  it("syncs repositories into Goat integration resources", async () => {
    await syncGoatGitHubIntegrationRepositories({
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

    expect(db.insert).toHaveBeenCalledWith(goatIntegrations);
    expect(db.insert).toHaveBeenCalledWith(goatIntegrationResources);
    expect(db.insertValues).toEqual(
      expect.arrayContaining([
        {
          table: goatIntegrations,
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
          table: goatIntegrationResources,
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
          table: goatIntegrations,
          values: expect.objectContaining({
            status: "connected",
            statusReason: null,
          }),
        },
      ]),
    );
  });
});
