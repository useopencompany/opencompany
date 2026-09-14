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
}));

vi.mock("next/navigation", () => ({ useRouter: () => routerMock }));
vi.mock("@/lib/headless-automation-commands", () => ({
  updateHeadlessWorkflow: workflowActionsMock.update,
  archiveHeadlessWorkflow: workflowActionsMock.archive,
  runHeadlessWorkflowNow: workflowActionsMock.runNow,
}));
vi.mock("@/components/MarkdownBrainEditor", () => ({
  MarkdownBrainEditor: ({
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
  props: Omit<ComponentProps<typeof WorkflowEditorComponent>, "workspaceId" | "owner">,
) {
  return (
    <WorkflowEditorComponent
      {...props}
      workspaceId="workspace_1"
      owner={{ name: "Louis Morgner", avatarUrl: null }}
    />
  );
}

const workflow = {
  id: "workflow_1",
  slug: "weekly-update",
  name: "Weekly update",
  description: "Summarize the week.",
  status: "draft" as const,
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
      steps: [{ ...workflow.steps[0], instructions: "Write a concise weekly update." }],
      trigger: { type: "manual" },
      triggers: [],
    });
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
          }),
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
    accountHref: "/settings/plugins/linear",
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
