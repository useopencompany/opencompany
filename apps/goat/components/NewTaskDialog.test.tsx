import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewTaskDialog } from "./NewTaskDialog";

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const tasksActionsMock = vi.hoisted(() => ({
  createGoatTaskAction: vi.fn(async () => ({
    ok: true as const,
    task: {
      id: "goat_task_new",
      displayId: "TASK-7",
      name: "New task",
      prompt: "Do it",
      model: "anthropic/claude-sonnet-5",
      scheduleId: null,
      scheduledFor: null,
      status: "queued" as const,
      stage: "queued" as const,
      result: null,
      error: null,
      archivedAt: null,
      createdAt: "2026-07-21T10:00:00.000Z",
      updatedAt: "2026-07-21T10:00:00.000Z",
    },
  })),
}));
const scheduleActionsMock = vi.hoisted(() => ({
  createGoatTaskScheduleAction: vi.fn(async () => ({
    ok: true as const,
    schedule: { id: "goat_task_schedule_9", name: "Weekly report" },
  })),
}));

vi.mock("@opencompany/ui/components/sonner", () => ({ toast: toastMock }));
vi.mock("@/lib/tasks", () => tasksActionsMock);
vi.mock("@/lib/task-schedules", () => scheduleActionsMock);
vi.mock("@opencompany/ui/components/dialog", () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

describe("NewTaskDialog", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("requires a description before submitting", async () => {
    const user = userEvent.setup();
    render(<NewTaskDialog open onClose={() => {}} onTaskCreated={() => {}} />);

    await user.click(screen.getByRole("button", { name: "Create & run" }));
    expect(screen.getByText("Describe what the task should do.")).toBeInTheDocument();
    expect(tasksActionsMock.createGoatTaskAction).not.toHaveBeenCalled();
  });

  it("creates a one-off task and reports it for optimistic display", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onTaskCreated = vi.fn();
    render(<NewTaskDialog open onClose={onClose} onTaskCreated={onTaskCreated} />);

    await user.type(screen.getByLabelText("Title"), "My task");
    await user.type(screen.getByLabelText("Description"), "Summarize the news");
    await user.click(screen.getByRole("button", { name: "Create & run" }));

    expect(tasksActionsMock.createGoatTaskAction).toHaveBeenCalledWith({
      name: "My task",
      prompt: "Summarize the news",
    });
    expect(onTaskCreated).toHaveBeenCalledWith(
      expect.objectContaining({ id: "goat_task_new", displayId: "TASK-7" }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("creates a recurring task with a preset-derived cron", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<NewTaskDialog open onClose={onClose} onTaskCreated={() => {}} />);

    await user.type(screen.getByLabelText("Description"), "Write the weekly report");
    await user.click(screen.getByRole("button", { name: "Recurring" }));
    await user.click(screen.getByRole("button", { name: "Weekly" }));
    await user.click(screen.getByRole("button", { name: "Fri" }));
    await user.click(screen.getByRole("button", { name: "Create recurring task" }));

    expect(scheduleActionsMock.createGoatTaskScheduleAction).toHaveBeenCalledWith(
      expect.objectContaining({
        cron: "0 9 * * 5",
        prompt: "Write the weekly report",
        sourceDescription: "Every Fri at 09:00",
      }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("surfaces server errors inline", async () => {
    tasksActionsMock.createGoatTaskAction.mockResolvedValueOnce({
      ok: false,
      error: "Background tasks are disabled.",
      // biome-ignore lint/suspicious/noExplicitAny: narrowing the mocked union
    } as any);
    const user = userEvent.setup();
    render(<NewTaskDialog open onClose={() => {}} onTaskCreated={() => {}} />);

    await user.type(screen.getByLabelText("Description"), "Do it");
    await user.click(screen.getByRole("button", { name: "Create & run" }));

    expect(await screen.findByText("Background tasks are disabled.")).toBeInTheDocument();
  });
});
