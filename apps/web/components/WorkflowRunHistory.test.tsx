import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskView } from "@/components/Surface";
import { WorkflowRunHistory } from "./WorkflowRunHistory";

const appDataMock = vi.hoisted(() => ({
  tasks: [] as TaskView[],
  tasksReady: true,
}));

vi.mock("@/components/AppDataProvider", () => ({
  useAppData: () => appDataMock,
}));

vi.mock("@/components/Routes", () => ({
  formatRelativeTime: () => "2m ago",
}));

// Two and a half minutes of work, so a settled run renders a "2m 30s" duration.
function run(overrides: Partial<TaskView> & Pick<TaskView, "id">): TaskView {
  return {
    displayId: overrides.id.toUpperCase(),
    name: "Weekly investor update",
    prompt: "Write the weekly investor update",
    model: "gpt-5",
    sessionId: null,
    scheduleId: null,
    scheduledFor: null,
    workflowId: "investor-update",
    status: "succeeded",
    stage: "completed",
    result: null,
    error: null,
    reportedOutcome: null,
    outcomeComment: null,
    archivedAt: null,
    createdAt: "2026-07-29T09:00:00.000Z",
    updatedAt: "2026-07-29T09:02:30.000Z",
    ...overrides,
  };
}

describe("WorkflowRunHistory", () => {
  afterEach(() => {
    appDataMock.tasks = [];
    appDataMock.tasksReady = true;
  });

  it("lists only this workflow's runs, newest first", () => {
    appDataMock.tasks = [
      run({ id: "task_old", createdAt: "2026-07-27T09:00:00.000Z", name: "Older run" }),
      run({ id: "task_new", createdAt: "2026-07-29T09:00:00.000Z", name: "Newer run" }),
      run({ id: "task_other", workflowId: "standup-digest", name: "Another workflow" }),
    ];

    render(<WorkflowRunHistory workflowSlug="investor-update" />);

    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Newer run");
    expect(rows[1]).toHaveTextContent("Older run");
    expect(screen.queryByText("Another workflow")).not.toBeInTheDocument();
  });

  it("shows the outcome note, duration and a link to the run", () => {
    appDataMock.tasks = [run({ id: "task_1", outcomeComment: "Sent the update to 4 investors." })];

    render(<WorkflowRunHistory workflowSlug="investor-update" />);

    const row = screen.getByRole("listitem");
    expect(within(row).getByText("Sent the update to 4 investors.")).toBeInTheDocument();
    expect(within(row).getByText("2m 30s")).toBeInTheDocument();
    expect(within(row).getByRole("link")).toHaveAttribute("href", "/tasks/TASK_1");
  });

  it("falls back to the failure when a run left no note", () => {
    appDataMock.tasks = [
      run({ id: "task_failed", status: "failed", error: "The Slack post was rejected." }),
    ];

    render(<WorkflowRunHistory workflowSlug="investor-update" />);

    expect(screen.getByText("The Slack post was rejected.")).toBeInTheDocument();
  });

  it("falls back to the status, and omits a duration, while a run is still going", () => {
    appDataMock.tasks = [run({ id: "task_running", status: "running" })];

    render(<WorkflowRunHistory workflowSlug="investor-update" />);

    const row = screen.getByRole("listitem");
    expect(within(row).getByText("Running")).toBeInTheDocument();
    expect(within(row).queryByText("2m 30s")).not.toBeInTheDocument();
  });

  it("marks runs a schedule started", () => {
    appDataMock.tasks = [
      run({ id: "task_scheduled", scheduledFor: "2026-07-29T09:00:00.000Z" }),
      run({ id: "task_manual", createdAt: "2026-07-28T09:00:00.000Z" }),
    ];

    render(<WorkflowRunHistory workflowSlug="investor-update" />);

    const rows = screen.getAllByRole("listitem");
    expect(within(rows[0]!).getByText("Scheduled")).toBeInTheDocument();
    expect(within(rows[1]!).queryByText("Scheduled")).not.toBeInTheDocument();
  });

  it("reveals older runs a page at a time and links to the filtered Tasks board", async () => {
    const user = userEvent.setup();
    appDataMock.tasks = Array.from({ length: 11 }, (_, index) =>
      run({
        id: `task_${index}`,
        name: `Run ${index}`,
        createdAt: new Date(Date.UTC(2026, 6, 29, 9, index)).toISOString(),
      }),
    );

    render(<WorkflowRunHistory workflowSlug="investor-update" />);

    expect(screen.getAllByRole("listitem")).toHaveLength(8);
    expect(screen.getByRole("link", { name: "All runs" })).toHaveAttribute(
      "href",
      "/tasks?workflow=investor-update",
    );

    await user.click(screen.getByRole("button", { name: "Show 3 more" }));

    expect(screen.getAllByRole("listitem")).toHaveLength(11);
    expect(screen.queryByRole("button", { name: /Show/ })).not.toBeInTheDocument();
  });

  it("invites a first run when the workflow has none", () => {
    render(<WorkflowRunHistory workflowSlug="investor-update" />);

    expect(screen.getByText(/No runs yet/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "All runs" })).not.toBeInTheDocument();
  });

  it("holds the empty state back until live runs have loaded", () => {
    appDataMock.tasksReady = false;

    render(<WorkflowRunHistory workflowSlug="investor-update" />);

    expect(screen.queryByText(/No runs yet/)).not.toBeInTheDocument();
  });
});
