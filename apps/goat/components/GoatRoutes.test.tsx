import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GoatBrainView } from "@/components/GoatBrainView";
import {
  GoatBrainRoute,
  GoatMcpSettingsRoute,
  GoatPreferencesSettingsRoute,
  GoatSkillEditorRoute,
} from "./GoatRoutes";

const routerMock = vi.hoisted(() => ({
  refresh: vi.fn(),
}));

const appDataMock = vi.hoisted(() => ({
  value: {
    user: {
      email: "ada@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
      avatarUrl: null,
    },
    workspace: { id: "goat_ws_1", name: "Ada's Workspace", role: "admin" },
    workspaces: [{ id: "goat_ws_1", name: "Ada's Workspace", role: "admin" }],
    workspaceMembers: [],
    featureFlags: { taskSpawning: false, autoModelRouting: false },
    integrations: {},
    mcpSetup: { preferredClient: null, completedAt: null },
  },
}));

const userPreferencesMock = vi.hoisted(() => ({
  updateGoatTaskSpawningAction: vi.fn(async (enabled: boolean) => ({ ok: true, enabled })),
  updateGoatAutoModelRoutingAction: vi.fn(async (enabled: boolean) => ({ ok: true, enabled })),
}));

const workflowActionsMock = vi.hoisted(() => ({
  updateGoatWorkflowAction: vi.fn(async () => ({ ok: true, slug: "test-workflow" })),
  archiveGoatWorkflowAction: vi.fn(async () => ({ ok: true, slug: "test-workflow" })),
  createGoatWorkflowAction: vi.fn(async () => ({ ok: true, slug: "test-workflow" })),
}));

const skillActionsMock = vi.hoisted(() => ({
  updateGoatSkillAction: vi.fn(async () => ({ ok: true, slug: "test-skill" })),
  archiveGoatSkillAction: vi.fn(async () => ({ ok: true, slug: "test-skill" })),
  createGoatSkillAction: vi.fn(async () => ({ ok: true, slug: "test-skill" })),
}));

