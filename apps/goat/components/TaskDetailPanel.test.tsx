import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GoatTaskView } from "@/lib/task-board";
import { TaskDetailPanel } from "./TaskDetailPanel";

const mocks = vi.hoisted(() => ({
  cancelGoatTaskAction: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/tasks", () => ({
  cancelGoatTaskAction: mocks.cancelGoatTaskAction,
}));
vi.mock("@opencompany/ui/components/sonner", () => ({
  toast: { error: mocks.toastError },
}));
vi.mock("@/components/TaskActivityFeed", () => ({
  TaskActivitySection: ({ taskId }: { taskId: string }) => (
    <div data-testid="activity">{taskId}</div>
  ),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cancelGoatTaskAction.mockResolvedValue({ ok: true, error: null });
});

describe("TaskDetailPanel", () => {
  it("renders task metadata directly from the task row view", () => {
    render(<TaskDetailPanel task={task()} />);

    expect(screen.getByRole("heading", { name: "Research Marseille" })).toBeInTheDocument();
    expect(screen.getByText("GPT 5.4 Mini")).toBeInTheDocument();
    expect(screen.getByText("OpenCompany")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(screen.queryByText("Cost")).not.toBeInTheDocument();
    expect(screen.getByTestId("activity")).toHaveTextContent("goat_task_1");
  });

  it("renders a stop button for active tasks and calls the cancel action", async () => {
    const user = userEvent.setup();
    render(<TaskDetailPanel task={task({ status: "running", result: null })} />);

    await user.click(screen.getByRole("button", { name: "Stop" }));

    expect(mocks.cancelGoatTaskAction).toHaveBeenCalledWith("goat_task_1");
    expect(screen.getByRole("button", { name: "Stopping" })).toBeDisabled();
  });

  it("resets the stop button when cancellation fails", async () => {
    mocks.cancelGoatTaskAction.mockResolvedValue({ ok: false, error: "Nope." });
    const user = userEvent.setup();
    render(<TaskDetailPanel task={task({ status: "running", result: null })} />);

    await user.click(screen.getByRole("button", { name: "Stop" }));

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith("Nope.");
      expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
    });
  });

  it.each([
    "succeeded",
    "failed",
    "canceled",
  ] as const)("does not render a stop button for %s tasks", (status) => {
    render(<TaskDetailPanel task={task({ status })} />);
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
  });
});

function task(overrides: Partial<GoatTaskView> = {}): GoatTaskView {
  return {
    id: "goat_task_1",
    displayId: "TASK-1",
    name: "Research Marseille",
    prompt: "Research Marseille",
    model: "openai/gpt-5.4-mini",
    scheduleId: null,
    scheduledFor: null,
    engine: "opencompany",
    status: "succeeded",
    result: "Done.",
    error: null,
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}
