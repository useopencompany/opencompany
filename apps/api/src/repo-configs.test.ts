import type { Actor } from "@opencompany/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRepoConfigService } from "./repo-configs";

const mocks = vi.hoisted(() => ({
  deleteConfig: vi.fn(),
  listConfigs: vi.fn(),
  listRepositories: vi.fn(),
  upsertConfig: vi.fn(),
}));

vi.mock("@opencompany/db/repo-configs", async (importOriginal) => {
  const original = await importOriginal<typeof import("@opencompany/db/repo-configs")>();
  return {
    ...original,
    deleteRepoConfig: mocks.deleteConfig,
    listRepoConfigs: mocks.listConfigs,
    listWorkspaceRepositories: mocks.listRepositories,
    upsertRepoConfig: mocks.upsertConfig,
  };
});

function actorWithRole(role: string): Actor {
  return {
    userId: "user_1",
    workspaceId: "gws_1",
    role,
    permissions: [],
    authenticationMethod: "session",
  };
}

const admin = actorWithRole("admin");

function configView() {
  return {
    repositoryExternalId: "123",
    repositoryFullName: "opencompany/Renamed-App",
    envKeys: ["API_TOKEN"],
    setupInstructions: "",
    updatedAt: new Date("2026-08-12T10:00:00.000Z"),
  };
}

describe("repository config service", () => {
  const db = { name: "db" };
  const service = createRepoConfigService({ db });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listRepositories.mockResolvedValue([
      {
        repositoryExternalId: "123",
        repositoryFullName: "opencompany/Renamed-App",
        private: true,
      },
    ]);
    mocks.listConfigs.mockResolvedValue([configView()]);
    mocks.upsertConfig.mockResolvedValue(configView());
    mocks.deleteConfig.mockResolvedValue(true);
  });

  it("lists workspace repositories and configs for any member", async () => {
    await expect(service.list(actorWithRole("member"))).resolves.toEqual({
      repositories: [
        {
          repositoryExternalId: "123",
          repositoryFullName: "opencompany/Renamed-App",
          private: true,
        },
      ],
      configs: [configView()],
    });
    expect(mocks.listRepositories).toHaveBeenCalledWith({ db, workspaceId: "gws_1" });
    expect(mocks.listConfigs).toHaveBeenCalledWith({ db, workspaceId: "gws_1" });
  });

  it("rejects repository mutations from non-admin workspace members", async () => {
    await expect(
      service.setEnv(actorWithRole("member"), "123", "API_TOKEN=secret-value"),
    ).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
      message: "Only workspace admins can configure repository environments.",
    });
    expect(mocks.upsertConfig).not.toHaveBeenCalled();
  });

  it("saves the env with the catalog full name and returns only key names", async () => {
    const result = await service.setEnv(admin, "123", "API_TOKEN=secret-value");

    expect(mocks.upsertConfig).toHaveBeenCalledWith({
      db,
      workspaceId: "gws_1",
      repositoryExternalId: "123",
      repositoryFullName: "opencompany/Renamed-App",
      createdByWorkosId: "user_1",
      env: { content: "API_TOKEN=secret-value" },
    });
    expect(result).toEqual(configView());
    expect(JSON.stringify(result)).not.toContain("secret-value");
  });

  it("clears the env by writing a null payload", async () => {
    await service.setEnv(admin, "123", null);
    expect(mocks.upsertConfig).toHaveBeenCalledWith(
      expect.objectContaining({ env: null, repositoryExternalId: "123" }),
    );
  });

  it("rejects invalid or non-member repositories with the retired action's messages", async () => {
    await expect(service.setEnv(admin, "repo_123", "KEY=value")).rejects.toMatchObject({
      status: 400,
      message: "Invalid repository.",
    });

    mocks.listRepositories.mockResolvedValue([]);
    await expect(service.setEnv(admin, "123", "KEY=value")).rejects.toMatchObject({
      status: 404,
      message: "This repository is not available to the workspace.",
    });
    await expect(service.setEnv(admin, "123", null)).rejects.toMatchObject({
      status: 404,
      message: "Repository configuration not found.",
    });
    expect(mocks.upsertConfig).not.toHaveBeenCalled();
  });

  it("validates env content with human-readable messages before touching the database", async () => {
    await expect(service.setEnv(admin, "123", "# comments only")).rejects.toMatchObject({
      status: 400,
      code: "invalid_request",
      message: "No environment variables were found.",
    });
    expect(mocks.listRepositories).not.toHaveBeenCalled();
    expect(mocks.upsertConfig).not.toHaveBeenCalled();
  });

  it("normalizes setup instructions and bounds their length", async () => {
    await service.setSetupInstructions(admin, "123", "  Run bun install.  ");
    expect(mocks.upsertConfig).toHaveBeenCalledWith(
      expect.objectContaining({ setupInstructions: "Run bun install." }),
    );

    await expect(
      service.setSetupInstructions(admin, "123", "x".repeat(4_001)),
    ).rejects.toMatchObject({
      status: 400,
      message: "Setup instructions must be 4,000 characters or fewer.",
    });
  });

  it("removes configurations and reports missing ones as not_found", async () => {
    await expect(service.remove(admin, "123")).resolves.toBeUndefined();
    expect(mocks.deleteConfig).toHaveBeenCalledWith({
      db,
      workspaceId: "gws_1",
      repositoryExternalId: "123",
    });

    mocks.deleteConfig.mockResolvedValue(false);
    await expect(service.remove(admin, "123")).rejects.toMatchObject({
      status: 404,
      message: "Repository configuration not found.",
    });
  });

  it("hides unexpected persistence failures behind stable messages", async () => {
    mocks.upsertConfig.mockRejectedValue(new Error("connection reset"));
    await expect(service.setEnv(admin, "123", "KEY=value")).rejects.toMatchObject({
      status: 500,
      message: "Repository environment could not be saved.",
    });
    await expect(service.setEnv(admin, "123", null)).rejects.toMatchObject({
      message: "Repository environment could not be cleared.",
    });
  });
});
