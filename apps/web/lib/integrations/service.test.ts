import {
  workspaceGitHubIntegrationInstallations,
  workspaceGitHubIntegrationRepositories,
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
      onConflictDoUpdate: vi.fn(),
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

    expect(db.insert).toHaveBeenCalledWith(workspaceGitHubIntegrationInstallations);
    expect(db.insert).toHaveBeenCalledWith(workspaceGitHubIntegrationRepositories);
    expect(db.insert).not.toHaveBeenCalledWith(workspaceRepositories);
  });
});

describe("disconnectGitHubIntegration", () => {
  it("removes work integration rows without touching managed workspace repositories", async () => {
    await disconnectGitHubIntegration({ workspaceId: "wks_123" });

    expect(db.delete).toHaveBeenCalledWith(workspaceGitHubIntegrationRepositories);
    expect(db.delete).toHaveBeenCalledWith(workspaceGitHubIntegrationInstallations);
    expect(db.delete).not.toHaveBeenCalledWith(workspaceRepositories);
  });
});
