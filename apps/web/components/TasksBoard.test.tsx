import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskRow } from "@/lib/task-collections";
import { TASK_BOARD_COLUMN_CAP, TasksBoardRoute } from "./TasksBoard";

const appDataMock = vi.hoisted(() => ({
  featureFlags: {
    taskSpawning: true,
    autoModelRouting: false,
    legacyBrain: false,
  },
  workspace: { id: "workspace_1" },
  taskRows: [] as TaskRow[],
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
const createCommentMock = vi.hoisted(() => vi.fn(async () => ({ replayed: false })));
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
const activityRowsMock = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));

vi.mock("@tanstack/react-db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-db")>();
  return {
    ...actual,
    useLiveQuery: vi.fn(() => ({ data: activityRowsMock.rows, isLoading: false })),
  };
});

vi.mock("@/components/useHydrated", () => ({
  useHydrated: () => true,
}));

vi.mock("@/lib/headless-task-collections", () => ({
  getHeadlessTaskActivities: vi.fn(() => ({ id: "task-activities" })),
}));

vi.mock("@/components/AppDataProvider", () => ({
  useAppData: () => appDataMock,
  taskRowToView: (row: TaskRow) => ({
    id: row.id,
    displayId: row.display_id,
    name: row.name,
    prompt: row.prompt,
    model: row.model,
    ...(row.engine ? { engine: row.engine } : {}),
    sessionId: row.session_id,
    scheduleId: row.schedule_id,
    scheduledFor: row.scheduled_for,
    workflowId: row.workflow_id,
    status: row.status,
    stage: row.stage,
    result: row.result,
    error: row.error,
    reportedOutcome: row.reported_outcome,
    outcomeComment: row.outcome_comment,
    workflowSteps: [],
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }),
}));

vi.mock("@/components/Routes", () => ({
  formatRelativeTime: () => "2m ago",
  EmptyState: ({ title }: { title: string }) => <div>{title}</div>,
  TasksWorkflowsDisabledRoute: () => <div>Tasks &amp; Workflows is a beta feature</div>,
}));

vi.mock("@/lib/headless-task-commands", () => ({
  archiveHeadlessTask: archiveTaskMock,
  createHeadlessTaskComment: createCommentMock,
  newHeadlessTaskCommentId: () => "task_activity_comment_test",
}));

const updateTaskViewModeMock = vi.hoisted(() =>
  vi.fn(
    async (mode: "board" | "list") => ({ ok: true, mode }) as { ok: boolean; mode: typeof mode },
  ),
);
const updateTaskTimeRangeMock = vi.hoisted(() =>
  vi.fn(
    async (range: "24h" | "2d" | "7d" | "30d" | "90d" | "all") =>
      ({ ok: true, range }) as { ok: boolean; range: typeof range },
  ),
);

vi.mock("@/lib/user-preferences", () => ({
  updateTaskTimeRangeAction: updateTaskTimeRangeMock,
  updateTaskViewModeAction: updateTaskViewModeMock,
}));

vi.mock("@/lib/use-task-summary", () => ({
  useTaskSummary: () => summaryMock.value,
}));