const themeMock = vi.hoisted(() => ({
  value: "system" as "system" | "light" | "dark",
  setTheme: vi.fn((theme: "system" | "light" | "dark") => {
    themeMock.value = theme;
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

vi.mock("@/components/GoatBrainView", () => ({
  GoatBrainView: vi.fn(() => <div data-testid="brain-view" />),
}));

vi.mock("@/components/GoatBrainSettings", () => ({
  GoatBrainSettings: () => null,
}));

vi.mock("@/components/GoatSurface", () => ({
  GoatSurface: () => null,
}));

vi.mock("@/components/JamieIntegrationSetup", () => ({
  JamieIntegrationSetup: () => null,
}));

vi.mock("@/components/GranolaIntegrationSetup", () => ({
  GranolaIntegrationSetup: () => null,
}));

vi.mock("@/components/FathomIntegrationSetup", () => ({
  FathomIntegrationSetup: () => null,
}));

vi.mock("@/components/AttioIntegrationSetup", () => ({
  AttioIntegrationSetup: () => null,
}));

vi.mock("@/components/StripeIntegrationSetup", () => ({
  StripeIntegrationSetup: () => null,
}));

vi.mock("@/components/McpSetupGuide", () => ({
  McpSetupGuide: () => <div data-testid="mcp-setup-guide" />,
}));

vi.mock("@/components/TaskDetailPanel", () => ({
  TaskDetailPanel: () => null,
}));

vi.mock("@/components/GoatAppDataProvider", () => ({
  useGoatAppData: () => appDataMock.value,
}));

vi.mock("@/components/SettingsIntegrationsPanel", () => ({
  SettingsIntegrationsPanel: () => <div>Integrations</div>,
}));

vi.mock("@/lib/user-preferences", () => ({
  updateGoatTaskSpawningAction: userPreferencesMock.updateGoatTaskSpawningAction,
  updateGoatAutoModelRoutingAction: userPreferencesMock.updateGoatAutoModelRoutingAction,
}));

vi.mock("@/lib/workflow-actions", () => ({
  updateGoatWorkflowAction: workflowActionsMock.updateGoatWorkflowAction,
  archiveGoatWorkflowAction: workflowActionsMock.archiveGoatWorkflowAction,
  createGoatWorkflowAction: workflowActionsMock.createGoatWorkflowAction,
}));

vi.mock("@/lib/skill-actions", () => ({
  updateGoatSkillAction: skillActionsMock.updateGoatSkillAction,
  archiveGoatSkillAction: skillActionsMock.archiveGoatSkillAction,
  createGoatSkillAction: skillActionsMock.createGoatSkillAction,
}));

vi.mock("@/components/ThemeProvider", () => ({
  useTheme: () => ({
    theme: themeMock.value,
    resolvedTheme: themeMock.value === "dark" ? "dark" : "light",
    setTheme: themeMock.setTheme,
  }),
}));

describe("GoatSettingsRoute", () => {
  beforeEach(() => {
    themeMock.value = "system";
    themeMock.setTheme.mockClear();
    routerMock.refresh.mockReset();
    userPreferencesMock.updateGoatTaskSpawningAction.mockClear();
    userPreferencesMock.updateGoatAutoModelRoutingAction.mockClear();
    appDataMock.value.featureFlags.taskSpawning = false;
    appDataMock.value.featureFlags.autoModelRouting = false;
  });

  it("shows the appearance theme selector and updates the selected theme", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<GoatPreferencesSettingsRoute />);

    expect(screen.getByRole("radio", { name: "System" })).toHaveAttribute("aria-checked", "true");

    await user.click(screen.getByRole("radio", { name: "Dark" }));
    expect(themeMock.setTheme).toHaveBeenCalledWith("dark");

    rerender(<GoatPreferencesSettingsRoute />);
    expect(screen.getByRole("radio", { name: "Dark" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "System" })).toHaveAttribute("aria-checked", "false");

    await user.keyboard("{ArrowLeft}");
    expect(themeMock.setTheme).toHaveBeenLastCalledWith("light");
  });

  it("brands MCP settings as OpenCompany", () => {
    const view = render(<GoatMcpSettingsRoute />);

    expect(
      screen.getByText(
        "Connect Claude, ChatGPT, or Cursor to everything you can access in OpenCompany.",
      ),
    ).toBeInTheDocument();
    expect(view.container).not.toHaveTextContent("Goat");
  });

  it("shows the Tasks & Workflows switch off by default and persists opt-in", async () => {
    const user = userEvent.setup();
    render(<GoatPreferencesSettingsRoute />);

    const toggle = screen.getByRole("switch", { name: "Tasks & Workflows" });
    expect(toggle).toHaveAttribute("aria-checked", "false");

    await user.click(toggle);

    expect(userPreferencesMock.updateGoatTaskSpawningAction).toHaveBeenCalledWith(true);
    await waitFor(() => expect(routerMock.refresh).toHaveBeenCalled());
  });

  it("shows an error when a preference update is rejected", async () => {
    userPreferencesMock.updateGoatTaskSpawningAction.mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    const user = userEvent.setup();
    render(<GoatPreferencesSettingsRoute />);

    await user.click(screen.getByRole("switch", { name: "Tasks & Workflows" }));

    expect(await screen.findByText("Could not update this preference.")).toBeInTheDocument();
    expect(routerMock.refresh).not.toHaveBeenCalled();
  });

  it("enables and disables automatic model routing", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<GoatPreferencesSettingsRoute />);

    const toggle = screen.getByRole("switch", { name: "Automatic model routing" });
    expect(toggle).toHaveAttribute("aria-checked", "false");

    await user.click(toggle);
    expect(userPreferencesMock.updateGoatAutoModelRoutingAction).toHaveBeenCalledWith(true);
    await waitFor(() => expect(routerMock.refresh).toHaveBeenCalled());

    appDataMock.value.featureFlags.autoModelRouting = true;
    rerender(<GoatPreferencesSettingsRoute />);
    expect(toggle).toHaveAttribute("aria-checked", "true");

    await user.click(toggle);
    expect(userPreferencesMock.updateGoatAutoModelRoutingAction).toHaveBeenLastCalledWith(false);
  });
});

describe("GoatBrainRoute", () => {
  beforeEach(() => {
    vi.mocked(GoatBrainView).mockClear();
  });

  it("passes an explicit route brain id through to the Brain view", () => {
    render(
      <GoatBrainRoute
        path={["people", "ada-lovelace"]}
        routeBrainId="goat_brain_team"
        selectedBrain={teamBrain}
        initialBrainSnapshot={brainSnapshot}
      />,
    );

    expect(screen.getByTestId("brain-view")).toBeInTheDocument();
    expect(vi.mocked(GoatBrainView)).toHaveBeenCalledWith(
      expect.objectContaining({
        brainRef: "goat_brain_team",
        brain: teamBrain,
        folders: brainSnapshot.folders,
        documents: brainSnapshot.documents,
        initialFolderPath: "people",
        initialBrainId: "ada-lovelace",
        routeBrainId: "goat_brain_team",
      }),
      undefined,
    );
  });

  it("uses the selected active brain for default /brain routes without URL prefixing", () => {
    render(
      <GoatBrainRoute
        path={["people", "ada-lovelace"]}
        routeBrainId={null}
        selectedBrain={defaultBrain}
        initialBrainSnapshot={brainSnapshot}
      />,
    );

    expect(vi.mocked(GoatBrainView)).toHaveBeenCalledWith(
      expect.objectContaining({
        brainRef: "goat_brain_default",
        brain: defaultBrain,
        initialFolderPath: "people",
        initialBrainId: "ada-lovelace",
        routeBrainId: null,
      }),
      undefined,
    );
  });

  it.each([
    { label: "the root", path: [] },
    { label: "the named route", path: ["overview"] },
  ])("uses Overview for $label", ({ path }) => {
    const overviewStats = {
      windowStartedAt: "2026-07-08T09:00:00.000Z",
      itemsAddedLast7Days: 5,
      retrievalsLast7Days: 12,
      activeSources: 3,
    };
    render(
      <GoatBrainRoute
        path={path}
        routeBrainId="goat_brain_team"
        selectedBrain={teamBrain}
        initialBrainSnapshot={null}
        initialOverviewStats={overviewStats}
      />,
    );

    expect(vi.mocked(GoatBrainView)).toHaveBeenCalledWith(
      expect.objectContaining({
        initialOverview: true,
        initialFolderPath: null,
        initialBrainId: null,
        overviewStats,
        initialDataLoaded: false,
      }),
      undefined,
    );
  });
});

describe("GoatSkillEditorRoute", () => {
  beforeEach(() => {
    skillActionsMock.updateGoatSkillAction.mockClear();
    routerMock.refresh.mockReset();
  });

  it("edits instructions with a rich text editor instead of a plain textarea", async () => {
    const skill = {
      id: "test-skill",
      name: "Test skill",
      description: "Does a thing",
      instructions: "Use this when asked.",
    };

    const { container } = render(
      <GoatSkillEditorRoute skill={skill} initialStatus="draft" canEdit />,
    );

    expect(container.querySelector("textarea")).toBeNull();
    expect(await screen.findByText("Use this when asked.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(skillActionsMock.updateGoatSkillAction).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: "test-skill",
          instructions: "Use this when asked.",
        }),
      ),
    );
  });
});

