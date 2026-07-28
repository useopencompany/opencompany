import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildGoatHarnessRun } from "@/lib/task-harness-run";
import { TaskDetailPanel } from "./TaskDetailPanel";

const mocks = vi.hoisted(() => ({
  cancelGoatTaskAction: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/tasks", () => ({
  cancelGoatTaskAction: mocks.cancelGoatTaskAction,
}));

vi.mock("@opencompany/ui/components/sonner", () => ({
  toast: {
    error: mocks.toastError,
  },
}));

vi.mock("@/components/useHydrated", () => ({
  useHydrated: () => false,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cancelGoatTaskAction.mockResolvedValue({ ok: true, error: null });
});

describe("TaskDetailPanel workflow tag", () => {
  it("renders the workflow slug as a #tag where the title would be", () => {
    const run = buildGoatHarnessRun({
      task: task({ workflowId: "morning-test", name: "Morning Test" }),
      messages: [],
      events: [],
    });

    render(<TaskDetailPanel initialRun={run} />);

    expect(screen.getByText("#morning-test")).toBeInTheDocument();
    // The chat-like view drops the metadata sections.
    expect(screen.queryByText("Cost")).not.toBeInTheDocument();
    expect(screen.queryByText("Harness")).not.toBeInTheDocument();
    expect(screen.queryByText("Task")).not.toBeInTheDocument();
  });

  it("falls back to the task name when there is no workflow", () => {
    const run = buildGoatHarnessRun({
      task: task({ workflowId: null, name: "Research Marseille" }),
      messages: [],
      events: [],
    });

    render(<TaskDetailPanel initialRun={run} />);

    expect(screen.getByRole("heading", { name: "Research Marseille" })).toBeInTheDocument();
    expect(screen.queryByText(/^#/)).not.toBeInTheDocument();
  });

  it("renders the run transcript like a chat", () => {
    const run = buildGoatHarnessRun({
      task: task({ workflowId: "morning-test", prompt: "Run the morning test" }),
      messages: [],
      events: [],
    });

    render(<TaskDetailPanel initialRun={run} />);

    expect(screen.getByText("Run the morning test")).toBeInTheDocument();
  });
});

describe("TaskDetailPanel stop action", () => {
  it("renders a stop button for active tasks and calls the cancel action", async () => {
    const user = userEvent.setup();
    const run = buildGoatHarnessRun({
      task: task({ status: "running", stage: "running", result: null }),
      messages: [],
      events: [],
    });

    render(<TaskDetailPanel initialRun={run} />);

    const stopButton = screen.getByRole("button", { name: "Stop" });
    await user.click(stopButton);

    expect(mocks.cancelGoatTaskAction).toHaveBeenCalledWith("goat_task_1");
    expect(screen.getByRole("button", { name: "Stopping" })).toBeDisabled();
  });

  it("resets the stop button when the cancel action fails", async () => {
    mocks.cancelGoatTaskAction.mockResolvedValue({ ok: false, error: "Nope." });
    const user = userEvent.setup();
    const run = buildGoatHarnessRun({
      task: task({ status: "running", stage: "running", result: null }),
      messages: [],
      events: [],
    });

    render(<TaskDetailPanel initialRun={run} />);

    await user.click(screen.getByRole("button", { name: "Stop" }));

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith("Nope.");
      expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
    });
  });

  it("resets the stop button when the cancel action throws", async () => {
    mocks.cancelGoatTaskAction.mockRejectedValue(new Error("network"));
    const user = userEvent.setup();
    const run = buildGoatHarnessRun({
      task: task({ status: "running", stage: "running", result: null }),
      messages: [],
      events: [],
    });

    render(<TaskDetailPanel initialRun={run} />);

    await user.click(screen.getByRole("button", { name: "Stop" }));

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith("Could not stop task.");
      expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
    });
  });

  it.each([
    ["succeeded", "completed"],
    ["failed", "failed"],
    ["canceled", "canceled"],
  ] as const)("does not render a stop button for %s tasks", (status, stage) => {
    const run = buildGoatHarnessRun({
      task: task({ status, stage }),
      messages: [],
      events: [],
    });

    render(<TaskDetailPanel initialRun={run} />);

    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
  });
});

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: "goat_task_1",
    displayId: "TASK-1",
    name: "Research Marseille",
    prompt: "Research Marseille",
    model: "openai/gpt-5.4-mini",
    status: "succeeded" as const,
    stage: "completed" as const,
    result: "Done.",
    error: null,
    workflowId: "morning-test",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}
