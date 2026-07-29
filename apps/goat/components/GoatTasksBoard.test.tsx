import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GoatTaskRow } from "@/lib/task-collections";
import { GOAT_TASK_BOARD_COLUMN_CAP, GoatTasksBoardRoute } from "./GoatTasksBoard";

const appDataMock = vi.hoisted(() => ({
  featureFlags: { taskSpawning: true },
  taskRows: [] as GoatTaskRow[],
  tasksReady: true,
  schedules: [
    {
      id: "schedule_1",
      name: "Monday briefing",
      sourceDescription: "Weekly briefing",
      cron: "0 9 * * 1",
      timezone: "Europe/Berlin",
      prompt: "Prepare the weekly briefing",
      enabled: true,
      lastRunAt: null,
      nextRunAt: "2026-08-03T07:00:00.000Z",
      createdAt: "2026-07-01T09:00:00.000Z",
      updatedAt: "2026-07-01T09:00:00.000Z",
    },
  ],
}));

const archiveTaskMock = vi.hoisted(() => vi.fn(async () => ({ ok: true as const, error: null })));
const summaryMock = vi.hoisted(() => ({
  value: {
    summary: {
      cost: {
        hasRecordedCosts: true,
        totalCostUsdMicros: 123_400,
      },
      durationMs: 192_000,
    },
    error: null as Error | null,
  },
}));

vi.mock("@/components/GoatAppDataProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/GoatAppDataProvider")>();
  return {
    ...actual,
    useGoatAppData: () => appDataMock,
  };
});

vi.mock("@/components/GoatRoutes", () => ({
  formatGoatRelativeTime: () => "2m ago",
  GoatEmptyState: ({ title }: { title: string }) => <div>{title}</div>,
  TasksWorkflowsDisabledRoute: () => <div>Tasks &amp; Workflows is a beta feature</div>,
}));

vi.mock("@/lib/tasks", () => ({
  archiveGoatTaskAction: archiveTaskMock,
}));

vi.mock("@/lib/use-task-summary", () => ({
  useGoatTaskSummary: () => summaryMock.value,
}));