const defaultBrain = {
  id: "goat_brain_default",
  name: "Default",
  slug: "default",
  description: null,
  visibility: "workspace" as const,
};

const teamBrain = {
  id: "goat_brain_team",
  name: "Team",
  slug: "team",
  description: null,
  visibility: "workspace" as const,
};

const brainSnapshot = {
  folders: [
    {
      id: "folder_people",
      path: "people",
      name: "People",
      source: "system" as const,
      createdAt: "2026-07-06T12:00:00.000Z",
      updatedAt: "2026-07-06T12:00:00.000Z",
    },
  ],
  documents: [
    {
      id: "doc_ada",
      brainId: "ada-lovelace",
      folderPath: "people",
      path: "people/ada-lovelace.md",
      title: "Ada Lovelace",
      content: "",
      body: "Compiler and collaborator.",
      timeline: [],
      format: "markdown" as const,
      mimeType: "text/markdown",
      originalFileName: null,
      assetStorageKey: null,
      assetSizeBytes: null,
      relations: [],
      sources: [],
      kind: "page" as const,
      type: "person" as const,
      status: "draft" as const,
      aliases: [],
      contentHash: "hash",
      sizeBytes: 128,
      createdAt: "2026-07-06T12:00:00.000Z",
      updatedAt: "2026-07-06T12:00:00.000Z",
    },
  ],
};
