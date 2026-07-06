import type { GoatHarnessSpec } from "@opencompany/db/goat-schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGoatTaskScheduleForUser } from "@/lib/task-schedules";

const mocks = vi.hoisted(() => ({
  insert: vi.fn(),
  planGoatTaskHarness: vi.fn(),
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: () => ({
    insert: mocks.insert,
  }),
}));

vi.mock("@/lib/auth", () => ({
  currentGoatUser: vi.fn(),
}));

vi.mock("@/lib/task-runner", () => ({
  planGoatTaskHarness: mocks.planGoatTaskHarness,
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

describe("createGoatTaskScheduleForUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.planGoatTaskHarness.mockResolvedValue(harnessSpec);
    mocks.insert.mockReturnValue({
      values: vi.fn(() => ({
        returning: vi.fn(async () => [
          {
            id: "goat_task_schedule_1",
            userWorkosId: "user_1",
            name: "Daily briefing",
            sourceDescription: "daily at 9",
            cron: "0 9 * * *",
            timezone: "America/Los_Angeles",
            prompt: "Send a daily briefing.",
            plannedHarnessSpec: harnessSpec,
            enabled: true,
            lastRunAt: null,
            nextRunAt: new Date("2026-06-01T16:00:00.000Z"),
            deletedAt: null,
            createdAt: new Date("2026-06-01T00:00:00.000Z"),
            updatedAt: new Date("2026-06-01T00:00:00.000Z"),
          },
        ]),
      })),
    });
  });

  it("plans and stores a recurring task schedule", async () => {
    const schedule = await createGoatTaskScheduleForUser({
      userWorkosId: "user_1",
      name: "Daily briefing",
      sourceDescription: "daily at 9",
      cron: "0 9 * * *",
      timezone: "America/Los_Angeles",
      prompt: "Send a daily briefing.",
      now: new Date("2026-06-01T15:00:00.000Z"),
    });

    expect(mocks.planGoatTaskHarness).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      prompt: "Send a daily briefing.",
    });
    expect(mocks.insert).toHaveBeenCalledOnce();
    expect(schedule).toMatchObject({
      id: "goat_task_schedule_1",
      plannedHarnessSpec: harnessSpec,
      nextRunAt: new Date("2026-06-01T16:00:00.000Z"),
    });
  });

  it("rejects invalid cron expressions", async () => {
    await expect(
      createGoatTaskScheduleForUser({
        userWorkosId: "user_1",
        name: "Bad",
        cron: "0 0 9 * * *",
        timezone: "UTC",
        prompt: "Run.",
      }),
    ).rejects.toThrow("valid 5-field cron");
    expect(mocks.planGoatTaskHarness).not.toHaveBeenCalled();
  });
});
