import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cronToScheduleDraft,
  describeCronSchedule,
  formatScheduleNextRun,
  type GoatTaskView,
  goatTaskBoardColumn,
  groupDoneTasks,
  scheduleDraftToCron,
} from "@/lib/task-board";

function taskView(overrides: Partial<GoatTaskView>): GoatTaskView {
  return {
    id: "goat_task_1",
    displayId: "TASK-1",
    name: "Test task",
    prompt: "Do the thing",
    model: "anthropic/claude-sonnet-4.6",
    scheduleId: null,
    scheduledFor: null,
    engine: "opencompany",
    status: "queued",
    result: null,
    error: null,
    archivedAt: null,
    createdAt: "2026-07-20T10:00:00.000Z",
    updatedAt: "2026-07-20T10:00:00.000Z",
    ...overrides,
  };
}

describe("goatTaskBoardColumn", () => {
  const now = new Date("2026-07-21T12:00:00.000Z");

  it("maps queued and running tasks to in_progress", () => {
    expect(goatTaskBoardColumn(taskView({ status: "queued" }), now)).toBe("in_progress");
    expect(goatTaskBoardColumn(taskView({ status: "running" }), now)).toBe("in_progress");
  });

  it("maps terminal statuses to done", () => {
    expect(goatTaskBoardColumn(taskView({ status: "succeeded" }), now)).toBe("done");
    expect(goatTaskBoardColumn(taskView({ status: "failed" }), now)).toBe("done");
    expect(goatTaskBoardColumn(taskView({ status: "canceled" }), now)).toBe("done");
  });

  it("hides archived tasks regardless of status", () => {
    expect(
      goatTaskBoardColumn(
        taskView({ status: "succeeded", archivedAt: "2026-07-21T00:00:00.000Z" }),
        now,
      ),
    ).toBe("archived");
  });

  it("keeps future-scheduled queued tasks in todo", () => {
    expect(
      goatTaskBoardColumn(
        taskView({ status: "queued", scheduledFor: "2026-07-22T09:00:00.000Z" }),
        now,
      ),
    ).toBe("todo");
    expect(
      goatTaskBoardColumn(
        taskView({ status: "queued", scheduledFor: "2026-07-21T09:00:00.000Z" }),
        now,
      ),
    ).toBe("in_progress");
  });
});

describe("schedule presets", () => {
  it("builds cron expressions from drafts", () => {
    expect(
      scheduleDraftToCron({ preset: "daily", time: "09:30", weekday: 1, dayOfMonth: 1, cron: "" }),
    ).toBe("30 9 * * *");
    expect(
      scheduleDraftToCron({
        preset: "weekdays",
        time: "08:00",
        weekday: 1,
        dayOfMonth: 1,
        cron: "",
      }),
    ).toBe("0 8 * * 1-5");
    expect(
      scheduleDraftToCron({ preset: "weekly", time: "17:15", weekday: 5, dayOfMonth: 1, cron: "" }),
    ).toBe("15 17 * * 5");
    expect(
      scheduleDraftToCron({
        preset: "monthly",
        time: "07:00",
        weekday: 1,
        dayOfMonth: 15,
        cron: "",
      }),
    ).toBe("0 7 15 * *");
    expect(
      scheduleDraftToCron({
        preset: "custom",
        time: "09:00",
        weekday: 1,
        dayOfMonth: 1,
        cron: " */5 * * * * ",
      }),
    ).toBe("*/5 * * * *");
  });

  it("round-trips preset drafts through cron", () => {
    for (const draft of [
      { preset: "daily", time: "09:30", weekday: 1, dayOfMonth: 1, cron: "" },
      { preset: "weekdays", time: "08:00", weekday: 1, dayOfMonth: 1, cron: "" },
      { preset: "weekly", time: "17:15", weekday: 5, dayOfMonth: 1, cron: "" },
      { preset: "monthly", time: "07:00", weekday: 1, dayOfMonth: 15, cron: "" },
    ] as const) {
      const cron = scheduleDraftToCron(draft);
      const parsed = cronToScheduleDraft(cron);
      expect(parsed.preset).toBe(draft.preset);
      expect(parsed.time).toBe(draft.time);
      if (draft.preset === "weekly") expect(parsed.weekday).toBe(draft.weekday);
      if (draft.preset === "monthly") expect(parsed.dayOfMonth).toBe(draft.dayOfMonth);
    }
  });

  it("falls back to custom for unrecognized expressions", () => {
    expect(cronToScheduleDraft("*/5 * * * *").preset).toBe("custom");
    expect(cronToScheduleDraft("0 9 1 1 *").preset).toBe("custom");
    expect(cronToScheduleDraft("not a cron").preset).toBe("custom");
  });

  it("describes recognized schedules in plain language", () => {
    expect(describeCronSchedule("30 9 * * *")).toBe("Every day at 09:30");
    expect(describeCronSchedule("0 8 * * 1-5")).toBe("Weekdays at 08:00");
    expect(describeCronSchedule("15 17 * * 1")).toBe("Every Mon at 17:15");
    expect(describeCronSchedule("0 7 15 * *")).toBe("Monthly on day 15 at 07:00");
    expect(describeCronSchedule("*/5 * * * *")).toBe("Cron: */5 * * * *");
  });
});

describe("formatScheduleNextRun", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("formats minutes, hours, and days", () => {
    expect(formatScheduleNextRun("2026-07-21T12:30:00.000Z")).toBe("Next in 30m");
    expect(formatScheduleNextRun("2026-07-21T18:00:00.000Z")).toBe("Next in 6h");
    expect(formatScheduleNextRun("2026-07-25T12:00:00.000Z")).toBe("Next in 4d");
    expect(formatScheduleNextRun("garbage")).toBe("Next run unknown");
  });
});

describe("groupDoneTasks", () => {
  it("keeps one-offs separate and collapses occurrences per schedule", () => {
    const groups = groupDoneTasks([
      taskView({ id: "t1", status: "succeeded", updatedAt: "2026-07-21T10:00:00.000Z" }),
      taskView({
        id: "t2",
        status: "succeeded",
        scheduleId: "s1",
        updatedAt: "2026-07-21T11:00:00.000Z",
      }),
      taskView({
        id: "t3",
        status: "failed",
        scheduleId: "s1",
        updatedAt: "2026-07-20T11:00:00.000Z",
      }),
      taskView({
        id: "t4",
        status: "succeeded",
        scheduleId: "s1",
        updatedAt: "2026-07-19T11:00:00.000Z",
      }),
    ]);

    expect(groups.map((group) => group.latest.id)).toEqual(["t2", "t1"]);
    expect(groups[0]?.older.map((task) => task.id)).toEqual(["t3", "t4"]);
    expect(groups[1]?.older).toEqual([]);
  });
});
