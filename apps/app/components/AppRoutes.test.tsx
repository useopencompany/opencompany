import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrainView } from "@/components/BrainView";
import {
  BrainRoute,
  McpSettingsRoute,
  PreferencesSettingsRoute,
  SkillEditorRoute,
} from "./AppRoutes";

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
  updateTaskSpawningAction: vi.fn(async (enabled: boolean) => ({ ok: true, enabled })),
  updateAutoModelRoutingAction: vi.fn(async (enabled: boolean) => ({ ok: true, enabled })),
  updateImessageEnabledAction: vi.fn(async (enabled: boolean) => ({ ok: true, enabled })),
}));

const workflowActionsMock = vi.hoisted(() => ({
  updateWorkflowAction: vi.fn(async () => ({ ok: true, slug: "test-workflow" })),
  archiveWorkflowAction: vi.fn(async () => ({ ok: true, slug: "test-workflow" })),
  createWorkflowAction: vi.fn(async () => ({ ok: true, slug: "test-workflow" })),
}));

const skillActionsMock = vi.hoisted(() => ({
  updateSkillAction: vi.fn(async () => ({ ok: true, slug: "test-skill" })),
  archiveSkillAction: vi.fn(async () => ({ ok: true, slug: "test-skill" })),
  createSkillAction: vi.fn(async () => ({ ok: true, slug: "test-skill" })),
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

vi.mock("@/components/BrainView", () => ({
  BrainView: vi.fn(() => <div data-testid="brain-view" />),
}));

vi.mock("@/components/BrainSettings", () => ({
  BrainSettings: () => null,
}));

vi.mock("@/components/ChatSurface", () => ({
  ChatSurface: () => null,
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

vi.mock("@/components/AppDataProvider", () => ({
  useAppData: () => appDataMock.value,
}));

vi.mock("@/components/SettingsIntegrationsPanel", () => ({
  SettingsIntegrationsPanel: () => <div>Integrations</div>,
}));

vi.mock("@/lib/user-preferences", () => ({
  updateTaskSpawningAction: userPreferencesMock.updateTaskSpawningAction,
  updateAutoModelRoutingAction: userPreferencesMock.updateAutoModelRoutingAction,
  updateImessageEnabledAction: userPreferencesMock.updateImessageEnabledAction,
}));

vi.mock("@/lib/workflow-actions", () => ({
  updateWorkflowAction: workflowActionsMock.updateWorkflowAction,
  archiveWorkflowAction: workflowActionsMock.archiveWorkflowAction,
  createWorkflowAction: workflowActionsMock.createWorkflowAction,
}));

vi.mock("@/lib/skill-actions", () => ({
  updateSkillAction: skillActionsMock.updateSkillAction,
  archiveSkillAction: skillActionsMock.archiveSkillAction,
  createSkillAction: skillActionsMock.createSkillAction,
}));

vi.mock("@/components/ThemeProvider", () => ({
  useTheme: () => ({
    theme: themeMock.value,
    resolvedTheme: themeMock.value === "dark" ? "dark" : "light",
    setTheme: themeMock.setTheme,
  }),
}));

describe("SettingsRoute", () => {
  beforeEach(() => {
    themeMock.value = "system";
    themeMock.setTheme.mockClear();
    routerMock.refresh.mockReset();
    userPreferencesMock.updateTaskSpawningAction.mockClear();
    userPreferencesMock.updateAutoModelRoutingAction.mockClear();
    appDataMock.value.featureFlags.taskSpawning = false;
    appDataMock.value.featureFlags.autoModelRouting = false;
  });

  it("shows the appearance theme selector and updates the selected theme", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<PreferencesSettingsRoute />);

    expect(screen.getByRole("radio", { name: "System" })).toHaveAttribute("aria-checked", "true");

    await user.click(screen.getByRole("radio", { name: "Dark" }));
    expect(themeMock.setTheme).toHaveBeenCalledWith("dark");

    rerender(<PreferencesSettingsRoute />);
    expect(screen.getByRole("radio", { name: "Dark" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "System" })).toHaveAttribute("aria-checked", "false");

    await user.keyboard("{ArrowLeft}");
    expect(themeMock.setTheme).toHaveBeenLastCalledWith("light");
  });

  it("brands MCP settings as OpenCompany", () => {
    const view = render(<McpSettingsRoute />);

    expect(
      screen.getByText(
        "Connect Claude, ChatGPT, or Cursor to everything you can access in OpenCompany.",
      ),
    ).toBeInTheDocument();
    expect(view.container).not.toHaveTextContent("Goat");
  });

  it("shows the Tasks & Workflows switch off by default and persists opt-in", async () => {
    const user = userEvent.setup();
    render(<PreferencesSettingsRoute />);

    const toggle = screen.getByRole("switch", { name: "Tasks & Workflows" });
    expect(toggle).toHaveAttribute("aria-checked", "false");

    await user.click(toggle);

    expect(userPreferencesMock.updateTaskSpawningAction).toHaveBeenCalledWith(true);
    await waitFor(() => expect(routerMock.refresh).toHaveBeenCalled());
  });

  it("shows an error when a preference update is rejected", async () => {
    userPreferencesMock.updateTaskSpawningAction.mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    const user = userEvent.setup();
    render(<PreferencesSettingsRoute />);

    await user.click(screen.getByRole("switch", { name: "Tasks & Workflows" }));

    expect(await screen.findByText("Could not update this preference.")).toBeInTheDocument();
    expect(routerMock.refresh).not.toHaveBeenCalled();
  });

  it("enables and disables automatic model routing", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<PreferencesSettingsRoute />);

    const toggle = screen.getByRole("switch", { name: "Automatic model routing" });
    expect(toggle).toHaveAttribute("aria-checked", "false");

    await user.click(toggle);
    expect(userPreferencesMock.updateAutoModelRoutingAction).toHaveBeenCalledWith(true);
    await waitFor(() => expect(routerMock.refresh).toHaveBeenCalled());

    appDataMock.value.featureFlags.autoModelRouting = true;
    rerender(<PreferencesSettingsRoute />);
    const enabledToggle = await screen.findByRole("switch", {
      name: "Automatic model routing",
    });
    await waitFor(() => expect(enabledToggle).toHaveAttribute("aria-checked", "true"));

    await user.click(enabledToggle);
    expect(userPreferencesMock.updateAutoModelRoutingAction).toHaveBeenLastCalledWith(false);
  });
});

describe("BrainRoute", () => {
  beforeEach(() => {
    vi.mocked(BrainView).mockClear();
  });

  it("passes an explicit route brain id through to the Brain view", () => {
    render(
      <BrainRoute
        path={["people", "ada-lovelace"]}
        routeBrainId="goat_brain_team"
        selectedBrain={teamBrain}
        initialBrainSnapshot={brainSnapshot}
      />,
    );

    expect(screen.getByTestId("brain-view")).toBeInTheDocument();
    expect(vi.mocked(BrainView)).toHaveBeenCalledWith(
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
      <BrainRoute
        path={["people", "ada-lovelace"]}
        routeBrainId={null}
        selectedBrain={defaultBrain}
        initialBrainSnapshot={brainSnapshot}
      />,
    );

    expect(vi.mocked(BrainView)).toHaveBeenCalledWith(
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
      <BrainRoute
        path={path}
        routeBrainId="goat_brain_team"
        selectedBrain={teamBrain}
        initialBrainSnapshot={null}
        initialOverviewStats={overviewStats}
      />,
    );

    expect(vi.mocked(BrainView)).toHaveBeenCalledWith(
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

describe("SkillEditorRoute", () => {
  beforeEach(() => {
    skillActionsMock.updateSkillAction.mockClear();
    routerMock.refresh.mockReset();
  });

  it("edits instructions with a rich text editor instead of a plain textarea", async () => {
    const skill = {
      id: "test-skill",
      name: "Test skill",
      description: "Does a thing",
      instructions: "Use this when asked.",
    };

    const { container } = render(<SkillEditorRoute skill={skill} initialStatus="draft" canEdit />);

    expect(container.querySelector("textarea")).toBeNull();
    expect(await screen.findByText("Use this when asked.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(skillActionsMock.updateSkillAction).toHaveBeenCalledWith(
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
