import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGoatTaskScheduleForUser } from "@/lib/task-schedules";

const mocks = vi.hoisted(() => ({
  insert: vi.fn(),
  select: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: () => ({
    select: mocks.select,
    transaction: mocks.transaction,
  }),
}));

vi.mock("@/lib/auth", () => ({
  currentGoatUser: vi.fn(),
}));

describe("createGoatTaskScheduleForUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(async (callback) =>
      callback({ insert: mocks.insert, select: mocks.select }),
    );
    mocks.select.mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [{ enabled: true }]),
        })),
      })),
    });
    mocks.select.mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => ({
            for: vi.fn(async () => [{ enabled: true }]),
          })),
        })),
      })),
    });
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
            plannedHarnessSpec: null,
            model: "anthropic/claude-sonnet-5",
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

  it("stores a recurring task schedule with its occurrence model", async () => {
    const schedule = await createGoatTaskScheduleForUser({
      userWorkosId: "user_1",
      name: "Daily briefing",
      sourceDescription: "daily at 9",
      cron: "0 9 * * *",
      timezone: "America/Los_Angeles",
      prompt: "Send a daily briefing.",
      model: "anthropic/claude-sonnet-5",
      now: new Date("2026-06-01T15:00:00.000Z"),
    });

    expect(mocks.insert).toHaveBeenCalledOnce();
    expect(schedule).toMatchObject({
      id: "goat_task_schedule_1",
      model: "anthropic/claude-sonnet-5",
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
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("rejects schedule creation when background tasks are disabled", async () => {
    mocks.select.mockReset();
    mocks.select.mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [{ enabled: false }]),
        })),
      })),
    });

    await expect(
      createGoatTaskScheduleForUser({
        userWorkosId: "user_1",
        name: "Daily briefing",
        cron: "0 9 * * *",
        timezone: "UTC",
        prompt: "Send a daily briefing.",
      }),
    ).rejects.toThrow("Background tasks are disabled");
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("re-checks the flag under a row lock before inserting a schedule", async () => {
    mocks.select.mockReset();
    mocks.select
      .mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => [{ enabled: true }]),
          })),
        })),
      })
      .mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => ({
              for: vi.fn(async () => [{ enabled: false }]),
            })),
          })),
        })),
      });

    await expect(
      createGoatTaskScheduleForUser({
        userWorkosId: "user_1",
        name: "Daily briefing",
        cron: "0 9 * * *",
        timezone: "UTC",
        prompt: "Send a daily briefing.",
      }),
    ).rejects.toThrow("Background tasks are disabled");
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});
