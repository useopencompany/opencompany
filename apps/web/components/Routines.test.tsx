import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskScheduleView } from "@/lib/headless-automation-types";
import { Routines } from "./Routines";

const routerMock = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
const commandMocks = vi.hoisted(() => ({
  archiveSchedule: vi.fn(async () => ({})),
  runSchedule: vi.fn(async () => ({ task: { displayId: "TASK-1" } })),
  updateSchedule: vi.fn(async () => ({})),
}));
const toastMock = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

vi.mock("@/lib/headless-automation-commands", () => ({
  archiveHeadlessTaskSchedule: commandMocks.archiveSchedule,
  runHeadlessTaskScheduleNow: commandMocks.runSchedule,
  updateHeadlessTaskSchedule: commandMocks.updateSchedule,
}));

vi.mock("@opencompany/ui/components/sonner", () => ({
  toast: Object.assign(vi.fn(), toastMock),
}));

function scheduleView(overrides: Partial<TaskScheduleView> = {}): TaskScheduleView {
  return {
    id: "schedule_1",
    name: "Monday update",
    sourceDescription: "Every Monday",
    cron: "0 9 * * 1",
    timezone: "Europe/Berlin",
    prompt: "Prepare the weekly update",
    enabled: true,
    version: 4,
    lastRunAt: null,
    nextRunAt: "2026-07-20T07:00:00.000Z",
    createdAt: "2026-07-01T07:00:00.000Z",
    updatedAt: "2026-07-01T07:00:00.000Z",
    ...overrides,
  };
}

describe("Routines", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("pauses a routine through the versioned schedule command", async () => {
    const user = userEvent.setup();
    render(<Routines schedules={[scheduleView()]} workspaceId="workspace_1" />);

    await user.click(screen.getByRole("button", { name: "Pause Monday update" }));

    await waitFor(() =>
      expect(commandMocks.updateSchedule).toHaveBeenCalledWith(
        "schedule_1",
        { expectedVersion: 4, enabled: false },
        { scopeKey: "workspace_1" },
      ),
    );
  });

  it("offers resume instead of pause for a paused routine", () => {
    render(<Routines schedules={[scheduleView({ enabled: false })]} workspaceId="workspace_1" />);

    expect(screen.getByRole("button", { name: "Resume Monday update" })).toBeInTheDocument();
    expect(screen.getByText("Paused")).toBeInTheDocument();
  });

  it("lists the soonest next run first", () => {
    render(
      <Routines
        schedules={[
          scheduleView({
            id: "schedule_later",
            name: "Friday report",
            nextRunAt: "2026-07-24T07:00:00.000Z",
          }),
          scheduleView({ id: "schedule_sooner", name: "Monday update" }),
        ]}
        workspaceId="workspace_1"
      />,
    );

    const names = screen
      .getAllByText(/Monday update|Friday report/)
      .map((node) => node.textContent);
    expect(names).toEqual(["Monday update", "Friday report"]);
  });

  it("surfaces a failed update instead of silently dropping it", async () => {
    const user = userEvent.setup();
    commandMocks.updateSchedule.mockRejectedValueOnce(new Error("Schedule is out of date."));
    render(<Routines schedules={[scheduleView()]} workspaceId="workspace_1" />);

    await user.click(screen.getByRole("button", { name: "Pause Monday update" }));

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith("Schedule is out of date."));
  });
});