describe("TasksBoardRoute", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-07-29T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    appDataMock.featureFlags.taskSpawning = true;
    appDataMock.taskRows = [];
    appDataMock.tasksReady = true;
    activityRowsMock.rows = [];
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

    render(<TasksBoardRoute workflowNames={{ "launch-brief": "Launch Brief" }} />);

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
    expect(screen.getByText("#Launch Brief")).toBeInTheDocument();
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

    render(<TasksBoardRoute workflowNames={{ "launch-brief": "Launch Brief" }} />);
    const taskLink = screen.getByRole("link", { name: "Open Prepare launch brief" });
    expect(taskLink).toHaveAttribute("href", "/tasks/TASK-12");
    await user.click(taskLink);

    const sheet = screen.getByRole("dialog");
    expect(within(sheet).getByText("TASK-12")).toBeInTheDocument();
    expect(within(sheet).getByText("Write a concise launch brief.")).toBeInTheDocument();
    expect(within(sheet).getByText("Completed")).toBeInTheDocument();
    expect(within(sheet).getByText("The launch brief is ready.")).toBeInTheDocument();
    expect(within(sheet).getByText("#Launch Brief")).toBeInTheDocument();
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

    expect(archiveTaskMock).toHaveBeenCalledWith("done", { scopeKey: "workspace_1" });
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

    render(<TasksBoardRoute workflowNames={{}} />);
    const taskLink = screen.getByRole("link", { name: "Open Prepare launch brief" });
    taskLink.addEventListener("click", (event) => event.preventDefault(), { once: true });
    fireEvent.click(taskLink, {
      metaKey: true,
    });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not offer mutations for sessionless compatibility history", async () => {
    const user = userEvent.setup();
    appDataMock.taskRows = [
      taskRow({
        id: "legacy",
        display_id: "TASK-OLD",
        name: "Legacy research",
        status: "succeeded",
        session_id: null,
      }),
    ];

    render(<TasksBoardRoute workflowNames={{}} />);
    await user.click(screen.getByRole("link", { name: "Open Legacy research" }));

    const sheet = screen.getByRole("dialog");
    expect(within(sheet).getByText("Read-only history")).toBeVisible();
    expect(within(sheet).queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
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

    render(<TasksBoardRoute workflowNames={{}} />);
    await user.click(screen.getByRole("link", { name: "Open Research the market" }));

    expect(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Archive" }),
    ).toBeDisabled();
    expect(within(screen.getByRole("dialog")).getByLabelText("Add a comment")).toBeDisabled();
    expect(
      within(screen.getByRole("dialog")).getByText(
        "You can comment when the current run finishes.",
      ),
    ).toBeVisible();
  });

  it("posts a settled Task comment verbatim and resumes through the canonical command", async () => {
    const user = userEvent.setup();
    appDataMock.taskRows = [
      taskRow({ id: "waiting", name: "Approve the launch", status: "waiting" }),
    ];
    render(<TasksBoardRoute workflowNames={{}} />);
    await user.click(screen.getByRole("link", { name: "Open Approve the launch" }));

    const sheet = screen.getByRole("dialog");
    const body = "  Approved.\n  Keep the original rollout order.  ";
    fireEvent.change(within(sheet).getByLabelText("Add a comment"), { target: { value: body } });
    await user.click(within(sheet).getByRole("button", { name: "Post comment" }));

    await waitFor(() =>
      expect(createCommentMock).toHaveBeenCalledWith(
        "waiting",
        { id: "task_activity_comment_test", body },
        { scopeKey: "workspace_1" },
      ),
    );
  });

  it("logs a failed task's error as its own activity entry", async () => {
    const user = userEvent.setup();
    appDataMock.taskRows = [
      taskRow({
        id: "failed",
        name: "Sync CRM contacts",
        status: "failed",
        error: "Could not reach the CRM API.",
        created_at: "2026-07-29T09:00:00.000Z",
        updated_at: "2026-07-29T09:01:00.000Z",
      }),
    ];

    render(<TasksBoardRoute workflowNames={{}} />);
    await user.click(screen.getByRole("link", { name: "Open Sync CRM contacts" }));

    const sheet = screen.getByRole("dialog");
    const activity = within(sheet.querySelector("ol") as HTMLOListElement);
    expect(activity.getByText("Failed")).toBeInTheDocument();
    expect(activity.getByText("Could not reach the CRM API.")).toBeInTheDocument();
    expect(activity.queryByText("Completed")).not.toBeInTheDocument();
  });

  it("renders the durable activity stream instead of synthesized Task columns", async () => {
    const user = userEvent.setup();
    appDataMock.taskRows = [
      taskRow({
        id: "workflow-task",
        name: "Prepare launch brief",
        status: "succeeded",
        result: "This synthesized result should be hidden.",
        created_at: "2026-07-29T09:00:00.000Z",
        updated_at: "2026-07-29T09:03:00.000Z",
      }),
    ];
    activityRowsMock.rows = [
      {
        id: "activity_created",
        taskId: "workflow-task",
        author: "user",
        authorWorkosId: "user_1",
        kind: "created",
        body: null,
        metadata: { source: "workflow" },
        createdAt: "2026-07-29T09:00:00.000Z",
      },
      {
        id: "activity_started",
        taskId: "workflow-task",
        author: "system",
        authorWorkosId: null,
        kind: "run_started",
        body: null,
        metadata: {
          runId: "run_1",
          stepIndex: 0,
          stepCount: 2,
          stepTitle: "Research",
        },
        createdAt: "2026-07-29T09:01:00.000Z",
      },
      {
        id: "activity_finished",
        taskId: "workflow-task",
        author: "system",
        authorWorkosId: null,
        kind: "run_finished",
        body: "Research is complete.",
        metadata: {
          runId: "run_1",
          turnStatus: "completed",
          disposition: "done",
          stepIndex: 0,
          stepCount: 2,
          stepTitle: "Research",
        },
        createdAt: "2026-07-29T09:02:12.000Z",
      },
      {
        id: "activity_note",
        taskId: "workflow-task",
        author: "orchestrator",
        authorWorkosId: null,
        kind: "comment",
        body: "Ready for the implementation step.",
        metadata: { runId: "run_1" },
        createdAt: "2026-07-29T09:02:12.001Z",
      },
      {
        id: "activity_user_comment",
        taskId: "workflow-task",
        author: "user",
        authorWorkosId: "user_1",
        kind: "comment",
        body: "Use the German launch date.",
        metadata: { runId: "run_2" },
        createdAt: "2026-07-29T09:02:13.000Z",
      },
    ];

    render(<TasksBoardRoute workflowNames={{}} />);
    await user.click(screen.getByRole("link", { name: "Open Prepare launch brief" }));

    const activity = within(screen.getByRole("dialog").querySelector("ol") as HTMLOListElement);
    expect(activity.getByText("Created")).toBeInTheDocument();
    expect(activity.getByText("Run started")).toBeInTheDocument();
    expect(activity.getByText("Run finished")).toBeInTheDocument();
    expect(activity.getByText("Orchestrator note")).toBeInTheDocument();
    expect(activity.getByText("You commented")).toBeInTheDocument();
    expect(activity.getAllByText(/Step 1\/2: Research/)).toHaveLength(2);
    expect(activity.getByText(/1m 12s/)).toBeInTheDocument();
    expect(activity.getByText("Research is complete.")).toBeInTheDocument();
    expect(activity.getByText("Ready for the implementation step.")).toBeInTheDocument();
    expect(activity.getByText("Use the German launch date.")).toBeInTheDocument();
    expect(
      activity.queryByText("This synthesized result should be hidden."),
    ).not.toBeInTheDocument();
  });

  it("shows only the created entry in the activity log for a freshly queued task", async () => {
    const user = userEvent.setup();
    appDataMock.taskRows = [
      taskRow({
        id: "queued",
        name: "Research the market",
        status: "queued",
        created_at: "2026-07-29T09:00:00.000Z",
        updated_at: "2026-07-29T09:00:00.000Z",
      }),
    ];

    render(<TasksBoardRoute workflowNames={{}} />);
    await user.click(screen.getByRole("link", { name: "Open Research the market" }));

    const sheet = screen.getByRole("dialog");
    const activity = within(sheet.querySelector("ol") as HTMLOListElement);
    expect(activity.getByText("Created")).toBeInTheDocument();
    expect(activity.getAllByRole("listitem")).toHaveLength(1);
  });

  it("shows a skeleton until the canonical live task dataset is ready", () => {
    appDataMock.tasksReady = false;

    render(<TasksBoardRoute workflowNames={{}} />);

    expect(screen.getByRole("status", { name: "Loading tasks" })).toBeInTheDocument();
    expect(screen.queryByText("No tasks yet")).not.toBeInTheDocument();
  });

  it("caps terminal columns and expands the remaining tasks on demand", async () => {
    const user = userEvent.setup();
    appDataMock.taskRows = Array.from({ length: TASK_BOARD_COLUMN_CAP + 2 }, (_, index) =>
      taskRow({
        id: `done-${index}`,
        name: `Completed task ${index + 1}`,
        status: "succeeded",
        updated_at: new Date(Date.UTC(2026, 6, 29, 10, 0, index)).toISOString(),
      }),
    );

    render(<TasksBoardRoute workflowNames={{}} />);

    const doneColumn = screen.getByRole("region", { name: "Done" });
    expect(within(doneColumn).getAllByRole("link")).toHaveLength(TASK_BOARD_COLUMN_CAP);
    expect(within(doneColumn).getByText(String(TASK_BOARD_COLUMN_CAP + 2))).toBeInTheDocument();
    await user.click(within(doneColumn).getByRole("button", { name: "Show 2 more" }));
    expect(within(doneColumn).getAllByRole("link")).toHaveLength(TASK_BOARD_COLUMN_CAP + 2);
  });

  it("offers short time ranges and applies them across every task state", async () => {
    const user = userEvent.setup();
    appDataMock.taskRows = [
      taskRow({
        id: "recent-running",
        name: "Recent in-progress task",
        status: "running",
        updated_at: "2026-07-28T00:00:00.000Z",
      }),
      taskRow({
        id: "recent-review",
        name: "Recent in-review task",
        status: "succeeded",
        reported_outcome: "needs_attention",
        updated_at: "2026-07-28T00:00:00.000Z",
      }),
      taskRow({
        id: "recent-done",
        name: "Recent done task",
        status: "succeeded",
        updated_at: "2026-07-28T00:00:00.000Z",
      }),
      taskRow({
        id: "recent-canceled",
        name: "Recent canceled task",
        status: "canceled",
        updated_at: "2026-07-28T00:00:00.000Z",
      }),
    ];

    render(<TasksBoardRoute workflowNames={{}} />);

    const timeRangeFilter = screen.getByRole("combobox", {
      name: "Filter tasks by time range",
    });
    expect(screen.getByText("Recent in-progress task")).toBeInTheDocument();
    expect(screen.getByText("Recent in-review task")).toBeInTheDocument();
    expect(screen.getByText("Recent done task")).toBeInTheDocument();
    expect(screen.getByText("Recent canceled task")).toBeInTheDocument();

    await user.click(timeRangeFilter);
    expect(await screen.findByRole("option", { name: "Last 24 hours" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Last 2 days" })).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Last 24 hours" }));

    expect(screen.queryByText("Recent in-progress task")).not.toBeInTheDocument();
    expect(screen.queryByText("Recent in-review task")).not.toBeInTheDocument();
    expect(screen.queryByText("Recent done task")).not.toBeInTheDocument();
    expect(screen.queryByText("Recent canceled task")).not.toBeInTheDocument();

    await waitFor(() => expect(timeRangeFilter).toHaveTextContent("Last 24 hours"));
    await user.click(timeRangeFilter);
    await user.click(await screen.findByRole("option", { name: "Last 2 days" }));

    expect(await screen.findByText("Recent in-progress task")).toBeInTheDocument();
    expect(screen.getByText("Recent in-review task")).toBeInTheDocument();
    expect(screen.getByText("Recent done task")).toBeInTheDocument();
    expect(screen.getByText("Recent canceled task")).toBeInTheDocument();
  });

  it("starts from the saved time range and persists changes", async () => {
    const user = userEvent.setup();

    render(<TasksBoardRoute workflowNames={{}} initialTimeRange="24h" />);

    const timeRangeFilter = screen.getByRole("combobox", {
      name: "Filter tasks by time range",
    });
    expect(timeRangeFilter).toHaveTextContent("Last 24 hours");

    await user.click(timeRangeFilter);
    await user.click(await screen.findByRole("option", { name: "All time" }));

    expect(timeRangeFilter).toHaveTextContent("All time");
    expect(updateTaskTimeRangeMock).toHaveBeenCalledWith("all");
  });

  it("reverts the time filter if persisting the preference fails", async () => {
    updateTaskTimeRangeMock.mockResolvedValueOnce({ ok: false, range: "24h" });
    const user = userEvent.setup();

    render(<TasksBoardRoute workflowNames={{}} />);

    const timeRangeFilter = screen.getByRole("combobox", {
      name: "Filter tasks by time range",
    });
    await user.click(timeRangeFilter);
    await user.click(await screen.findByRole("option", { name: "Last 24 hours" }));

    await waitFor(() => expect(timeRangeFilter).toHaveTextContent("Last 7 days"));
  });

  it("filters tasks by their workflow and keeps non-workflow tasks out of the result", async () => {
    const user = userEvent.setup();
    const workflowNames = {
      "ship-feature": "Ship feature",
      "morning-briefing": "Morning briefing",
    };
    appDataMock.taskRows = [
      taskRow({
        id: "ship-feature",
        name: "Add workflow filtering",
        status: "running",
        workflow_id: "ship-feature",
      }),
      taskRow({
        id: "morning-briefing",
        name: "Prepare the morning briefing",
        status: "running",
        workflow_id: "morning-briefing",
      }),
      taskRow({ id: "ad-hoc", name: "Research competitors", status: "running" }),
    ];

    const view = render(<TasksBoardRoute workflowNames={workflowNames} />);

    await user.click(screen.getByRole("combobox", { name: "Filter tasks by workflow" }));
    await user.click(await screen.findByRole("option", { name: "#Ship feature" }));

    expect(screen.getByText("Add workflow filtering")).toBeInTheDocument();
    expect(screen.queryByText("Prepare the morning briefing")).not.toBeInTheDocument();
    expect(screen.queryByText("Research competitors")).not.toBeInTheDocument();

    appDataMock.taskRows = appDataMock.taskRows.filter(
      (task) => task.workflow_id !== "ship-feature",
    );
    view.rerender(<TasksBoardRoute workflowNames={workflowNames} />);

    expect(screen.getByRole("combobox", { name: "Filter tasks by workflow" })).toHaveTextContent(
      "#Ship feature",
    );
    expect(screen.queryByText("Prepare the morning briefing")).not.toBeInTheDocument();
    expect(screen.queryByText("Research competitors")).not.toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: "Filter tasks by workflow" }));
    await user.click(await screen.findByRole("option", { name: "All tasks" }));

    expect(screen.getByText("Prepare the morning briefing")).toBeInTheDocument();
    expect(screen.getByText("Research competitors")).toBeInTheDocument();
  });

  it("offers workflow slugs from task history when the workflow is no longer active", async () => {
    const user = userEvent.setup();
    appDataMock.taskRows = [
      taskRow({
        id: "archived-workflow-run",
        name: "Historical workflow run",
        status: "running",
        workflow_id: "old-launch-flow",
      }),
    ];

    render(<TasksBoardRoute workflowNames={{}} />);

    await user.click(screen.getByRole("combobox", { name: "Filter tasks by workflow" }));
    expect(await screen.findByRole("option", { name: "#old-launch-flow" })).toBeInTheDocument();
  });

  it("shows the Tasks & Workflows beta gate when disabled", () => {
    appDataMock.featureFlags.taskSpawning = false;

    render(<TasksBoardRoute workflowNames={{}} />);

    expect(screen.getByText("Tasks & Workflows is a beta feature")).toBeInTheDocument();
  });

  it("switches to a grouped list view and persists the choice per user", async () => {
    const user = userEvent.setup();
    appDataMock.taskRows = [
      taskRow({
        id: "queued",
        name: "Research the market",
        status: "queued",
      }),
    ];

    render(<TasksBoardRoute workflowNames={{}} />);

    expect(screen.getByRole("radio", { name: "Board" })).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("radio", { name: "List" }));

    expect(screen.getByRole("radio", { name: "List" })).toHaveAttribute("aria-checked", "true");
    expect(
      within(screen.getByRole("region", { name: "In progress" })).getByText("Research the market"),
    ).toBeInTheDocument();
    expect(updateTaskViewModeMock).toHaveBeenCalledWith("list");
  });

  it("reverts the view toggle if persisting the preference fails", async () => {
    updateTaskViewModeMock.mockResolvedValueOnce({ ok: false, mode: "board" });
    const user = userEvent.setup();
    appDataMock.taskRows = [
      taskRow({ id: "queued", name: "Research the market", status: "queued" }),
    ];

    render(<TasksBoardRoute workflowNames={{}} />);

    await user.click(screen.getByRole("radio", { name: "List" }));

    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "Board" })).toHaveAttribute("aria-checked", "true"),
    );
  });
});

function taskRow(overrides: Partial<TaskRow> & Pick<TaskRow, "id" | "name" | "status">): TaskRow {
  return {
    id: overrides.id,
    display_id: overrides.display_id ?? `TASK-${overrides.id}`,
    name: overrides.name,
    user_workos_id: "user_1",
    workspace_id: overrides.workspace_id ?? "workspace_1",
    prompt: overrides.prompt ?? "Do the task.",
    model: "openai/gpt-5.2",
    session_id:
      "session_id" in overrides ? (overrides.session_id ?? null) : `goat_chat_${overrides.id}`,
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
