import type { GoatHarnessSpec } from "@opencompany/db/goat-schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sweepDueGoatTaskSchedules } from "./goat-scheduler";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
}));

vi.mock("./db", () => ({
  getDb: () => ({
    transaction: mocks.transaction,
  }),
}));

const harnessSpec: GoatHarnessSpec = {
  schemaVersion: "goat.harness.v1",
  model: "moonshotai/kimi-k2.6",
  systemPrompt: "Run this recurring task.",
  initialUserMessage: "Send a daily briefing.",
  tools: ["exa_search"],
  maxModelSteps: 8,
  resultMode: "assistant_final",
};

describe("sweepDueGoatTaskSchedules", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a separate queued task for a due schedule", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: "goat_task_schedule_1",
          userWorkosId: "user_1",
          name: "Daily briefing",
          cron: "0 9 * * *",
          timezone: "UTC",
          prompt: "Send a daily briefing.",
          plannedHarnessSpec: harnessSpec,
          nextRunAt: new Date("2026-06-01T09:00:00.000Z"),
        },
      ])
      .mockResolvedValueOnce([{ id: "goat_task_schedule_run_1" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mocks.transaction.mockImplementation(async (callback) => callback({ execute }));

    const onTaskCreated = vi.fn();
    await expect(
      sweepDueGoatTaskSchedules({
        now: new Date("2026-06-03T12:00:00.000Z"),
        onTaskCreated,
      }),
    ).resolves.toEqual({ checked: 1, created: 1 });

    expect(onTaskCreated).toHaveBeenCalledOnce();
    expect(sqlTextFromExecuteCall(execute, 2)).toContain("INSERT INTO goat.tasks");
    expect(sqlTextFromExecuteCall(execute, 2)).toContain("INSERT INTO goat.task_messages");
  });

  it("skips duplicate schedule runs without creating another task", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: "goat_task_schedule_1",
          userWorkosId: "user_1",
          name: "Daily briefing",
          cron: "0 9 * * *",
          timezone: "UTC",
          prompt: "Send a daily briefing.",
          plannedHarnessSpec: harnessSpec,
          nextRunAt: new Date("2026-06-01T09:00:00.000Z"),
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mocks.transaction.mockImplementation(async (callback) => callback({ execute }));

    await expect(
      sweepDueGoatTaskSchedules({ now: new Date("2026-06-03T12:00:00.000Z") }),
    ).resolves.toEqual({ checked: 1, created: 0 });

    expect(sqlTextFromExecuteCall(execute, 2)).toContain("UPDATE goat.task_schedules");
    expect(execute).toHaveBeenCalledTimes(4);
  });
});

function sqlTextFromExecuteCall(execute: ReturnType<typeof vi.fn>, callIndex: number) {
  const query = execute.mock.calls[callIndex]?.[0] as
    | { queryChunks?: Array<string | { value?: string[] }> }
    | undefined;
  return (
    query?.queryChunks
      ?.map((chunk) => (typeof chunk === "string" ? "?" : (chunk.value ?? []).join("")))
      .join("") ?? ""
  );
}
