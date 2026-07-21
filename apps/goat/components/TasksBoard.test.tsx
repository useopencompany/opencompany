import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GoatTaskRow } from "@/lib/task-collections";
import { TasksBoard } from "./TasksBoard";

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const tasksActionsMock = vi.hoisted(() => ({
  archiveGoatTaskAction: vi.fn(async () => ({ ok: true, error: null })),
  cancelGoatTaskAction: vi.fn(async () => ({ ok: true, error: null })),
  retryGoatTaskAction: vi.fn(async () => ({ ok: true as const })),
}));
const scheduleActionsMock = vi.hoisted(() => ({
  runGoatTaskScheduleNowAction: vi.fn(async () => ({
    ok: true as const,
    task: { id: "goat_task_now", displayId: "TASK-50" },
  })),
  setGoatTaskScheduleEnabledAction: vi.fn(async () => ({ ok: true as const })),
}));
const appDataMock = vi.hoisted(() => ({
  value: {
    schedules: [] as Array<{
      id: string;
      name: string;
      sourceDescription: string;
      cron: string;
      timezone: string;
      prompt: string;
      enabled: boolean;
      lastRunAt: string | null;
      nextRunAt: string;
      createdAt: string;
      updatedAt: string;
    }>,
    taskRows: [] as GoatTaskRow[],
  },
}));

vi.mock("@opencompany/ui/components/sonner", () => ({ toast: toastMock }));
vi.mock("@/lib/tasks", () => tasksActionsMock);
vi.mock("@/lib/task-schedules", () => scheduleActionsMock);
vi.mock("@/components/GoatAppDataProvider", () => ({
  useGoatAppData: () => appDataMock.value,
}));
vi.mock("@/components/NewTaskDialog", () => ({
  NewTaskDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="new-task-dialog" /> : null,
}));

function taskRow(overrides: Partial<GoatTaskRow>): GoatTaskRow {
  return {
    id: "goat_task_1",
    display_id: "TASK-1",
    name: "Test task",
    user_workos_id: "user_1",
    prompt: "Do the thing",
    model: "anthropic/claude-sonnet-5",
    schedule_id: null,
    scheduled_for: null,
    status: "queued",
    stage: "queued",
    result: null,
    error: null,
    harness_spec: null,
    debug_trace: null,
    sandbox_id: null,
    attempts: 0,
    next_run_at: "2026-07-21T10:00:00.000Z",
    lease_id: null,
    lease_owner: null,
    lease_expires_at: null,
    archived_at: null,
    created_at: "2026-07-21T10:00:00.000Z",
    updated_at: "2026-07-21T10:00:00.000Z",
    ...overrides,
  };
}

function schedule(overrides: Partial<(typeof appDataMock.value.schedules)[number]>) {
  return {
    id: "goat_task_schedule_1",
    name: "Weekly report",
    sourceDescription: "Every Mon at 09:00",
    cron: "0 9 * * 1",
    timezone: "UTC",
    prompt: "Write the weekly report",
    enabled: true,
    lastRunAt: null,
    nextRunAt: "2026-07-27T09:00:00.000Z",
    createdAt: "2026-07-01T09:00:00.000Z",
    updatedAt: "2026-07-01T09:00:00.000Z",
    ...overrides,
  };
}

