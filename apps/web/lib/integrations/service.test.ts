import {
  workspaceIntegrationResources,
  workspaceIntegrations,
  workspaceRepositories,
} from "@opencompany/db/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  disconnectGitHubIntegration,
  syncGitHubIntegrationRepositories,
} from "@/lib/integrations/service";

const db = vi.hoisted(() => ({
  insert: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: () => db,
}));

beforeEach(() => {
  vi.clearAllMocks();
  db.insert.mockImplementation(() => ({
    values: vi.fn(() => ({
      onConflictDoUpdate: vi.fn(() => ({
        returning: vi.fn(async () => [{ id: "wint_123" }]),
      })),
    })),
  }));
  db.delete.mockImplementation(() => ({
    where: vi.fn(),
  }));
});

describe("syncGitHubIntegrationRepositories", () => {
  it("writes work integration tables without touching managed workspace repositories", async () => {
    await syncGitHubIntegrationRepositories({
      workspaceId: "wks_123",
      installationId: "12345",
      accountLogin: "opencompany",
      accountType: "Organization",
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
  });
});

describe("disconnectGitHubIntegration", () => {
  it("removes work integration rows without touching managed workspace repositories", async () => {
    await disconnectGitHubIntegration({ workspaceId: "wks_123" });

    expect(db.delete).toHaveBeenCalledWith(workspaceIntegrations);
    expect(db.delete).not.toHaveBeenCalledWith(workspaceRepositories);
  });
});
