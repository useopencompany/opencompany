import { PGlite } from "@electric-sql/pglite";
import type { GoatHarnessSpec } from "@opencompany/db/schema";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sweepDueGoatTaskSchedules } from "./scheduler";

const mocks = vi.hoisted(() => ({
  captureGoatTaskSpawned: vi.fn(async () => undefined),
  captureException: vi.fn(),
  db: undefined as
    | undefined
    | {
        transaction: <T>(
          callback: (tx: { execute(query: SQL): Promise<unknown> }) => Promise<T>,
        ) => Promise<T>;
      },
  transaction: vi.fn(),
}));

vi.mock("@opencompany/analytics/goat/server", () => ({
  captureGoatTaskSpawned: mocks.captureGoatTaskSpawned,
}));

vi.mock("@opencompany/observability", () => ({
  captureException: mocks.captureException,
}));

vi.mock("./db", () => ({
  getDb: () =>
    mocks.db ?? {
      transaction: mocks.transaction,
    },
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
    mocks.db = undefined;
  });

  it("claims a due schedule through the users join without ambiguous timezone columns", async () => {
    const pg = await PGlite.create();
    try {
      await pg.exec(`
        CREATE SCHEMA goat;

        CREATE TABLE goat.users (
          workos_user_id text PRIMARY KEY,
          email text NOT NULL,
          timezone text NOT NULL DEFAULT 'UTC',
          task_spawning_enabled boolean NOT NULL DEFAULT false
        );

        CREATE TABLE goat.task_schedules (
          id text PRIMARY KEY,
          user_workos_id text NOT NULL,
          name text NOT NULL,
          cron text NOT NULL,
          timezone text NOT NULL DEFAULT 'UTC',
          prompt text NOT NULL,
          planned_harness_spec jsonb NOT NULL,
          enabled boolean NOT NULL DEFAULT true,
          last_run_at timestamptz,
          next_run_at timestamptz NOT NULL,
          deleted_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );

        CREATE TABLE goat.task_schedule_runs (
          id text PRIMARY KEY,
          schedule_id text NOT NULL,
          user_workos_id text NOT NULL,
          scheduled_for timestamptz NOT NULL,
          task_id text,
          status text NOT NULL DEFAULT 'pending',
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          UNIQUE (schedule_id, scheduled_for)
        );

        CREATE TABLE goat.workflows (
          id text PRIMARY KEY,
          workspace_id text NOT NULL,
          slug text NOT NULL,
          schedule_user_workos_id text,
          name text NOT NULL,
          schedule_cron text,
          schedule_timezone text NOT NULL DEFAULT 'UTC',
          schedule_prompt text NOT NULL DEFAULT '',
          schedule_harness_spec jsonb,
          schedule_next_run_at timestamptz,
          trigger text NOT NULL DEFAULT 'manual',
          schedule_enabled boolean NOT NULL DEFAULT false,
          status text NOT NULL DEFAULT 'active',
          archived_at timestamptz,
          updated_at timestamptz NOT NULL DEFAULT now()
        );

        CREATE TABLE goat.workspace_members (
          workspace_id text NOT NULL,
          user_workos_id text NOT NULL
        );
      `);
      await pg.query(
        `
          INSERT INTO goat.users (workos_user_id, email, timezone, task_spawning_enabled)
          VALUES ('user_1', 'founder@example.com', 'Europe/Amsterdam', true);
        `,
      );
      await pg.query(
        `
          INSERT INTO goat.task_schedules (
            id,
            user_workos_id,
            name,
            cron,
            timezone,
            prompt,
            planned_harness_spec,
            next_run_at,
            created_at,
            updated_at
          )
          VALUES (
            'goat_task_schedule_1',
            'user_1',
            'Daily briefing',
            '0 9 * * *',
            'UTC',
            'Send a daily briefing.',
            $1::jsonb,
            '2026-06-01T09:00:00.000Z',
            '2026-06-01T08:00:00.000Z',
            '2026-06-01T08:00:00.000Z'
          );
        `,
        [JSON.stringify(harnessSpec)],
      );
      await pg.query(
        `
          INSERT INTO goat.task_schedule_runs (
            id,
            schedule_id,
            user_workos_id,
            scheduled_for,
            status,
            created_at,
            updated_at
          )
          VALUES (
            'goat_task_schedule_run_existing',
            'goat_task_schedule_1',
            'user_1',
            '2026-06-03T09:00:00.000Z',
            'created',
            '2026-06-03T09:00:00.000Z',
            '2026-06-03T09:00:00.000Z'
          );
        `,
      );
      mocks.db = {
        transaction: (callback) =>
          pg.transaction((tx) =>
            callback({
              execute: async (query) => {
                const { text, params } = pgliteQueryFromDrizzleSql(query);
                return tx.query(text, params);
              },
            }),
          ),
      };

      await expect(
        sweepDueGoatTaskSchedules({ now: new Date("2026-06-03T12:00:00.000Z") }),
      ).resolves.toEqual({ checked: 1, created: 0 });

      const schedule = await pg.query<{ next_run_at: string }>(
        "SELECT next_run_at FROM goat.task_schedules WHERE id = 'goat_task_schedule_1'",
      );
      const updatedSchedule = schedule.rows[0];
      expect(updatedSchedule).toBeDefined();
      expect(new Date(updatedSchedule!.next_run_at).toISOString()).toBe("2026-06-04T09:00:00.000Z");
    } finally {
      mocks.db = undefined;
      await pg.close();
    }
  }, 15_000);

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

function pgliteQueryFromDrizzleSql(query: SQL) {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  const params: unknown[] = [];
  let text = "";

  for (const chunk of chunks) {
    if (chunk && typeof chunk === "object" && "value" in chunk) {
      text += ((chunk as { value?: string[] }).value ?? []).join("");
    } else {
      params.push(chunk);
      text += `$${params.length}`;
    }
  }

  return { text, params };
}