describe("TasksBoard", () => {
  afterEach(() => {
    vi.clearAllMocks();
    appDataMock.value = { schedules: [], taskRows: [] };
  });

  it("partitions cards into Todo, In Progress, and Done columns", () => {
    appDataMock.value = {
      schedules: [schedule({})],
      taskRows: [
        taskRow({ id: "t1", display_id: "TASK-1", name: "Running task", status: "running" }),
        taskRow({
          id: "t2",
          display_id: "TASK-2",
          name: "Finished task",
          status: "succeeded",
          result: "All done.",
        }),
      ],
    };
    render(<TasksBoard />);

    const todo = screen.getByRole("region", { name: "Todo" });
    expect(within(todo).getByText("Weekly report")).toBeInTheDocument();

    const inProgress = screen.getByRole("region", { name: "In Progress" });
    expect(within(inProgress).getByText("Running task")).toBeInTheDocument();

    const done = screen.getByRole("region", { name: "Done" });
    expect(within(done).getByText("Finished task")).toBeInTheDocument();
  });

  it("shows empty states when there is nothing to show", () => {
    render(<TasksBoard />);

    expect(screen.getByText("No recurring tasks yet.")).toBeInTheDocument();
    expect(screen.getByText("Nothing running right now.")).toBeInTheDocument();
    expect(screen.getByText("Finished tasks land here.")).toBeInTheDocument();
  });

  it("marks failed tasks and retries them in place", async () => {
    const user = userEvent.setup();
    appDataMock.value = {
      schedules: [],
      taskRows: [
        taskRow({
          id: "t3",
          display_id: "TASK-3",
          name: "Broken task",
          status: "failed",
          stage: "failed",
          error: "It broke.",
        }),
      ],
    };
    render(<TasksBoard />);

    const done = screen.getByRole("region", { name: "Done" });
    expect(within(done).getByText("Failed")).toBeInTheDocument();

    await user.click(within(done).getByRole("button", { name: "Retry Broken task" }));
    expect(tasksActionsMock.retryGoatTaskAction).toHaveBeenCalledWith("t3");
  });

  it("archives done tasks optimistically", async () => {
    const user = userEvent.setup();
    appDataMock.value = {
      schedules: [],
      taskRows: [
        taskRow({ id: "t4", display_id: "TASK-4", name: "Old task", status: "succeeded" }),
      ],
    };
    render(<TasksBoard />);

    await user.click(screen.getByRole("button", { name: "Archive Old task" }));
    expect(tasksActionsMock.archiveGoatTaskAction).toHaveBeenCalledWith("t4");
    expect(screen.queryByText("Old task")).not.toBeInTheDocument();
  });

  it("stops a running task", async () => {
    const user = userEvent.setup();
    appDataMock.value = {
      schedules: [],
      taskRows: [taskRow({ id: "t5", display_id: "TASK-5", name: "Busy task", status: "running" })],
    };
    render(<TasksBoard />);

    await user.click(screen.getByRole("button", { name: "Stop Busy task" }));
    expect(tasksActionsMock.cancelGoatTaskAction).toHaveBeenCalledWith("t5");
  });

  it("collapses older occurrences of the same schedule in Done", () => {
    appDataMock.value = {
      schedules: [],
      taskRows: [
        taskRow({
          id: "o1",
          display_id: "TASK-10",
          name: "Weekly report",
          status: "succeeded",
          schedule_id: "s1",
          updated_at: "2026-07-21T09:00:00.000Z",
        }),
        taskRow({
          id: "o2",
          display_id: "TASK-11",
          name: "Weekly report",
          status: "succeeded",
          schedule_id: "s1",
          updated_at: "2026-07-14T09:00:00.000Z",
        }),
        taskRow({
          id: "o3",
          display_id: "TASK-12",
          name: "Weekly report",
          status: "succeeded",
          schedule_id: "s1",
          updated_at: "2026-07-07T09:00:00.000Z",
        }),
      ],
    };
    render(<TasksBoard />);

    const done = screen.getByRole("region", { name: "Done" });
    expect(within(done).getAllByText("Weekly report")).toHaveLength(1);
    expect(within(done).getByRole("button", { name: "2 earlier runs" })).toBeInTheDocument();
  });

  it("opens the new task dialog", async () => {
    const user = userEvent.setup();
    render(<TasksBoard />);

    await user.click(screen.getByRole("button", { name: /New task/ }));
    expect(screen.getByTestId("new-task-dialog")).toBeInTheDocument();
  });
});
