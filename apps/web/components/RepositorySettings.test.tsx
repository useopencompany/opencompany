import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RepositorySettings } from "./RepositorySettings";

const actionMocks = vi.hoisted(() => ({
  saveEnv: vi.fn(),
  clearEnv: vi.fn(),
  saveInstructions: vi.fn(),
  deleteConfig: vi.fn(),
}));

vi.mock("@/lib/repo-config-actions", () => ({
  saveRepoEnvAction: actionMocks.saveEnv,
  clearRepoEnvAction: actionMocks.clearEnv,
  saveRepoSetupInstructionsAction: actionMocks.saveInstructions,
  deleteRepoConfigAction: actionMocks.deleteConfig,
}));

describe("RepositorySettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    actionMocks.saveEnv.mockResolvedValue({
      ok: true,
      config: config({ envKeys: ["DATABASE_URL", "API_TOKEN"] }),
    });
    actionMocks.clearEnv.mockResolvedValue({
      ok: true,
      config: config({ envKeys: [] }),
    });
    actionMocks.saveInstructions.mockResolvedValue({
      ok: true,
      config: config({ setupInstructions: "Run bun install." }),
    });
    actionMocks.deleteConfig.mockResolvedValue({
      ok: true,
      repositoryExternalId: "123",
    });
  });

  it("shows only masked key names and updates local state through the secure action", async () => {
    const user = userEvent.setup();
    render(
      <RepositorySettings
        initialRepositories={[repository()]}
        initialConfigs={[config()]}
        canEdit
      />,
    );

    expect(screen.getByText("DATABASE_URL=••••••")).toBeInTheDocument();
    expect(screen.getByText("API_TOKEN=••••••")).toBeInTheDocument();
    expect(screen.getByLabelText("Environment file contents")).toHaveValue("");

    await user.type(
      screen.getByLabelText("Environment file contents"),
      "DATABASE_URL=database-new-secret",
    );
    await user.click(screen.getByRole("button", { name: "Replace environment" }));

    await waitFor(() => {
      expect(actionMocks.saveEnv).toHaveBeenCalledWith({
        repositoryExternalId: "123",
        envContent: "DATABASE_URL=database-new-secret",
      });
    });
    expect(screen.getByLabelText("Environment file contents")).toHaveValue("");
  });

  it("merges a renamed catalog repository with its config by stable id", () => {
    render(
      <RepositorySettings
        initialRepositories={[repository({ repositoryFullName: "opencompany/renamed-app" })]}
        initialConfigs={[config({ repositoryFullName: "opencompany/old-app" })]}
        canEdit
      />,
    );

    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(
      screen.getByRole("option", { name: "opencompany/renamed-app · Private" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/no longer in the connected GitHub catalog/i),
    ).not.toBeInTheDocument();
  });

  it("keeps unavailable configs visible and lets admins remove them", async () => {
    const user = userEvent.setup();
    render(<RepositorySettings initialRepositories={[]} initialConfigs={[config()]} canEdit />);

    expect(
      screen.getByRole("option", { name: "opencompany/app · Unavailable" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/no longer in the connected GitHub catalog/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("Environment file contents")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Setup instructions")).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Remove configuration" }));

    await waitFor(() => {
      expect(actionMocks.deleteConfig).toHaveBeenCalledWith({
        repositoryExternalId: "123",
      });
    });
    expect(screen.getByText("No GitHub repositories available")).toBeInTheDocument();
  });

  it("renders workspace config read-only for non-admin members", () => {
    render(
      <RepositorySettings
        initialRepositories={[repository()]}
        initialConfigs={[config()]}
        canEdit={false}
      />,
    );

    expect(screen.queryByLabelText("Environment file contents")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Setup instructions")).toBeDisabled();
    expect(screen.getByText(/Only workspace admins can change it/i)).toBeInTheDocument();
  });
});

function repository(
  overrides: Partial<{
    repositoryExternalId: string;
    repositoryFullName: string;
  }> = {},
) {
  return {
    repositoryExternalId: overrides.repositoryExternalId ?? "123",
    repositoryFullName: overrides.repositoryFullName ?? "opencompany/app",
    private: true,
  };
}

function config(
  overrides: Partial<{
    repositoryExternalId: string;
    repositoryFullName: string;
    envKeys: string[];
    setupInstructions: string;
  }> = {},
) {
  return {
    repositoryExternalId: overrides.repositoryExternalId ?? "123",
    repositoryFullName: overrides.repositoryFullName ?? "opencompany/app",
    envKeys: overrides.envKeys ?? ["DATABASE_URL", "API_TOKEN"],
    setupInstructions: overrides.setupInstructions ?? "Copy the env, then run bun install.",
    updatedAt: new Date("2026-07-29T10:00:00Z"),
  };
}