describe("GoatTasksBoardRoute", () => {
  afterEach(() => {
    vi.clearAllMocks();
    appDataMock.featureFlags.taskSpawning = true;
    appDataMock.taskRows = [];
    appDataMock.tasksReady = true;
    summaryMock.value = {
      summary: {
        cost: {
          hasRecordedCosts: true,
          totalCostUsdMicros: 123_400,
        },
        durationMs: 192_000,
      },
      error: null,
    };
  });

  it("buckets all non-archived task sources into the four board columns", () => {
    appDataMock.taskRows = [
      taskRow({
        id: "queued",
        name: "Research the market",
        status: "queued",
      }),
      taskRow({
        id: "attention",
        name: "Prepare launch brief",
        status: "succeeded",
        reported_outcome: "needs_attention",
        workflow_id: "launch-brief",
      }),
      taskRow({
        id: "done",
        name: "Send Monday briefing",
        status: "succeeded",
        reported_outcome: "done",
        schedule_id: "schedule_1",
      }),
      taskRow({
        id: "canceled",
        name: "Cancel old campaign",
        status: "canceled",
      }),
      taskRow({
        id: "archived",
        name: "Archived task",
        status: "succeeded",
        archived_at: "2026-07-29T10:00:00.000Z",
      }),
    ];

    render(<GoatTasksBoardRoute workflowNames={{ "launch-brief": "Launch Brief" }} />);

    expect(
      within(screen.getByRole("region", { name: "In progress" })).getByText("Research the market"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "In review" })).getByText("Prepare launch brief"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "Done" })).getByText("Send Monday briefing"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "Canceled" })).getByText("Cancel old campaign"),
    ).toBeInTheDocument();
    expect(screen.getByText("Launch Brief")).toBeInTheDocument();
    expect(screen.getByText("Scheduled")).toBeInTheDocument();
    expect(screen.getAllByText("Ad-hoc")).toHaveLength(2);
    expect(screen.queryByText("Archived task")).not.toBeInTheDocument();
  });

  it("opens a live detail sheet from a task link and archives terminal tasks", async () => {
    const user = userEvent.setup();
    appDataMock.taskRows = [
      taskRow({
        id: "done",
        display_id: "TASK-12",
        name: "Prepare launch brief",
        prompt: "Write a concise launch brief.",
        result: "The launch brief is ready.",
        status: "succeeded",
        reported_outcome: "done",
        workflow_id: "launch-brief",
        created_at: "2026-07-29T09:00:00.000Z",
        updated_at: "2026-07-29T09:03:12.000Z",
      }),
    ];

    render(<GoatTasksBoardRoute workflowNames={{ "launch-brief": "Launch Brief" }} />);
    const taskLink = screen.getByRole("link", { name: "Open Prepare launch brief" });
    expect(taskLink).toHaveAttribute("href", "/tasks/TASK-12");
    await user.click(taskLink);

    const sheet = screen.getByRole("dialog");
    expect(within(sheet).getByText("TASK-12")).toBeInTheDocument();
    expect(within(sheet).getByText("Write a concise launch brief.")).toBeInTheDocument();
    expect(within(sheet).getByText("The launch brief is ready.")).toBeInTheDocument();
    expect(within(sheet).getByText("$0.1234")).toBeInTheDocument();
    expect(within(sheet).getByText("3m 12s")).toBeInTheDocument();
    expect(within(sheet).getByRole("link", { name: "View run" })).toHaveAttribute(
      "href",
      "/tasks/TASK-12/run",
    );
    expect(within(sheet).getByRole("link", { name: "Open full view" })).toHaveAttribute(
      "href",
      "/tasks/TASK-12",
    );

    await user.click(within(sheet).getByRole("button", { name: "Archive" }));

    expect(archiveTaskMock).toHaveBeenCalledWith("done");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("preserves modified task-link clicks for normal browser navigation", () => {
    appDataMock.taskRows = [
      taskRow({
        id: "done",
        display_id: "TASK-12",
        name: "Prepare launch brief",
        status: "succeeded",
      }),
    ];

    render(<GoatTasksBoardRoute workflowNames={{}} />);
    const taskLink = screen.getByRole("link", { name: "Open Prepare launch brief" });
    taskLink.addEventListener("click", (event) => event.preventDefault(), { once: true });
    fireEvent.click(taskLink, {
      metaKey: true,
    });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps running tasks non-archivable", async () => {
    const user = userEvent.setup();
    appDataMock.taskRows = [
      taskRow({
        id: "running",
        name: "Research the market",
        status: "running",
      }),
    ];

    render(<GoatTasksBoardRoute workflowNames={{}} />);
    await user.click(screen.getByRole("link", { name: "Open Research the market" }));

    expect(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Archive" }),
    ).toBeDisabled();
  });

  it("shows a skeleton until the canonical live task dataset is ready", () => {
    appDataMock.tasksReady = false;

    render(<GoatTasksBoardRoute workflowNames={{}} />);

    expect(screen.getByRole("status", { name: "Loading tasks" })).toBeInTheDocument();
    expect(screen.queryByText("No tasks yet")).not.toBeInTheDocument();
  });

  it("caps terminal columns and expands the remaining tasks on demand", async () => {
    const user = userEvent.setup();
    appDataMock.taskRows = Array.from({ length: GOAT_TASK_BOARD_COLUMN_CAP + 2 }, (_, index) =>
      taskRow({
        id: `done-${index}`,
        name: `Completed task ${index + 1}`,
        status: "succeeded",
        updated_at: new Date(Date.UTC(2026, 6, 29, 10, 0, index)).toISOString(),
      }),
    );

    render(<GoatTasksBoardRoute workflowNames={{}} />);

    const doneColumn = screen.getByRole("region", { name: "Done" });
    expect(within(doneColumn).getAllByRole("link")).toHaveLength(GOAT_TASK_BOARD_COLUMN_CAP);
    expect(
      within(doneColumn).getByText(String(GOAT_TASK_BOARD_COLUMN_CAP + 2)),
    ).toBeInTheDocument();
    await user.click(within(doneColumn).getByRole("button", { name: "Show 2 more" }));
    expect(within(doneColumn).getAllByRole("link")).toHaveLength(GOAT_TASK_BOARD_COLUMN_CAP + 2);
  });

  it("shows the Tasks & Workflows beta gate when disabled", () => {
    appDataMock.featureFlags.taskSpawning = false;

    render(<GoatTasksBoardRoute workflowNames={{}} />);

    expect(screen.getByText("Tasks & Workflows is a beta feature")).toBeInTheDocument();
  });
});

function taskRow(
  overrides: Partial<GoatTaskRow> & Pick<GoatTaskRow, "id" | "name" | "status">,
): GoatTaskRow {
  return {
    id: overrides.id,
    display_id: overrides.display_id ?? `TASK-${overrides.id}`,
    name: overrides.name,
    user_workos_id: "user_1",
    prompt: overrides.prompt ?? "Do the task.",
    model: "openai/gpt-5.2",
    schedule_id: overrides.schedule_id ?? null,
    scheduled_for: overrides.scheduled_for ?? null,
    workflow_id: overrides.workflow_id ?? null,
    workflow_brain_ref: null,
    status: overrides.status,
    stage: overrides.status === "running" ? "running" : "completed",
    result: overrides.result ?? null,
    error: overrides.error ?? null,
    reported_outcome: overrides.reported_outcome ?? null,
    outcome_comment: overrides.outcome_comment ?? null,
    harness_spec: {},
    debug_trace: {},
    sandbox_id: null,
    attempts: 0,
    next_run_at: "2026-07-29T09:00:00.000Z",
    lease_id: null,
    lease_owner: null,
    lease_expires_at: null,
    archived_at: overrides.archived_at ?? null,
    created_at: overrides.created_at ?? "2026-07-29T09:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-07-29T09:02:00.000Z",
  };
}
