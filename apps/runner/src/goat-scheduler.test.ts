import type { GoatHarnessSpec } from "@opencompany/db/goat-schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sweepDueGoatTaskSchedules } from "./goat-scheduler";

const mocks = vi.hoisted(() => ({
  captureGoatTaskSpawned: vi.fn(async () => undefined),
  transaction: vi.fn(),
}));

vi.mock("@opencompany/analytics/goat/server", () => ({
  captureGoatTaskSpawned: mocks.captureGoatTaskSpawned,
}));

vi.mock("./db", () => ({
  getDb: () => ({
    transaction: mocks.transaction,
  }),
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
      .mockResolvedValueOnce([
        {
          id: "goat_task_1",
          displayId: "TASK-1",
          name: "Daily briefing",
          userWorkosId: "user_1",
          prompt: "Send a daily briefing.",
          model: harnessSpec.model,
          sessionId: "goat_chat_1",
          scheduleId: "goat_task_schedule_1",
          scheduledFor: new Date("2026-06-03T09:00:00.000Z"),
          status: "queued",
          stage: "queued",
          result: null,
          error: null,
          workflowId: null,
          workflowBrainRef: null,
          reportedOutcome: null,
          outcomeComment: null,
          harnessSpec,
          debugTrace: {},
          codexEngineSessionId: null,
          sandboxId: null,
          attempts: 0,
          nextRunAt: new Date("2026-06-03T12:00:00.000Z"),
          leaseId: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          archivedAt: null,
          createdAt: new Date("2026-06-03T12:00:00.000Z"),
          updatedAt: new Date("2026-06-03T12:00:00.000Z"),
        },
      ])
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
    expect(mocks.captureGoatTaskSpawned).toHaveBeenCalledWith(
      expect.objectContaining({
        userWorkosId: "user_1",
        workspaceId: null,
        taskId: "goat_task_1",
        displayId: "TASK-1",
        engine: "opencompany",
        model: harnessSpec.model,
        workflowId: null,
        scheduleId: "goat_task_schedule_1",
        trigger: "schedule",
      }),
    );
    expect(sqlTextFromExecuteCall(execute, 0)).toContain("task_spawning_enabled");
    expect(sqlTextFromExecuteCall(execute, 2)).toContain("INSERT INTO goat.chat_sessions");
    expect(sqlTextFromExecuteCall(execute, 2)).toContain("INSERT INTO goat.codex_chat_turns");
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
    expect(execute).toHaveBeenCalledTimes(5);
    expect(mocks.captureGoatTaskSpawned).not.toHaveBeenCalled();
  });

  it("creates a workflow task for a due workflow schedule", async () => {
    const workflowHarnessSpec: GoatHarnessSpec = {
      ...harnessSpec,
      initialUserMessage: "Task: Weekly update\n\nDraft the weekday update.",
      workflow: {
        id: "weekly-update",
        workspaceId: "workspace_1",
        skillIds: [],
        steps: [],
        currentStepIndex: 0,
        completedStepCount: 0,
      },
    };
    const execute = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "goat_workflow_1",
          workspaceId: "workspace_1",
          slug: "weekly-update",
          userWorkosId: "user_1",
          name: "Weekly update",
          cron: "0 9 * * *",
          timezone: "UTC",
          prompt: "Draft the weekday update.",
          scheduleHarnessSpec: workflowHarnessSpec,
          nextRunAt: new Date("2026-06-01T09:00:00.000Z"),
        },
      ])
      .mockResolvedValueOnce([{ id: "goat_workflow_schedule_run_1" }])
      .mockResolvedValueOnce([
        {
          id: "goat_task_1",
          displayId: "TASK-1",
          name: "Weekly update",
          userWorkosId: "user_1",
          prompt: "Draft the weekday update.",
          model: workflowHarnessSpec.model,
          sessionId: "goat_chat_1",
          scheduleId: null,
          scheduledFor: new Date("2026-06-03T09:00:00.000Z"),
          status: "queued",
          stage: "queued",
          result: null,
          error: null,
          workflowId: "weekly-update",
          workflowBrainRef: null,
          reportedOutcome: null,
          outcomeComment: null,
          harnessSpec: workflowHarnessSpec,
          debugTrace: {},
          codexEngineSessionId: null,
          sandboxId: null,
          attempts: 0,
          nextRunAt: new Date("2026-06-03T12:00:00.000Z"),
          leaseId: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          archivedAt: null,
          createdAt: new Date("2026-06-03T12:00:00.000Z"),
          updatedAt: new Date("2026-06-03T12:00:00.000Z"),
        },
      ])
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
    expect(mocks.captureGoatTaskSpawned).toHaveBeenCalledWith(
      expect.objectContaining({
        userWorkosId: "user_1",
        workspaceId: "workspace_1",
        taskId: "goat_task_1",
        displayId: "TASK-1",
        engine: "opencompany",
        model: workflowHarnessSpec.model,
        workflowId: "weekly-update",
        scheduleId: null,
        trigger: "schedule",
      }),
    );
    expect(sqlTextFromExecuteCall(execute, 1)).toContain("FROM goat.workflows");
    expect(sqlTextFromExecuteCall(execute, 3)).toContain("INSERT INTO goat.chat_sessions");
    expect(sqlTextFromExecuteCall(execute, 3)).toContain("workflow_id");
    expect(sqlTextFromExecuteCall(execute, 4)).toContain("UPDATE goat.workflow_schedule_runs");
  });
});

function sqlTextFromExecuteCall(execute: ReturnType<typeof vi.fn>, callIndex: number) {
  const query = execute.mock.calls[callIndex]?.[0] as
    | { queryChunks?: Array<string | { value?: string[] }> }
    | undefined;
  return (
    query?.queryChunks
      ?.map((chunk) => (typeof chunk === "string" ? "?" : (chunk?.value ?? []).join("")))
      .join("") ?? ""
  );
}
