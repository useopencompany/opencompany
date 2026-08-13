import type { GoatHarnessSpec } from "@opencompany/goat-agent/task-runtime-types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGoatTaskScheduleForUser } from "@/lib/task-schedules";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  planGoatTaskHarness: vi.fn(),
  select: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: () => ({
    execute: mocks.execute,
    select: mocks.select,
    transaction: mocks.transaction,
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
  engine: "opencompany",
  model: "moonshotai/kimi-k2.6",
  systemPrompt: "Run this recurring task.",
  initialUserMessage: "Send a daily briefing.",
  tools: ["exa_search"],
  skills: [],
  maxModelSteps: 8,
  resultMode: "assistant_final",
};

describe("createGoatTaskScheduleForUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.planGoatTaskHarness.mockResolvedValue(harnessSpec);
    mocks.transaction.mockImplementation(() => {
      throw new Error("No transactions support in neon-http driver");
    });
    mocks.select.mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [{ enabled: true }]),
        })),
      })),
    });
    mocks.execute.mockResolvedValue([{ id: "goat_task_schedule_1" }]);
  });

  it("plans and stores a recurring task schedule", async () => {
    const schedule = await createGoatTaskScheduleForUser({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
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
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(mocks.transaction).not.toHaveBeenCalled();
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
        workspaceId: "workspace_1",
        name: "Bad",
        cron: "0 0 9 * * *",
        timezone: "UTC",
        prompt: "Run.",
      }),
    ).rejects.toThrow("valid 5-field cron");
    expect(mocks.planGoatTaskHarness).not.toHaveBeenCalled();
  });

  it("rejects schedule creation when Tasks & Workflows is disabled", async () => {
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
        workspaceId: "workspace_1",
        name: "Daily briefing",
        cron: "0 9 * * *",
        timezone: "UTC",
        prompt: "Send a daily briefing.",
      }),
    ).rejects.toThrow("Tasks & Workflows is disabled");
    expect(mocks.planGoatTaskHarness).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("re-checks the flag under a row lock in the atomic insert", async () => {
    mocks.execute.mockResolvedValue([]);

    await expect(
      createGoatTaskScheduleForUser({
        userWorkosId: "user_1",
        workspaceId: "workspace_1",
        name: "Daily briefing",
        cron: "0 9 * * *",
        timezone: "UTC",
        prompt: "Send a daily briefing.",
      }),
    ).rejects.toThrow("Tasks & Workflows is disabled");
    expect(mocks.planGoatTaskHarness).toHaveBeenCalledOnce();
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(sqlTextFromExecuteCall(0)).toContain("task_user.task_spawning_enabled = true");
    expect(sqlTextFromExecuteCall(0)).toContain("member.workspace_id");
    expect(sqlTextFromExecuteCall(0)).toContain("FOR UPDATE OF task_user");
  });
});

function sqlTextFromExecuteCall(callIndex: number) {
  const query = mocks.execute.mock.calls[callIndex]?.[0] as
    | { queryChunks?: Array<string | { value?: string[] }> }
    | undefined;
  return (
    query?.queryChunks
      ?.map((chunk) =>
        typeof chunk === "string" ? "?" : ((chunk?.value ?? []) as string[]).join(""),
      )
      .join("") ?? ""
  );
}
