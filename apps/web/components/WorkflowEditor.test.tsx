import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowEditor as WorkflowEditorComponent } from "./WorkflowEditor";

const routerMock = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
}));

const workflowActionsMock = vi.hoisted(() => ({
  update: vi.fn(async () => ({ version: 2 })),
  archive: vi.fn(async () => ({ workflowId: "workflow_1", version: 2 })),
  runNow: vi.fn(async () => ({ task: { displayId: "TASK-42" } })),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

vi.mock("@/lib/headless-automation-commands", () => ({
  updateHeadlessWorkflow: workflowActionsMock.update,
  archiveHeadlessWorkflow: workflowActionsMock.archive,
  runHeadlessWorkflowNow: workflowActionsMock.runNow,
}));

function WorkflowEditor(
  props: Omit<ComponentProps<typeof WorkflowEditorComponent>, "workspaceId">,
) {
  return <WorkflowEditorComponent {...props} workspaceId="workspace_1" />;
}

vi.mock("@/components/MarkdownBrainEditor", () => ({
  MarkdownBrainEditor: ({
    content,
    onChange,
    readOnly,
    placeholder,
  }: {
    content: string;
    onChange: (value: string) => void;
    readOnly?: boolean;
    placeholder?: string;
  }) => (
    <textarea
      aria-label={placeholder}
      value={content}
      readOnly={readOnly}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

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

  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces edits and saves the step plan", async () => {
    render(<WorkflowEditor workflow={workflow} canEdit skillCatalog={[]} />);

    fireEvent.click(screen.getByRole("button", { name: "Weekly update" }));
    const title = screen.getByPlaceholderText("Untitled workflow");
    fireEvent.change(title, { target: { value: "Investor update" } });

    expect(workflowActionsMock.update).not.toHaveBeenCalled();
    await advanceAutosave();

    expect(workflowActionsMock.update).toHaveBeenCalledTimes(1);
    expect(workflowActionsMock.update).toHaveBeenCalledWith("workflow_1", {
      expectedVersion: 1,
      name: "Investor update",
      description: "Summarize the week.",
      steps: workflow.steps,
      status: "draft",
      trigger: { type: "manual" },
    });
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("collapses edits made during an in-flight save into one trailing save", async () => {
    const firstSave = deferred<{ version: number }>();
    workflowActionsMock.update
      .mockImplementationOnce(() => firstSave.promise)
      .mockResolvedValue({ version: 3 });
    render(<WorkflowEditor workflow={workflow} canEdit skillCatalog={[]} />);

    fireEvent.change(screen.getByLabelText("Step 1 name"), { target: { value: "First edit" } });
    await advanceAutosave();
    expect(workflowActionsMock.update).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText("Step 1 name"), { target: { value: "Second edit" } });
    fireEvent.change(screen.getByLabelText("Step 1 name"), { target: { value: "Final edit" } });
    await advanceAutosave();
    expect(workflowActionsMock.update).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstSave.resolve({ version: 2 });
      await firstSave.promise;
    });

    expect(workflowActionsMock.update).toHaveBeenCalledTimes(2);
    expect(workflowActionsMock.update).toHaveBeenLastCalledWith(
      "workflow_1",
      expect.objectContaining({
        expectedVersion: 2,
        steps: [expect.objectContaining({ id: "step-1", title: "Final edit" })],
        trigger: { type: "manual" },
      }),
    );
  });

  it("lets an editor retry a transient autosave failure without another edit", async () => {
    workflowActionsMock.update
      .mockRejectedValueOnce(new Error("Temporary save failure."))
      .mockResolvedValueOnce({ version: 2 });
    render(<WorkflowEditor workflow={workflow} canEdit skillCatalog={[]} />);

    fireEvent.change(screen.getByLabelText("Step 1 name"), { target: { value: "Retry me" } });
    await advanceAutosave();

    expect(screen.getByRole("alert")).toHaveTextContent("Temporary save failure.");
    const retry = screen.getByRole("button", { name: "Retry save" });
    await act(async () => {
      fireEvent.click(retry);
      await Promise.resolve();
    });

    expect(workflowActionsMock.update).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("adds and removes steps without allowing the final step to be removed", () => {
    render(<WorkflowEditor workflow={workflow} canEdit skillCatalog={[]} />);

    expect(screen.queryByLabelText("Step 2 name")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add step" }));
    expect(screen.getByLabelText("Step 2 name")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove step 2" }));
    expect(screen.queryByLabelText("Step 2 name")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove step 1" })).not.toBeInTheDocument();
  });

  it("renders markdown lists in read-only workflow steps", () => {
    render(
      <WorkflowEditor
        workflow={{
          ...workflow,
          steps: [
            {
              ...workflow.steps[0]!,
              instructions:
                "- Gather customer notes\n- Summarize risks\n\n1. Draft the update\n2. Flag blockers",
            },
          ],
        }}
        canEdit={false}
        skillCatalog={[]}
      />,
    );

    expect(screen.getByText("Gather customer notes").closest("li")).toBeInTheDocument();
    expect(screen.getByText("Summarize risks").closest("li")).toBeInTheDocument();
    expect(screen.getByText("Draft the update").closest("li")).toBeInTheDocument();
    expect(screen.getByText("Flag blockers").closest("li")).toBeInTheDocument();
  });

  it("offers Claude Code as a workflow step model option", async () => {
    render(<WorkflowEditor workflow={workflow} canEdit skillCatalog={[]} />);

    fireEvent.click(screen.getByRole("button", { name: /^Runtime:/ }));
    fireEvent.click(screen.getByRole("button", { name: /Claude Code/ }));
    await advanceAutosave();

    expect(workflowActionsMock.update).toHaveBeenCalledWith(
      "workflow_1",
      expect.objectContaining({
        steps: [
          expect.objectContaining({
            id: "step-1",
            model: "claude-code",
            runtimeModel: "anthropic/claude-sonnet-5",
            reasoningEffort: "high",
          }),
        ],
        trigger: { type: "manual" },
      }),
    );
  });

  it("saves the concrete Codex model and effort for coding steps", async () => {
    render(<WorkflowEditor workflow={workflow} canEdit skillCatalog={[]} />);

    fireEvent.click(screen.getByRole("button", { name: /^Runtime:/ }));
    fireEvent.click(screen.getByRole("button", { name: /Codex/ }));

    fireEvent.click(screen.getByRole("button", { name: /^Codex model:/ }));
    fireEvent.click(screen.getByRole("button", { name: /GPT 5\.6 Luna/ }));

    fireEvent.click(screen.getByRole("button", { name: /^Effort:/ }));
    fireEvent.click(screen.getByRole("button", { name: /Medium effort/ }));
    await advanceAutosave();

    expect(workflowActionsMock.update).toHaveBeenCalledWith(
      "workflow_1",
      expect.objectContaining({
        steps: [
          expect.objectContaining({
            id: "step-1",
            model: "codex",
            runtimeModel: "openai/gpt-5.6-luna",
            reasoningEffort: "medium",
          }),
        ],
        trigger: { type: "manual" },
      }),
    );
  });

  it("saves an on-a-schedule trigger using the friendly schedule builder", async () => {
    render(<WorkflowEditor workflow={workflow} canEdit skillCatalog={[]} />);

    fireEvent.click(screen.getByRole("radio", { name: "On a schedule" }));
    expect(screen.getByLabelText("Frequency")).toHaveValue("weekdays");
    fireEvent.change(screen.getByLabelText("At"), { target: { value: "08:30" } });
    fireEvent.change(screen.getByLabelText("Timezone"), {
      target: { value: "America/New_York" },
    });
    fireEvent.change(screen.getByLabelText("Task request"), {
      target: { value: "Draft the weekday update." },
    });
    await advanceAutosave();

    expect(workflowActionsMock.update).toHaveBeenCalledWith(
      "workflow_1",
      expect.objectContaining({
        trigger: {
          type: "schedule",
          cron: "30 8 * * 1-5",
          timezone: "America/New_York",
          prompt: "Draft the weekday update.",
        },
      }),
    );
  });

  it("switches the frequency preset and updates the cron accordingly", async () => {
    render(<WorkflowEditor workflow={workflow} canEdit skillCatalog={[]} />);

    fireEvent.click(screen.getByRole("radio", { name: "On a schedule" }));
    fireEvent.change(screen.getByLabelText("Frequency"), { target: { value: "hours" } });
    fireEvent.change(screen.getByLabelText("Every"), { target: { value: "6" } });
    fireEvent.change(screen.getByLabelText("Task request"), {
      target: { value: "Check for updates." },
    });
    await advanceAutosave();

    expect(workflowActionsMock.update).toHaveBeenCalledWith(
      "workflow_1",
      expect.objectContaining({
        trigger: {
          type: "schedule",
          cron: "0 0,6,12,18 * * *",
          timezone: "UTC",
          prompt: "Check for updates.",
        },
      }),
    );
  });

  it("saves a custom cron expression via the advanced option", async () => {
    render(<WorkflowEditor workflow={workflow} canEdit skillCatalog={[]} />);

    fireEvent.click(screen.getByRole("radio", { name: "On a schedule" }));
    fireEvent.change(screen.getByLabelText("Frequency"), { target: { value: "custom" } });
    fireEvent.change(screen.getByLabelText("Cron"), { target: { value: "13 9 1 * *" } });
    fireEvent.change(screen.getByLabelText("Task request"), {
      target: { value: "Run the monthly report." },
    });
    await advanceAutosave();

    expect(workflowActionsMock.update).toHaveBeenCalledWith(
      "workflow_1",
      expect.objectContaining({
        trigger: {
          type: "schedule",
          cron: "13 9 1 * *",
          timezone: "UTC",
          prompt: "Run the monthly report.",
        },
      }),
    );
  });

  it("runs an active scheduled workflow now and opens the created Task", async () => {
    render(
      <WorkflowEditor
        workflow={{
          ...workflow,
          status: "active",
          trigger: {
            type: "schedule",
            cron: "0 9 * * 1",
            timezone: "UTC",
            prompt: "Run the weekly report.",
            enabled: true,
            lastRunAt: null,
            nextRunAt: "2026-08-17T09:00:00.000Z",
          },
        }}
        canEdit
        skillCatalog={[]}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Run now" }));
      await Promise.resolve();
    });

    expect(workflowActionsMock.runNow).toHaveBeenCalledWith("workflow_1", {
      scopeKey: "workspace_1",
    });
    expect(routerMock.push).toHaveBeenCalledWith("/tasks/TASK-42");
  });

  it("surfaces an error when a scheduled workflow cannot be started", async () => {
    workflowActionsMock.runNow.mockRejectedValueOnce(new Error("Workflow launch failed."));
    render(
      <WorkflowEditor
        workflow={{
          ...workflow,
          status: "active",
          trigger: {
            type: "schedule",
            cron: "0 9 * * 1",
            timezone: "UTC",
            prompt: "Run the weekly report.",
            enabled: true,
            lastRunAt: null,
            nextRunAt: "2026-08-17T09:00:00.000Z",
          },
        }}
        canEdit
        skillCatalog={[]}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Run now" }));
      await Promise.resolve();
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Workflow launch failed.");
    expect(routerMock.push).not.toHaveBeenCalled();
  });

  it("archives from the editor menu", async () => {
    render(<WorkflowEditor workflow={workflow} canEdit skillCatalog={[]} />);

    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("button", { name: "Archive workflow" }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(workflowActionsMock.archive).toHaveBeenCalledWith("workflow_1", {
      expectedVersion: 1,
    });
    expect(routerMock.push).toHaveBeenCalledWith("/workflows");
  });

  it("archives with the version returned by the latest autosave", async () => {
    render(
      <WorkflowEditor
        workflow={{
          ...workflow,
          trigger: {
            type: "schedule",
            cron: "0 9 * * 1",
            timezone: "UTC",
            prompt: "Run the weekly report.",
            enabled: true,
            lastRunAt: null,
            nextRunAt: "2026-08-17T09:00:00.000Z",
          },
        }}
        canEdit
        skillCatalog={[]}
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: "Manual" }));
    await advanceAutosave();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("button", { name: "Archive workflow" }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(workflowActionsMock.archive).toHaveBeenCalledWith("workflow_1", { expectedVersion: 2 });
  });

  it("does not race archive against a pending autosave version", () => {
    render(<WorkflowEditor workflow={workflow} canEdit skillCatalog={[]} />);

    fireEvent.change(screen.getByLabelText("Step 1 name"), { target: { value: "Unsaved edit" } });
    fireEvent.click(screen.getByRole("button", { name: "More" }));

    expect(screen.getByRole("button", { name: "Archive workflow" })).toBeDisabled();
    expect(workflowActionsMock.archive).not.toHaveBeenCalled();
  });
});

async function advanceAutosave() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1200);
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
