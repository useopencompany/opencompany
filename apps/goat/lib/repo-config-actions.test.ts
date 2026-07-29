import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteGoatRepoConfigAction,
  saveGoatRepoEnvAction,
  saveGoatRepoSetupInstructionsAction,
} from "./repo-config-actions";

const mocks = vi.hoisted(() => ({
  currentGoatUser: vi.fn(),
  deleteConfig: vi.fn(),
  listRepositories: vi.fn(),
  upsertConfig: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: () => ({ name: "db" }),
}));

vi.mock("@opencompany/db/goat-repo-configs", async (importOriginal) => {
  const original = await importOriginal<typeof import("@opencompany/db/goat-repo-configs")>();
  return {
    ...original,
    deleteGoatRepoConfig: mocks.deleteConfig,
    listGoatWorkspaceRepositories: mocks.listRepositories,
    upsertGoatRepoConfig: mocks.upsertConfig,
  };
});

vi.mock("next/cache", () => ({
  revalidatePath: mocks.revalidatePath,
}));

vi.mock("@/lib/auth", () => ({
  currentGoatUser: mocks.currentGoatUser,
}));

describe("repository config actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentGoatUser.mockResolvedValue(authContext("admin"));
    mocks.listRepositories.mockResolvedValue([
      {
        repositoryExternalId: "123",
        repositoryFullName: "OpenCompany/Renamed-App",
        private: true,
      },
    ]);
    mocks.upsertConfig.mockResolvedValue(configView());
    mocks.deleteConfig.mockResolvedValue(true);
  });

  it("rejects repository mutations from non-admin workspace members", async () => {
    mocks.currentGoatUser.mockResolvedValue(authContext("member"));

    await expect(
      saveGoatRepoEnvAction({
        repositoryExternalId: "123",
        envContent: "API_TOKEN=secret-value",
      }),
    ).resolves.toEqual({
      ok: false,
      message: "Only workspace admins can configure repository environments.",
    });
    expect(mocks.listRepositories).not.toHaveBeenCalled();
    expect(mocks.upsertConfig).not.toHaveBeenCalled();
  });

  it("resolves by stable id, refreshes the catalog name, and lets the database derive keys", async () => {
    await expect(
      saveGoatRepoEnvAction({
        repositoryExternalId: "123",
        envContent: 'DATABASE_URL="database-secret-value"\nAPI_TOKEN=token_secret',
      }),
    ).resolves.toEqual({ ok: true, config: configView() });

    expect(mocks.upsertConfig).toHaveBeenCalledWith({
      db: { name: "db" },
      workspaceId: "goat_ws_1",
      repositoryExternalId: "123",
      repositoryFullName: "OpenCompany/Renamed-App",
      createdByWorkosId: "user_1",
      env: {
        content: 'DATABASE_URL="database-secret-value"\nAPI_TOKEN=token_secret',
      },
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/settings/repositories");
  });

  it("rejects updates after a repository leaves the connected GitHub catalog", async () => {
    mocks.listRepositories.mockResolvedValue([]);

    await expect(
      saveGoatRepoSetupInstructionsAction({
        repositoryExternalId: "123",
        setupInstructions: "Run bun install.",
      }),
    ).resolves.toEqual({
      ok: false,
      message: "This repository is not available to the workspace.",
    });

    expect(mocks.upsertConfig).not.toHaveBeenCalled();
  });

  it("removes stale repository configurations by stable id", async () => {
    await expect(deleteGoatRepoConfigAction({ repositoryExternalId: "123" })).resolves.toEqual({
      ok: true,
      repositoryExternalId: "123",
    });

    expect(mocks.deleteConfig).toHaveBeenCalledWith({
      db: { name: "db" },
      workspaceId: "goat_ws_1",
      repositoryExternalId: "123",
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/settings/repositories");
  });

  it("returns a generic error and logs no setup-instruction content", async () => {
    const instructions = "Use secret setup token do-not-log-this.";
    mocks.upsertConfig.mockRejectedValueOnce(new Error(`Database rejected: ${instructions}`));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      saveGoatRepoSetupInstructionsAction({
        repositoryExternalId: "123",
        setupInstructions: instructions,
      }),
    ).resolves.toEqual({
      ok: false,
      message: "Setup instructions could not be saved.",
    });
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(instructions);
    expect(consoleError).toHaveBeenCalledWith(
      "[goat] Failed to save setup instructions for repository configuration",
      {
        workspaceId: "goat_ws_1",
        repositoryExternalId: "123",
        errorName: "Error",
      },
    );
  });
});

function authContext(role: "admin" | "member") {
  return {
    role,
    workspace: { id: "goat_ws_1" },
    user: { workosUserId: "user_1" },
  };
}

function configView(overrides: Partial<{ repositoryFullName: string; envKeys: string[] }> = {}) {
  return {
    repositoryExternalId: "123",
    repositoryFullName: overrides.repositoryFullName ?? "OpenCompany/Renamed-App",
    envKeys: overrides.envKeys ?? ["DATABASE_URL", "API_TOKEN"],
    setupInstructions: "",
    updatedAt: new Date("2026-07-29T10:00:00Z"),
  };
}
