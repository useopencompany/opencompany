import {
  workspaceGitHubIntegrationInstallations,
  workspaceGitHubIntegrationRepositories,
  workspaceRepositories,
} from "@opencompany/db/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { syncGitHubIntegrationRepositories } from "@/lib/integrations/service";

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
