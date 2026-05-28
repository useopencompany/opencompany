import {
  workspaceIntegrationCredentials,
  workspaceIntegrationResources,
  workspaceIntegrations,
  workspaceRepositories,
} from "@opencompany/db/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  disconnectGitHubIntegration,
  syncGitHubIntegrationRepositories,
} from "@/lib/integrations/service";

const db = vi.hoisted(() => ({
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  transaction: vi.fn(),
  insertValues: [] as Array<{
    table: unknown;
    values: Record<string, unknown> | Record<string, unknown>[];
  }>,
  conflictUpdates: [] as Array<{ table: unknown; options: { set?: Record<string, unknown> } }>,
  updateValues: [] as Array<{ table: unknown; values: Record<string, unknown> }>,
  deleteTargets: [] as unknown[],
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: () => db,
}));

beforeEach(() => {
  vi.clearAllMocks();
  db.insertValues.length = 0;
  db.conflictUpdates.length = 0;
  db.updateValues.length = 0;
  db.deleteTargets.length = 0;
  db.transaction.mockImplementation(async (callback) => callback(db));
  db.insert.mockImplementation((table) => ({
    values: vi.fn((values) => {
      db.insertValues.push({ table, values });
      return {
        onConflictDoUpdate: vi.fn((options) => {
          db.conflictUpdates.push({ table, options });
          return {
            returning: vi.fn(async () => [{ id: "wint_123" }]),
          };
        }),
      };
    }),
  }));
  db.delete.mockImplementation((table) => {
    db.deleteTargets.push(table);
    return {
      where: vi.fn(),
    };
  });
  db.update.mockImplementation((table) => ({
    set: vi.fn((values) => {
      db.updateValues.push({ table, values });
      return {
        where: vi.fn(),
      };
    }),
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("syncGitHubIntegrationRepositories", () => {
  it("writes work integration tables without touching managed workspace repositories", async () => {
    await syncGitHubIntegrationRepositories({
      workspaceId: "wks_123",
      installationId: "12345",
      accountLogin: "opencompany",
      accountType: "Organization",
      connectedByUserId: "usr_123",
      repositories: [
        {
          githubRepoId: "1",
          fullName: "opencompany/web",
          defaultBranch: "main",
          private: true,
        },
      ],
    });

    expect(db.insert).toHaveBeenCalledWith(workspaceIntegrations);
    expect(db.insert).toHaveBeenCalledWith(workspaceIntegrationResources);
    expect(db.insert).not.toHaveBeenCalledWith(workspaceRepositories);
    expect(db.insertValues).toEqual(
      expect.arrayContaining([
        {
          table: workspaceIntegrations,
          values: expect.objectContaining({
            workspaceId: "wks_123",
            provider: "github",
            externalId: "12345",
            connectionLabel: "opencompany",
            accountName: "opencompany",
            accountEmail: null,
            accountType: "Organization",
            connectedByUserId: "usr_123",
            status: "connected",
            statusReason: null,
            lastSyncedAt: expect.any(Date),
          }),
        },
      ]),
    );
    expect(db.insertValues).toEqual(
      expect.arrayContaining([
        {
          table: workspaceIntegrationResources,
          values: [
            expect.objectContaining({
              workspaceId: "wks_123",
              integrationId: "wint_123",
              provider: "github",
              resourceType: "repository",
              externalId: "1",
              name: "opencompany/web",
              displayName: "opencompany/web",
              status: "available",
              statusReason: null,
              lastSyncedAt: expect.any(Date),
            }),
          ],
        },
      ]),
    );
    expect(db.conflictUpdates).toEqual(
      expect.arrayContaining([
        {
          table: workspaceIntegrations,
          options: expect.objectContaining({
            set: expect.objectContaining({
              connectionLabel: "opencompany",
              accountName: "opencompany",
              accountType: "Organization",
              connectedByUserId: "usr_123",
              status: "connected",
              statusReason: null,
              lastSyncedAt: expect.any(Date),
            }),
          }),
        },
        {
          table: workspaceIntegrationResources,
          options: expect.objectContaining({
            target: [
              workspaceIntegrationResources.integrationId,
              workspaceIntegrationResources.resourceType,
              workspaceIntegrationResources.externalId,
            ],
            set: expect.objectContaining({
              integrationId: "wint_123",
              status: "available",
              statusReason: null,
              lastSyncedAt: expect.any(Date),
            }),
          }),
        },
      ]),
    );
  });

  it("marks stale repositories permission_lost during sync", async () => {
    await syncGitHubIntegrationRepositories({
      workspaceId: "wks_123",
      installationId: "12345",
      accountLogin: "opencompany",
      accountType: "Organization",
      repositories: [],
    });

    expect(db.update).toHaveBeenCalledWith(workspaceIntegrationResources);
    expect(db.updateValues).toEqual(
      expect.arrayContaining([
        {
          table: workspaceIntegrationResources,
          values: expect.objectContaining({
            status: "permission_lost",
            statusReason: "Repository is no longer visible to the GitHub installation.",
          }),
        },
      ]),
    );
    expect(db.deleteTargets).not.toContain(workspaceIntegrationResources);
    expect(db.deleteTargets).not.toContain(workspaceIntegrations);
  });

  it("persists the GitHub user OAuth token without using unsupported HTTP transactions", async () => {
    vi.stubEnv("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 1).toString("base64"));

    await syncGitHubIntegrationRepositories({
      workspaceId: "wks_123",
      installationId: "12345",
      accountLogin: "opencompany",
      accountType: "Organization",
      repositories: [],
      userOAuthToken: "ghu_secret",
    });

    expect(db.transaction).not.toHaveBeenCalled();
    expect(db.insertValues).toEqual(
      expect.arrayContaining([
        {
          table: workspaceIntegrationCredentials,
          values: expect.objectContaining({
            workspaceId: "wks_123",
            integrationId: "wint_123",
            provider: "github",
            kind: "oauth_token",
          }),
        },
      ]),
    );
    const credentialInsert = db.insertValues.find(
      (insert) => insert.table === workspaceIntegrationCredentials,
    );
    expect(JSON.stringify(credentialInsert?.values)).not.toContain("ghu_secret");
  });
});

describe("disconnectGitHubIntegration", () => {
  it("removes work integration rows without touching managed workspace repositories", async () => {
    await disconnectGitHubIntegration({ workspaceId: "wks_123", integrationId: "wint_123" });

    expect(db.delete).toHaveBeenCalledWith(workspaceIntegrations);
    expect(db.delete).not.toHaveBeenCalledWith(workspaceRepositories);
  });
});
