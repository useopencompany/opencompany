import "@testing-library/jest-dom/vitest";
import type { UpdateWorkflowBody } from "@opencompany/protocol";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowEditor as WorkflowEditorComponent } from "./WorkflowEditor";

const routerMock = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
const workflowActionsMock = vi.hoisted(() => ({
  update: vi.fn(async (workflowId: string, command: UpdateWorkflowBody) => {
    void workflowId;
    void command;
    return { version: 2 };
  }),
  archive: vi.fn(async () => ({ workflowId: "workflow_1", version: 2 })),
  runNow: vi.fn(async () => ({ task: { displayId: "TASK-42" } })),
  setMemoryEnabled: vi.fn(async (workflowId: string, enabled: boolean) => ({
    workflowId,
    enabled,
    content: "",
    updatedAt: null,
  })),
  clearMemory: vi.fn(async (workflowId: string) => ({
    workflowId,
    enabled: true,
    content: "",
    updatedAt: null,
  })),
}));

const avatarUploadMock = vi.hoisted(() =>
  vi.fn(async () => "https://app.test/workflow-avatars/a.png"),
);

vi.mock("next/navigation", () => ({ useRouter: () => routerMock }));
vi.mock("@/lib/workflow-avatar-upload", () => ({
  uploadWorkflowSlackAvatar: avatarUploadMock,
}));
vi.mock("@/lib/headless-automation-commands", () => ({
  updateHeadlessWorkflow: workflowActionsMock.update,
  archiveHeadlessWorkflow: workflowActionsMock.archive,
  runHeadlessWorkflowNow: workflowActionsMock.runNow,
  setHeadlessWorkflowMemoryEnabled: workflowActionsMock.setMemoryEnabled,
  clearHeadlessWorkflowMemory: workflowActionsMock.clearMemory,
}));
// Run history reads the live Task collection through AppDataProvider, which this editor-only
// render tree does not set up. Its own suite covers the section.
vi.mock("@/components/WorkflowRunHistory", () => ({
  WorkflowRunHistory: ({ workflowSlug }: { workflowSlug: string }) => (
    <div data-testid="workflow-run-history">{workflowSlug}</div>
  ),
}));
vi.mock("@/components/MarkdownEditor", () => ({
  MarkdownEditor: ({
    content,
    onChange,
    placeholder,
  }: {
    content: string;
    onChange: (value: string) => void;
    placeholder?: string;
  }) => (
    <textarea
      aria-label={placeholder}
      value={content}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

function WorkflowEditor(
  props: Omit<
    ComponentProps<typeof WorkflowEditorComponent>,
    "workspaceId" | "owner" | "canManageScope" | "memory" | "slackBotSettings"
  > & {
    canManageScope?: boolean;
    memory?: ComponentProps<typeof WorkflowEditorComponent>["memory"];
    slackBotSettings?: ComponentProps<typeof WorkflowEditorComponent>["slackBotSettings"];
  },
) {
  const {
    slackBotSettings = {
      isAdmin: true,
      configured: true,
      installed: true,
      status: "connected",
      needsScopeUpgrade: false,
      canCustomizeIdentity: true,
      teamName: "Acme",
      statusReason: null,
    },
    ...editorProps
  } = props;
  return (
    <WorkflowEditorComponent
      canManageScope
      memory={{ workflowId: "workflow_1", enabled: false, content: "", updatedAt: null }}
      {...editorProps}
      workspaceId="workspace_1"
      owner={{ name: "Louis Morgner", avatarUrl: null }}
      slackBotSettings={slackBotSettings}
    />
  );
}

const workflow = {
  id: "workflow_1",
  slug: "weekly-update",
  name: "Weekly update",
  description: "Summarize the week.",
  status: "draft" as const,
  scope: "company" as const,
  slackChannel: { enabled: true, displayName: "", avatarUrl: "" },
  createdByUserId: "user_1",
  trigger: { type: "manual" as const },
  steps: [
    {
      id: "step-1",
      title: "Gather updates",
      model: "kimi-k2.6",
      instructions: "Collect the week's updates.",
    },
  ],
  version: 1,
  archivedAt: null,
  createdAt: "2026-08-12T08:00:00.000Z",
  updatedAt: "2026-08-12T08:00:00.000Z",
};

describe("WorkflowEditor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    workflowActionsMock.update.mockResolvedValue({ version: 2 });
    workflowActionsMock.archive.mockResolvedValue({ workflowId: "workflow_1", version: 2 });
    workflowActionsMock.runNow.mockResolvedValue({ task: { displayId: "TASK-42" } });
  });

  afterEach(() => vi.useRealTimers());

  it("renders the detail hierarchy, owner, test action, and instruction model", () => {
    render(<WorkflowEditor workflow={workflow} canEdit skillCatalog={[]} />);

    expect(screen.getByRole("link", { name: "Workflows" })).toHaveAttribute("href", "/workflows");
    expect(screen.getAllByText("Weekly update")).toHaveLength(2);
    expect(screen.getByText("Louis Morgner")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Test" })).toBeEnabled();
    expect(screen.getByText("Agent instructions")).toBeInTheDocument();
    expect(screen.getByText("Model")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Runtime: Kimi K2.6" })).toBeInTheDocument();
    expect(screen.queryByText("Add step")).not.toBeInTheDocument();
    expect(screen.queryByText(/This workflow is a draft/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Add instructions to this step/)).not.toBeInTheDocument();
  });

  it("autosaves instruction edits with the canonical trigger collection", async () => {
    render(<WorkflowEditor workflow={workflow} canEdit skillCatalog={[]} />);
    fireEvent.change(screen.getByLabelText("Describe what this step should do..."), {
      target: { value: "Write a concise weekly update." },
    });
    await advanceAutosave();

    expect(workflowActionsMock.update).toHaveBeenCalledWith("workflow_1", {
      expectedVersion: 1,
      name: "Weekly update",
      description: "Summarize the week.",
      status: "draft",
      scope: "company",
      slackChannel: { enabled: true, displayName: "", avatarUrl: "" },
      steps: [{ ...workflow.steps[0], instructions: "Write a concise weekly update." }],
      trigger: { type: "manual" },
      triggers: [],
    });
  });

  it("turns the Slack channel off and customizes the identity it posts under", async () => {
    render(<WorkflowEditor workflow={workflow} canEdit skillCatalog={[]} />);

    expect(screen.getByText("Channels")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Identity"), { target: { value: "James" } });
    await advanceAutosave();
    expect(workflowActionsMock.update.mock.calls.at(-1)?.[1].slackChannel).toEqual({
      enabled: true,
      displayName: "James",
      avatarUrl: "",
    });

    fireEvent.click(screen.getByRole("switch", { name: "Turn off Slack" }));
    // The name field belongs to an enabled channel; turning Slack off retires it from the form.
    expect(screen.queryByLabelText("Identity")).not.toBeInTheDocument();
    await advanceAutosave();
    expect(workflowActionsMock.update.mock.calls.at(-1)?.[1].slackChannel).toEqual({
      enabled: false,
      displayName: "James",
      avatarUrl: "",
    });
  });

  it("uploads an avatar, saves the returned URL, and can clear it again", async () => {
    render(<WorkflowEditor workflow={workflow} canEdit skillCatalog={[]} />);

    expect(screen.getByRole("button", { name: "Upload avatar" })).toBeEnabled();
    const picker = screen.getByTestId("workflow-slack-avatar-input");
    await act(async () => {
      fireEvent.change(picker, {
        target: { files: [new File(["bytes"], "james.png", { type: "image/png" })] },
      });
    });

    expect(avatarUploadMock).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: "workflow_1" }),
    );
    await advanceAutosave();
    expect(workflowActionsMock.update.mock.calls.at(-1)?.[1].slackChannel).toMatchObject({
      avatarUrl: "https://app.test/workflow-avatars/a.png",
    });
    expect(screen.getByRole("button", { name: "Replace avatar" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove avatar" }));
    await advanceAutosave();
    expect(workflowActionsMock.update.mock.calls.at(-1)?.[1].slackChannel).toMatchObject({
      avatarUrl: "",
    });
  });

  it("surfaces a failed upload without touching the saved avatar", async () => {
    avatarUploadMock.mockRejectedValueOnce(new Error("Avatars are limited to 1 MB."));
    render(<WorkflowEditor workflow={workflow} canEdit skillCatalog={[]} />);

    await act(async () => {
      fireEvent.change(screen.getByTestId("workflow-slack-avatar-input"), {
        target: { files: [new File(["bytes"], "big.png", { type: "image/png" })] },
      });
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Avatars are limited to 1 MB.");
    // Nothing about the workflow changed, so the draft stays clean and autosave never fires.
    await advanceAutosave();
    expect(workflowActionsMock.update).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Upload avatar" })).toBeInTheDocument();
  });

  it("shows the required Slack reconnect beside an unsupported custom identity", () => {
    render(
      <WorkflowEditor
        workflow={{
          ...workflow,
          slackChannel: { enabled: true, displayName: "James", avatarUrl: "" },
        }}
        canEdit
        skillCatalog={[]}
        slackBotSettings={{
          isAdmin: true,
          configured: true,
          installed: true,
          status: "connected",
          needsScopeUpgrade: true,
          canCustomizeIdentity: false,
          teamName: "Acme",
          statusReason: null,
        }}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "This connection cannot apply custom identities yet. Reconnect Slack",
    );
    expect(screen.getByRole("link", { name: "workspace Slack connection" })).toHaveAttribute(
      "href",
      "/settings/workspace/slack",
    );
  });

  it("does not block custom identities when only another Slack scope needs an upgrade", () => {
    render(
      <WorkflowEditor
        workflow={{
          ...workflow,
          slackChannel: { enabled: true, displayName: "James", avatarUrl: "" },
        }}
        canEdit
        skillCatalog={[]}
        slackBotSettings={{
          isAdmin: true,
          configured: true,
          installed: true,
          status: "connected",
          needsScopeUpgrade: true,
          canCustomizeIdentity: true,
          teamName: "Acme",
          statusReason: null,
        }}
      />,
    );

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText(/Messages post as James/)).toBeInTheDocument();
  });

  it("adds multiple scheduled triggers from the searchable trigger menu", async () => {
    render(<WorkflowEditor workflow={workflow} canEdit skillCatalog={[]} />);

    addScheduledTrigger();
    addScheduledTrigger();
    expect(screen.getAllByText("On a schedule")).toHaveLength(2);
    await advanceAutosave();

    const command = workflowActionsMock.update.mock.calls.at(-1)?.[1];
    expect(command).toBeDefined();
    if (!command) throw new Error("Expected an autosave command.");
    expect(command.triggers).toHaveLength(2);
    expect(command.triggers).toEqual([
      expect.objectContaining({ id: expect.stringMatching(/^trigger-/), type: "schedule" }),
      expect.objectContaining({ id: expect.stringMatching(/^trigger-/), type: "schedule" }),
    ]);
    expect(command.trigger).toEqual(expect.objectContaining({ type: "schedule" }));
  });

  it("opens an existing trigger inline and saves schedule changes", async () => {
    render(
      <WorkflowEditor
        workflow={{
          ...workflow,
          triggers: [
            {
              id: "trigger_weekly",
              type: "schedule",
              cron: "0 9 * * 1",
              timezone: "UTC",
              prompt: "Run the report.",
              enabled: true,
              lastRunAt: null,
              nextRunAt: "2026-09-21T09:00:00.000Z",
            },
          ],
        }}
        canEdit
        skillCatalog={[]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /On a schedule/ }));
    expect(screen.queryByText("Additional run context (optional)")).not.toBeInTheDocument();
    fireEvent.change(screen.getByText("Every week").closest("select")!, {
      target: { value: "daily" },
    });
    await advanceAutosave();

    expect(workflowActionsMock.update).toHaveBeenLastCalledWith(
      "workflow_1",
      expect.objectContaining({
        triggers: [expect.objectContaining({ id: "trigger_weekly", cron: "0 9 * * *" })],
      }),
    );
  });

  it("keeps activation unavailable until agent instructions exist", () => {
    render(
      <WorkflowEditor
        workflow={{
          ...workflow,
          steps: [{ ...workflow.steps[0]!, instructions: "" }],
        }}
        canEdit
        skillCatalog={[]}
      />,
    );

    expect(screen.queryByText(/Add instructions to this step/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Status: Draft" }));
    expect(screen.getByRole("button", { name: "Active" })).toBeDisabled();
  });

  it("saves visibility changes and locks visibility for non-owners", async () => {
    const { rerender } = render(<WorkflowEditor workflow={workflow} canEdit skillCatalog={[]} />);

    fireEvent.click(screen.getByRole("button", { name: "Visibility: Company" }));
    fireEvent.click(screen.getByRole("button", { name: /Personal/ }));
    await advanceAutosave();
    expect(workflowActionsMock.update).toHaveBeenLastCalledWith(
      "workflow_1",
      expect.objectContaining({ scope: "personal" }),
    );

    rerender(
      <WorkflowEditor workflow={workflow} canEdit canManageScope={false} skillCatalog={[]} />,
    );
    expect(screen.queryByRole("button", { name: "Visibility: Personal" })).not.toBeInTheDocument();
    expect(
      screen.getByLabelText("Visibility: Personal, managed by the creator or an admin"),
    ).toBeInTheDocument();
  });

  it("uses a provider submenu to add an event trigger", async () => {
    render(
      <WorkflowEditor
        workflow={workflow}
        canEdit
        skillCatalog={[]}
        eventProviders={[linearEventProvider()]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add trigger" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search triggers" }), {
      target: { value: "lin" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Linear/ }));
    fireEvent.click(screen.getByRole("button", { name: /Issue created/ }));
    // A new trigger starts with no instructions of its own, so the run uses the workflow's steps.
    expect(screen.getByLabelText("Instructions for this trigger")).toHaveValue("");
    await advanceAutosave();

    expect(workflowActionsMock.update).toHaveBeenLastCalledWith(
      "workflow_1",
      expect.objectContaining({
        triggers: [
          expect.objectContaining({
            type: "event",
            provider: "linear",
            event: "issue.created",
            integrationId: "gint_1",
            prompt: "",
          }),
        ],
      }),
    );
  });

  it("writes instructions for one schedule trigger without touching the other", async () => {
    render(
      <WorkflowEditor
        workflow={{
          ...workflow,
          triggers: [
            {
              id: "trigger_hourly",
              type: "schedule",
              cron: "0 * * * *",
              timezone: "UTC",
              // The placeholder a trigger carries when its author wrote no instructions.
              prompt: "Run this workflow.",
              enabled: true,
              lastRunAt: null,
              nextRunAt: null,
            },
            {
              id: "trigger_weekly",
              type: "schedule",
              cron: "0 9 * * 1",
              timezone: "UTC",
              prompt: "Post the weekly summary.",
              enabled: true,
              lastRunAt: null,
              nextRunAt: null,
            },
          ],
        }}
        canEdit
        skillCatalog={[]}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: /On a schedule/ })[0]!);
    const field = screen.getByLabelText("Instructions for this trigger");
    expect(field).toHaveValue("");
    fireEvent.change(field, { target: { value: "Check production and report anything unusual." } });
    await advanceAutosave();

    expect(workflowActionsMock.update).toHaveBeenLastCalledWith(
      "workflow_1",
      expect.objectContaining({
        triggers: [
          expect.objectContaining({
            id: "trigger_hourly",
            prompt: "Check production and report anything unusual.",
          }),
          expect.objectContaining({ id: "trigger_weekly", prompt: "Post the weekly summary." }),
        ],
      }),
    );
  });

  it("treats whitespace-only trigger instructions as none at all", () => {
    render(
      <WorkflowEditor
        workflow={{
          ...workflow,
          triggers: [
            {
              id: "trigger_blank",
              type: "schedule",
              cron: "0 9 * * 1",
              timezone: "UTC",
              prompt: "   \n  ",
              enabled: true,
              lastRunAt: null,
              nextRunAt: null,
            },
          ],
        }}
        canEdit
        skillCatalog={[]}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: /On a schedule/ })[0]!);
    expect(screen.getByLabelText("Instructions for this trigger")).toHaveValue("");
    expect(screen.queryByText(/Own instructions/)).not.toBeInTheDocument();
  });

  it("flags a trigger that carries its own instructions on its summary line", () => {
    render(
      <WorkflowEditor
        workflow={{
          ...workflow,
          triggers: [
            {
              id: "trigger_plain",
              type: "schedule",
              cron: "0 9 * * 1",
              timezone: "UTC",
              prompt: "Run this workflow.",
              enabled: true,
              lastRunAt: null,
              nextRunAt: null,
            },
            {
              id: "trigger_briefed",
              type: "schedule",
              cron: "0 * * * *",
              timezone: "UTC",
              prompt: "Check production.",
              enabled: true,
              lastRunAt: null,
              nextRunAt: null,
            },
          ],
        }}
        canEdit
        skillCatalog={[]}
      />,
    );

    expect(screen.getAllByText(/Own instructions/)).toHaveLength(1);
  });

  it("keeps an existing event trigger prompt when the editor saves", async () => {
    render(
      <WorkflowEditor
        workflow={{
          ...workflow,
          triggers: [
            {
              id: "trigger_linear",
              type: "event",
              provider: "linear",
              event: "issue.created",
              integrationId: "gint_1",
              filters: {},
              prompt: "Only handle billing issues.",
            },
          ],
        }}
        canEdit
        skillCatalog={[]}
        eventProviders={[linearEventProvider()]}
      />,
    );
    // An event trigger row opens by default, so its instructions are visible without a click.
    expect(screen.getByLabelText("Instructions for this trigger")).toHaveValue(
      "Only handle billing issues.",
    );
    fireEvent.change(screen.getByLabelText("Describe what this step should do..."), {
      target: { value: "Collect the week's updates and post them." },
    });
    await advanceAutosave();

    expect(workflowActionsMock.update).toHaveBeenLastCalledWith(
      "workflow_1",
      expect.objectContaining({
        triggers: [
          expect.objectContaining({ id: "trigger_linear", prompt: "Only handle billing issues." }),
        ],
      }),
    );
  });

  it("tests an active manual workflow and opens the created task", async () => {
    render(
      <WorkflowEditor workflow={{ ...workflow, status: "active" }} canEdit skillCatalog={[]} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    await act(async () => Promise.resolve());

    expect(workflowActionsMock.runNow).toHaveBeenCalledWith("workflow_1", {
      scopeKey: "workspace_1",
    });
    expect(routerMock.push).toHaveBeenCalledWith("/tasks/TASK-42");
  });

  it("keeps memory off by default and hides the stored note until it is switched on", async () => {
    render(<WorkflowEditor workflow={workflow} canEdit skillCatalog={[]} />);

    expect(screen.getByText("Advanced")).toBeInTheDocument();
    const toggle = screen.getByRole("switch", { name: "Turn on memory" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByRole("button", { name: "Clear" })).not.toBeInTheDocument();

    fireEvent.click(toggle);
    await act(async () => Promise.resolve());

    expect(workflowActionsMock.setMemoryEnabled).toHaveBeenCalledWith("workflow_1", true);
    expect(screen.getByRole("switch", { name: "Turn off memory" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByText("Nothing remembered yet.")).toBeInTheDocument();
    // Enabling memory must not rewrite the workflow definition.
    expect(workflowActionsMock.update).not.toHaveBeenCalled();
  });

  it("shows what the workflow remembers and clears it on request", async () => {
    render(
      <WorkflowEditor
        workflow={workflow}
        canEdit
        skillCatalog={[]}
        memory={{
          workflowId: "workflow_1",
          enabled: true,
          content: "Pricing changed on 2026-09-01.",
          updatedAt: "2026-09-01T10:00:00.000Z",
        }}
      />,
    );

    expect(screen.getByText("Pricing changed on 2026-09-01.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await act(async () => Promise.resolve());

    expect(workflowActionsMock.clearMemory).toHaveBeenCalledWith("workflow_1");
    expect(screen.queryByText("Pricing changed on 2026-09-01.")).not.toBeInTheDocument();
    expect(screen.getByText("Nothing remembered yet.")).toBeInTheDocument();
  });

  it("treats a whitespace-only stored note as nothing remembered", async () => {
    render(
      <WorkflowEditor
        workflow={workflow}
        canEdit
        skillCatalog={[]}
        memory={{
          workflowId: "workflow_1",
          enabled: true,
          content: "   \n  ",
          updatedAt: "2026-09-01T10:00:00.000Z",
        }}
      />,
    );

    expect(screen.getByText("Nothing remembered yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear" })).not.toBeInTheDocument();
  });

  it("restores the previous memory state when a command fails", async () => {
    workflowActionsMock.setMemoryEnabled.mockRejectedValueOnce(new Error("Workspace is offline."));
    render(<WorkflowEditor workflow={workflow} canEdit skillCatalog={[]} />);

    fireEvent.click(screen.getByRole("switch", { name: "Turn on memory" }));
    await act(async () => Promise.resolve());

    expect(screen.getByRole("alert")).toHaveTextContent("Workspace is offline.");
    expect(screen.getByRole("switch", { name: "Turn on memory" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("offers safe workflow actions from the overflow menu", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<WorkflowEditor workflow={workflow} canEdit skillCatalog={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete workflow" }));
    await act(async () => Promise.resolve());

    expect(workflowActionsMock.archive).toHaveBeenCalledWith("workflow_1", { expectedVersion: 1 });
    expect(routerMock.push).toHaveBeenCalledWith("/workflows");
  });
});

function linearEventProvider() {
  return {
    provider: "linear",
    label: "Linear",
    accountHref: "/plugins/linear",
    accountLabel: "Connect Linear",
    accounts: [{ integrationId: "gint_1", label: "Acme Linear" }],
    events: [
      {
        id: "issue.created",
        label: "Issue created",
        description: "Starts when an issue is created.",
        delivery: "webhook" as const,
        filters: [],
      },
    ],
  };
}

function addScheduledTrigger() {
  fireEvent.click(screen.getByRole("button", { name: "Add trigger" }));
  fireEvent.click(screen.getByRole("button", { name: "Scheduled" }));
}

async function advanceAutosave() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1200);
  });
}
