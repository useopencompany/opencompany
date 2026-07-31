import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoatWorkflowEditor } from "./GoatWorkflowEditor";

const routerMock = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
}));

const workflowActionsMock = vi.hoisted(() => ({
  update: vi.fn(
    async (): Promise<{ ok: true; slug: string } | { ok: false; message: string }> => ({
      ok: true,
      slug: "weekly-update",
    }),
  ),
  archive: vi.fn(async () => ({ ok: true as const, slug: "weekly-update" })),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

vi.mock("@/lib/workflow-actions", () => ({
  updateGoatWorkflowAction: workflowActionsMock.update,
  archiveGoatWorkflowAction: workflowActionsMock.archive,
}));

vi.mock("@/components/MarkdownGoatBrainEditor", () => ({
  MarkdownGoatBrainEditor: ({
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
  id: "weekly-update",
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
};

describe("GoatWorkflowEditor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    workflowActionsMock.update.mockResolvedValue({ ok: true, slug: "weekly-update" });
    workflowActionsMock.archive.mockResolvedValue({ ok: true, slug: "weekly-update" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces edits and saves the step plan", async () => {
    render(<GoatWorkflowEditor workflow={workflow} canEdit skillCatalog={[]} />);

    fireEvent.click(screen.getByRole("button", { name: "Weekly update" }));
    const title = screen.getByPlaceholderText("Untitled workflow");
    fireEvent.change(title, { target: { value: "Investor update" } });

    expect(workflowActionsMock.update).not.toHaveBeenCalled();
    await advanceAutosave();

    expect(workflowActionsMock.update).toHaveBeenCalledTimes(1);
    expect(workflowActionsMock.update).toHaveBeenCalledWith({
      slug: "weekly-update",
      name: "Investor update",
      description: "Summarize the week.",
      steps: workflow.steps,
      status: "draft",
      trigger: { type: "manual" },
    });
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("collapses edits made during an in-flight save into one trailing save", async () => {
    const firstSave = deferred<{ ok: true; slug: string }>();
    workflowActionsMock.update
      .mockImplementationOnce(() => firstSave.promise)
      .mockResolvedValue({ ok: true, slug: "weekly-update" });
    render(<GoatWorkflowEditor workflow={workflow} canEdit skillCatalog={[]} />);

    fireEvent.change(screen.getByLabelText("Step 1 name"), { target: { value: "First edit" } });
    await advanceAutosave();
    expect(workflowActionsMock.update).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText("Step 1 name"), { target: { value: "Second edit" } });
    fireEvent.change(screen.getByLabelText("Step 1 name"), { target: { value: "Final edit" } });
    await advanceAutosave();
    expect(workflowActionsMock.update).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstSave.resolve({ ok: true, slug: "weekly-update" });
      await firstSave.promise;
    });

    expect(workflowActionsMock.update).toHaveBeenCalledTimes(2);
    expect(workflowActionsMock.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        steps: [expect.objectContaining({ id: "step-1", title: "Final edit" })],
        trigger: { type: "manual" },
      }),
    );
  });

  it("lets an editor retry a transient autosave failure without another edit", async () => {
    workflowActionsMock.update
      .mockResolvedValueOnce({ ok: false, message: "Temporary save failure." })
      .mockResolvedValueOnce({ ok: true, slug: "weekly-update" });
    render(<GoatWorkflowEditor workflow={workflow} canEdit skillCatalog={[]} />);

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
    render(<GoatWorkflowEditor workflow={workflow} canEdit skillCatalog={[]} />);

    expect(screen.queryByLabelText("Step 2 name")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add step" }));
    expect(screen.getByLabelText("Step 2 name")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove step 2" }));
    expect(screen.queryByLabelText("Step 2 name")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove step 1" })).not.toBeInTheDocument();
  });

  it("offers Claude Code as a workflow step model option", async () => {
    render(<GoatWorkflowEditor workflow={workflow} canEdit skillCatalog={[]} />);

    fireEvent.click(screen.getByRole("button", { name: /^Model:/ }));
    fireEvent.click(screen.getByRole("button", { name: /Claude Code/ }));
    await advanceAutosave();

    expect(workflowActionsMock.update).toHaveBeenCalledWith(
      expect.objectContaining({
        steps: [expect.objectContaining({ id: "step-1", model: "claude-code" })],
        trigger: { type: "manual" },
      }),
    );
  });

  it("saves an on-a-schedule trigger using the friendly schedule builder", async () => {
    render(<GoatWorkflowEditor workflow={workflow} canEdit skillCatalog={[]} />);

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
    render(<GoatWorkflowEditor workflow={workflow} canEdit skillCatalog={[]} />);

    fireEvent.click(screen.getByRole("radio", { name: "On a schedule" }));
    fireEvent.change(screen.getByLabelText("Frequency"), { target: { value: "hours" } });
    fireEvent.change(screen.getByLabelText("Every"), { target: { value: "6" } });
    fireEvent.change(screen.getByLabelText("Task request"), {
      target: { value: "Check for updates." },
    });
    await advanceAutosave();

    expect(workflowActionsMock.update).toHaveBeenCalledWith(
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
    render(<GoatWorkflowEditor workflow={workflow} canEdit skillCatalog={[]} />);

    fireEvent.click(screen.getByRole("radio", { name: "On a schedule" }));
    fireEvent.change(screen.getByLabelText("Frequency"), { target: { value: "custom" } });
    fireEvent.change(screen.getByLabelText("Cron"), { target: { value: "13 9 1 * *" } });
    fireEvent.change(screen.getByLabelText("Task request"), {
      target: { value: "Run the monthly report." },
    });
    await advanceAutosave();

    expect(workflowActionsMock.update).toHaveBeenCalledWith(
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

  it("archives from the editor menu", async () => {
    render(<GoatWorkflowEditor workflow={workflow} canEdit skillCatalog={[]} />);

    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("button", { name: "Archive workflow" }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(workflowActionsMock.archive).toHaveBeenCalledWith({ slug: "weekly-update" });
    expect(routerMock.push).toHaveBeenCalledWith("/workflows");
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
