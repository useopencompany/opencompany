import "@testing-library/jest-dom/vitest";
import type { SkillImportPreviewDto } from "@opencompany/protocol";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrainView } from "@/components/BrainView";
import {
  BrainRoute,
  HomeRoute,
  InferenceSettingsRoute,
  McpSettingsRoute,
  PreferencesSettingsRoute,
  SettingsRoute,
  SkillBundleRoute,
  SkillsSettingsRoute,
  WorkflowsRoute,
} from "./Routes";

const routerMock = vi.hoisted(() => ({
  refresh: vi.fn(),
  push: vi.fn(),
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
    featureFlags: {
      bots: false,
      taskSpawning: false,
      autoModelRouting: false,
      legacyBrain: true,
    },
    integrations: {},
    mcpSetup: { preferredClient: null, completedAt: null },
  },
}));

const userPreferencesMock = vi.hoisted(() => ({
  updateBotsAction: vi.fn(async (enabled: boolean) => ({ ok: true, enabled })),
  updateTaskSpawningAction: vi.fn(async (enabled: boolean) => ({ ok: true, enabled })),
  updateAutoModelRoutingAction: vi.fn(async (enabled: boolean) => ({ ok: true, enabled })),
}));

const workflowActionsMock = vi.hoisted(() => ({
  createHeadlessWorkflow: vi.fn(async () => ({ slug: "test-workflow" })),
}));

const workflowLiveQueryMock = vi.hoisted(() => ({
  data: undefined as unknown[] | undefined,
  hydrated: true,
  isLoading: true,
}));
const surfaceMock = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));

const skillActionsMock = vi.hoisted(() => ({
  setHeadlessSkillScope: vi.fn(async () => ({ canEdit: true })),
  archiveHeadlessSkill: vi.fn(async () => ({ name: "test-skill" })),
  enableHeadlessSkill: vi.fn(async () => ({ name: "test-skill" })),
  disableHeadlessSkill: vi.fn(async () => ({ name: "test-skill" })),
  replaceHeadlessSkill: vi.fn(async () => ({ name: "test-skill" })),
  previewHeadlessSkillImport: vi.fn(
    async (): Promise<SkillImportPreviewDto> => ({
      status: "resolved" as const,
      name: "imported-skill",
      description: "Does an imported thing",
      source: {
        type: "github" as const,
        url: "https://github.com/o/r",
        ref: "main",
        path: "",
        resolvedCommit: "a".repeat(40),
      },
      integrity: `sha256:${"b".repeat(64)}`,
      files: [{ path: "SKILL.md", sizeBytes: 128 }],
      fileCount: 1,
      totalBytes: 128,
      warnings: [],
    }),
  ),
  importHeadlessSkill: vi.fn(async () => ({
    installation: { id: "imported_id", name: "imported-skill" },
    replayed: false,
  })),
  createHeadlessWorkspaceSkill: vi.fn(async () => ({
    installation: { id: "created_id", name: "investigate-bug" },
    replayed: false,
  })),
  updateHeadlessWorkspaceSkill: vi.fn(async () => ({
    name: "investigate-bug",
    bundle: { id: "bundle_2" },
  })),
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

vi.mock("@tanstack/react-db", () => ({
  useLiveQuery: vi.fn(() => workflowLiveQueryMock),
}));

vi.mock("@/components/useHydrated", () => ({
  useHydrated: () => workflowLiveQueryMock.hydrated,
}));

vi.mock("@/lib/headless-automation-collections", () => ({
  getHeadlessWorkflows: vi.fn(() => ({})),
}));

vi.mock("@/components/BrainView", () => ({
  BrainView: vi.fn(() => <div data-testid="brain-view" />),
}));

vi.mock("@/components/BrainSettings", () => ({
  BrainSettings: () => null,
}));

vi.mock("@/components/Surface", () => ({
  Surface: (props: Record<string, unknown>) => {
    surfaceMock.props = props;
    return null;
  },
}));

vi.mock("@/components/GranolaIntegrationSetup", () => ({
  GranolaIntegrationSetup: () => null,
}));

vi.mock("@/components/FathomIntegrationSetup", () => ({
  FathomIntegrationSetup: () => null,
}));

vi.mock("@/components/BrowserProfilesSettings", () => ({
  BrowserProfilesSettings: () => <div>Browser profiles</div>,
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

vi.mock("@/components/InferenceSettingsPanel", () => ({
  InferenceSettingsPanel: () => <div data-testid="inference-settings-panel" />,
}));

vi.mock("@/lib/user-preferences", () => ({
  updateBotsAction: userPreferencesMock.updateBotsAction,
  updateTaskSpawningAction: userPreferencesMock.updateTaskSpawningAction,
  updateAutoModelRoutingAction: userPreferencesMock.updateAutoModelRoutingAction,
}));

vi.mock("@/lib/headless-automation-commands", () => ({
  createHeadlessWorkflow: workflowActionsMock.createHeadlessWorkflow,
}));

vi.mock("@/lib/headless-knowledge-commands", () => ({
  setHeadlessSkillScope: skillActionsMock.setHeadlessSkillScope,
  archiveHeadlessSkill: skillActionsMock.archiveHeadlessSkill,
  enableHeadlessSkill: skillActionsMock.enableHeadlessSkill,
  disableHeadlessSkill: skillActionsMock.disableHeadlessSkill,
  replaceHeadlessSkill: skillActionsMock.replaceHeadlessSkill,
  previewHeadlessSkillImport: skillActionsMock.previewHeadlessSkillImport,
  importHeadlessSkill: skillActionsMock.importHeadlessSkill,
  createHeadlessWorkspaceSkill: skillActionsMock.createHeadlessWorkspaceSkill,
  updateHeadlessWorkspaceSkill: skillActionsMock.updateHeadlessWorkspaceSkill,
}));

vi.mock("@/components/ThemeProvider", () => ({
  useTheme: () => ({
    theme: themeMock.value,
    resolvedTheme: themeMock.value === "dark" ? "dark" : "light",
    setTheme: themeMock.setTheme,
  }),
}));

describe("HomeRoute", () => {
  it("does not let a sidebar runtime row control the active Conversation", () => {
    Object.assign(appDataMock.value, {
      activeBrain: null,
      tasks: [],
      schedules: [],
      recentChats: [
        {
          id: "conversation_1",
          title: "Sidebar snapshot",
          model: "anthropic/claude-sonnet-5",
          engine: "opencompany",
          runtime: {
            status: "running",
            activeRunId: "stale_sidebar_run",
            hasError: false,
            updatedAt: "2026-08-19T10:00:00.000Z",
          },
          activityState: "working",
          hasUnseen: false,
          preview: "Working",
          updatedAt: "2026-08-19T10:00:00.000Z",
        },
      ],
      archivedChats: [],
      codexConnected: false,
      claudeCodeConnected: false,
    });

    render(<HomeRoute chatId="conversation_1" />);

    expect(surfaceMock.props?.initialChat).toMatchObject({
      id: "conversation_1",
      runtime: null,
    });
  });
});

describe("WorkflowsRoute", () => {
  beforeEach(() => {
    workflowLiveQueryMock.data = undefined;
    workflowLiveQueryMock.hydrated = true;
    workflowLiveQueryMock.isLoading = true;
    workflowActionsMock.createHeadlessWorkflow.mockClear();
    routerMock.push.mockClear();
  });

  it("uses the server snapshot only while the canonical Workflow projection loads", () => {
    workflowLiveQueryMock.hydrated = false;
    workflowLiveQueryMock.isLoading = false;
    const props = {
      workflows: [workflowListItem()],
      workspaceId: "workspace_1",
      canEdit: true,
    };
    const view = render(<WorkflowsRoute {...props} />);

    expect(screen.getByText("Weekly research")).toBeInTheDocument();

    workflowLiveQueryMock.hydrated = true;
    workflowLiveQueryMock.data = [];
    workflowLiveQueryMock.isLoading = false;
    view.rerender(<WorkflowsRoute {...props} />);

    expect(screen.queryByText("Weekly research")).not.toBeInTheDocument();
    expect(screen.getByText("No workflows yet")).toBeInTheDocument();
  });

  it("creates through the typed Workflow command", async () => {
    workflowLiveQueryMock.data = [];
    workflowLiveQueryMock.isLoading = false;
    const user = userEvent.setup();
    render(<WorkflowsRoute workflows={[]} workspaceId="workspace_1" canEdit />);

    await user.click(screen.getByRole("button", { name: "New workflow" }));
    await user.type(screen.getByPlaceholderText("Weekly investor update"), "Test workflow");
    await user.type(screen.getByPlaceholderText("What this workflow does"), "Run the test");
    await user.click(screen.getByRole("button", { name: "Create workflow" }));

    await waitFor(() =>
      expect(workflowActionsMock.createHeadlessWorkflow).toHaveBeenCalledWith({
        name: "Test workflow",
        description: "Run the test",
      }),
    );
    expect(routerMock.push).toHaveBeenCalledWith("/workflows/test-workflow");
  });
});

describe("SettingsRoute", () => {
  beforeEach(() => {
    themeMock.value = "system";
    themeMock.setTheme.mockClear();
    routerMock.refresh.mockReset();
    userPreferencesMock.updateBotsAction.mockReset();
    appDataMock.value.featureFlags.bots = false;
    userPreferencesMock.updateTaskSpawningAction.mockClear();
    userPreferencesMock.updateAutoModelRoutingAction.mockClear();
    appDataMock.value.featureFlags.taskSpawning = false;
    appDataMock.value.featureFlags.autoModelRouting = false;
  });

  it("keeps authenticated browser profiles in personal account settings", () => {
    render(<SettingsRoute browserProfilesEnabled />);

    expect(screen.getByRole("heading", { name: "Account" })).toBeInTheDocument();
    expect(screen.getByText("Browser profiles")).toBeInTheDocument();
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

  it("brands MCP settings as opencompany", () => {
    render(<McpSettingsRoute />);

    expect(
      screen.getByText(
        "Connect Claude, ChatGPT, or Cursor to everything you can access in opencompany.",
      ),
    ).toBeInTheDocument();
  });

  it("renders the workspace inference settings", () => {
    render(<InferenceSettingsRoute />);

    expect(screen.getByRole("heading", { name: "Inference" })).toBeInTheDocument();
    expect(
      screen.getByText("Connect model subscriptions and choose how your workspace runs AI."),
    ).toBeInTheDocument();
    expect(screen.getByTestId("inference-settings-panel")).toBeInTheDocument();
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

  it("shows Bots off by default and lets the user enable and disable it", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<PreferencesSettingsRoute />);
    const toggle = screen.getByRole("switch", { name: "Bots" });
    expect(toggle).toHaveAttribute("aria-checked", "false");

    await user.click(toggle);
    expect(userPreferencesMock.updateBotsAction).toHaveBeenCalledWith(true);
    await waitFor(() => expect(routerMock.refresh).toHaveBeenCalledTimes(1));

    appDataMock.value.featureFlags.bots = true;
    rerender(<PreferencesSettingsRoute />);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await user.click(toggle);
    expect(userPreferencesMock.updateBotsAction).toHaveBeenLastCalledWith(false);
    await waitFor(() => expect(routerMock.refresh).toHaveBeenCalledTimes(2));
  });

  it("keeps Bots disabled and shows an error when saving fails", async () => {
    userPreferencesMock.updateBotsAction.mockRejectedValueOnce(new Error("API unavailable"));
    const user = userEvent.setup();
    render(<PreferencesSettingsRoute />);
    const toggle = screen.getByRole("switch", { name: "Bots" });

    await user.click(toggle);

    expect(await screen.findByText("Could not update this preference.")).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-checked", "false");
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

const workspaceSkillFixture: import("@opencompany/protocol").SkillInstallationDto = {
  id: "installation_1",
  scope: "company",
  createdByUserId: "user_1",
  canEdit: true,
  canManage: true,
  name: "investigate-bug",
  enabled: true,
  archivedAt: null,
  createdAt: "2026-08-25T05:00:00.000Z",
  updatedAt: "2026-08-25T05:00:00.000Z",
  bundle: {
    id: "bundle_1",
    name: "investigate-bug",
    description: "Reproduce and diagnose reported bugs.",
    body: "Reproduce the issue first.\n",
    license: null,
    compatibility: null,
    metadata: null,
    allowedTools: null,
    integrity: `sha256:${"b".repeat(64)}`,
    source: { type: "workspace" },
    files: [{ path: "SKILL.md", executable: false, sizeBytes: 128 }],
    createdAt: "2026-08-25T05:00:00.000Z",
  },
};

describe("SkillBundleRoute", () => {
  beforeEach(() => {
    skillActionsMock.disableHeadlessSkill.mockClear();
    routerMock.refresh.mockReset();
  });

  it("inspects an immutable bundle and manages its installation separately", async () => {
    render(
      <SkillBundleRoute
        installation={{
          id: "installation_1",
          scope: "company",
          createdByUserId: "user_1",
          canEdit: true,
          canManage: true,
          name: "imported-skill",
          enabled: true,
          archivedAt: null,
          createdAt: "2026-08-22T05:00:00.000Z",
          updatedAt: "2026-08-22T05:00:00.000Z",
          bundle: {
            id: "bundle_1",
            name: "imported-skill",
            description: "Does an imported thing",
            body: "Use this when imported.",
            license: null,
            compatibility: null,
            metadata: null,
            allowedTools: null,
            integrity: `sha256:${"b".repeat(64)}`,
            source: {
              type: "github",
              url: "https://github.com/o/r",
              ref: "main",
              path: "",
              resolvedCommit: "a".repeat(40),
            },
            files: [{ path: "SKILL.md", executable: false, sizeBytes: 128 }],
            createdAt: "2026-08-22T05:00:00.000Z",
          },
        }}
        canEdit
      />,
    );

    expect(await screen.findByText(/Imported from/)).toBeInTheDocument();
    expect(screen.getByText("Use this when imported.")).toBeInTheDocument();
    expect(screen.getByText("SKILL.md")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByRole("button", { name: "Replace bundle" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Disable" }));
    await waitFor(() =>
      expect(skillActionsMock.disableHeadlessSkill).toHaveBeenCalledWith("installation_1"),
    );
  });

  it("changes visibility on the same skill using the last observed scope", async () => {
    render(<SkillBundleRoute installation={workspaceSkillFixture} canEdit />);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: /Visibility/ }), "personal");
    await waitFor(() =>
      expect(skillActionsMock.setHeadlessSkillScope).toHaveBeenCalledWith("installation_1", {
        scope: "personal",
        expectedScope: "company",
      }),
    );
  });

  it("lets teammates edit company instructions while reserving visibility and archive for managers", async () => {
    render(
      <SkillBundleRoute installation={{ ...workspaceSkillFixture, canManage: false }} canEdit />,
    );
    expect(screen.getByRole("textbox", { name: "Skill instructions" })).not.toHaveAttribute(
      "readonly",
    );
    expect(screen.queryByRole("combobox", { name: "Visibility" })).not.toBeInTheDocument();
    await userEvent.tab();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: /Visibility managed/ })).toHaveFocus();
    expect(
      await screen.findByText("Only the creator or an admin can change visibility."),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disable" })).toBeEnabled();
  });

  it("edits workspace instructions directly and protects the saved version", async () => {
    render(<SkillBundleRoute installation={workspaceSkillFixture} canEdit />);

    expect(screen.queryByRole("button", { name: "Replace bundle" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit skill" })).not.toBeInTheDocument();
    expect(screen.queryByText(/sha256:/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    const instructions = screen.getByRole("textbox", { name: "Skill instructions" });
    await userEvent.clear(instructions);
    await userEvent.type(instructions, "Reproduce, isolate, and explain the root cause.");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(skillActionsMock.updateHeadlessWorkspaceSkill).toHaveBeenCalledWith("installation_1", {
        description: "Reproduce and diagnose reported bugs.",
        instructions: "Reproduce, isolate, and explain the root cause.",
        expectedBundleId: "bundle_1",
      }),
    );
    expect(routerMock.refresh).toHaveBeenCalled();
  });
  it("keeps a failed save editable, validates empty instructions, and discards a draft", async () => {
    render(<SkillBundleRoute installation={workspaceSkillFixture} canEdit />);
    const instructions = screen.getByRole("textbox", { name: "Skill instructions" });
    await userEvent.clear(instructions);
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Add a description and instructions");
    expect(skillActionsMock.updateHeadlessWorkspaceSkill).not.toHaveBeenCalled();
    await userEvent.type(instructions, "Revised instructions.");
    skillActionsMock.updateHeadlessWorkspaceSkill.mockRejectedValueOnce(
      new Error("This skill changed since you opened it."),
    );
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This skill changed");
    expect(instructions).toHaveValue("Revised instructions.");
    await userEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(instructions).toHaveValue("Reproduce the issue first.");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("respects an explicitly read-only skill view", () => {
    render(<SkillBundleRoute installation={workspaceSkillFixture} canEdit={false} />);
    expect(screen.queryByRole("combobox", { name: "Visibility" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Skill instructions" })).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
  });
});

describe("SkillsSettingsRoute", () => {
  beforeEach(() => {
    skillActionsMock.previewHeadlessSkillImport.mockClear();
    skillActionsMock.importHeadlessSkill.mockClear();
    skillActionsMock.createHeadlessWorkspaceSkill.mockClear();
    routerMock.push.mockReset();
  });

  it.each([
    ["All", "personal"],
    ["Company", "company"],
    ["Personal", "personal"],
  ])("imports a skill from %s with %s visibility", async (filter, scope) => {
    render(<SkillsSettingsRoute skills={[]} canEdit />);

    await userEvent.click(screen.getByRole("button", { name: filter }));
    await userEvent.click(screen.getByRole("button", { name: "Import skill" }));
    expect(screen.getByRole("combobox", { name: "Visibility" })).toHaveValue(scope);
    await userEvent.type(screen.getByPlaceholderText("github.com/owner/repo"), "github.com/o/r");
    await userEvent.click(screen.getByRole("button", { name: "Preview" }));

    expect(await screen.findByText("SKILL.md")).toBeInTheDocument();
    expect(skillActionsMock.previewHeadlessSkillImport).toHaveBeenCalledWith({
      url: "github.com/o/r",
    });

    const importButton = screen.getByRole("button", { name: "Install skill" });
    await waitFor(() => expect(importButton).toBeEnabled());
    await userEvent.click(importButton);

    await waitFor(() =>
      expect(skillActionsMock.importHeadlessSkill).toHaveBeenCalledWith({
        scope,
        url: "github.com/o/r",
        expectedResolvedCommit: "a".repeat(40),
        expectedIntegrity: `sha256:${"b".repeat(64)}`,
      }),
    );
    await waitFor(() =>
      expect(routerMock.push).toHaveBeenCalledWith("/settings/skills/imported_id"),
    );
  });

  it("shows when a source directory is normalized to the declared Skill name", async () => {
    skillActionsMock.previewHeadlessSkillImport.mockResolvedValueOnce({
      status: "resolved",
      name: "vercel-react-best-practices",
      description: "React and Next.js performance guidance.",
      source: {
        type: "skills.sh",
        url: "https://github.com/vercel-labs/agent-skills",
        ref: "main",
        path: "skills/react-best-practices",
        resolvedCommit: "a".repeat(40),
      },
      integrity: `sha256:${"b".repeat(64)}`,
      files: [{ path: "SKILL.md", sizeBytes: 128 }],
      fileCount: 1,
      totalBytes: 128,
      warnings: [
        {
          code: "source_directory_normalized",
          message:
            'Source directory "react-best-practices" will be installed as "vercel-react-best-practices" to match the Skill name.',
        },
      ],
    });
    render(<SkillsSettingsRoute skills={[]} canEdit />);

    await userEvent.click(screen.getByRole("button", { name: "Import skill" }));
    await userEvent.type(
      screen.getByPlaceholderText("github.com/owner/repo"),
      "https://skills.sh/vercel-labs/agent-skills/vercel-react-best-practices",
    );
    await userEvent.click(screen.getByRole("button", { name: "Preview" }));

    expect(await screen.findByText(/will be installed as/)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Install skill" })).toBeEnabled(),
    );
  });

  it.each([
    ["All", "personal"],
    ["Company", "company"],
    ["Personal", "personal"],
  ])(
    "creates a skill from %s with %s visibility and a derived slash command",
    async (filter, scope) => {
      render(<SkillsSettingsRoute skills={[]} canEdit />);

      await userEvent.click(screen.getByRole("button", { name: filter }));
      await userEvent.click(screen.getByRole("button", { name: `New ${scope} skill` }));
      expect(screen.getByRole("combobox", { name: "Visibility" })).toHaveValue(scope);
      await userEvent.type(screen.getByPlaceholderText("investigate-bug"), "incident-review");
      expect(screen.getByText("/incident-review")).toBeInTheDocument();
      await userEvent.type(
        screen.getByPlaceholderText(/What this skill does/),
        "Review incidents and identify root causes.",
      );
      await userEvent.type(
        screen.getByPlaceholderText(/Write the operating instructions/),
        "Reproduce the incident before proposing changes.",
      );
      await userEvent.click(screen.getByRole("button", { name: "Create skill" }));

      await waitFor(() =>
        expect(skillActionsMock.createHeadlessWorkspaceSkill).toHaveBeenCalledWith({
          scope,
          name: "incident-review",
          description: "Review incidents and identify root causes.",
          instructions: "Reproduce the incident before proposing changes.",
        }),
      );
      expect(routerMock.push).toHaveBeenCalledWith("/settings/skills/created_id");
    },
  );

  it("filters skills by scope, preserves stable links, and returns to All", async () => {
    const personal = {
      ...workspaceSkillFixture,
      id: "personal_skill",
      scope: "personal" as const,
    };
    render(<SkillsSettingsRoute skills={[workspaceSkillFixture, personal]} canEdit />);
    const filters = within(screen.getByRole("group", { name: "Skill scope" }));
    expect(filters.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByRole("link")).toHaveLength(2);

    await userEvent.click(filters.getByRole("button", { name: "Company" }));
    expect(filters.getByRole("button", { name: "Company" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("link")).toHaveAttribute("href", "/settings/skills/installation_1");

    await userEvent.click(filters.getByRole("button", { name: "Personal" }));
    expect(filters.getByRole("button", { name: "Company" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("link")).toHaveAttribute("href", "/settings/skills/personal_skill");

    await userEvent.click(filters.getByRole("button", { name: "All" }));
    expect(screen.getAllByRole("link")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "New personal skill" })).toBeInTheDocument();
  });

  it("keeps the selected scope actionable when there are no matching skills", async () => {
    render(<SkillsSettingsRoute skills={[workspaceSkillFixture]} canEdit />);
    await userEvent.click(screen.getByRole("button", { name: "Personal" }));
    expect(screen.getByText("No personal skills yet")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "New personal skill" }));
    expect(screen.getByRole("combobox", { name: "Visibility" })).toHaveValue("personal");
  });

  it("allows overriding the creation scope without changing the list filter", async () => {
    render(<SkillsSettingsRoute skills={[]} canEdit />);
    await userEvent.click(screen.getByRole("button", { name: "Company" }));
    await userEvent.click(screen.getByRole("button", { name: "New company skill" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Visibility" }), "personal");
    await userEvent.type(screen.getByPlaceholderText("investigate-bug"), "my-notes");
    await userEvent.type(screen.getByPlaceholderText(/What this skill does/), "Personal notes.");
    await userEvent.type(
      screen.getByPlaceholderText(/Write the operating instructions/),
      "Take notes.",
    );
    await userEvent.click(screen.getByRole("button", { name: "Create skill" }));
    await waitFor(() =>
      expect(skillActionsMock.createHeadlessWorkspaceSkill).toHaveBeenCalledWith(
        expect.objectContaining({ scope: "personal" }),
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await userEvent.click(screen.getByRole("button", { name: "New company skill" }));
    expect(screen.getByRole("combobox", { name: "Visibility" })).toHaveValue("company");
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

function workflowListItem() {
  return {
    id: "workflow_1",
    slug: "weekly-research",
    name: "Weekly research",
    description: "Track changes",
    steps: [],
    status: "draft" as const,
    trigger: { type: "manual" as const },
    version: 1,
    archivedAt: null,
    createdAt: "2026-08-11T09:00:00.000Z",
    updatedAt: "2026-08-11T09:00:00.000Z",
  };
}
