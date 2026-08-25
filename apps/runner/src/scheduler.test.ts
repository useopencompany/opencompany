import { PGlite } from "@electric-sql/pglite";
import type { HarnessSpec } from "@opencompany/db/product-schema";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sweepDueTaskSchedules } from "./scheduler";

const mocks = vi.hoisted(() => ({
  captureProductTaskSpawned: vi.fn(async () => undefined),
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

vi.mock("@opencompany/analytics/product/server", () => ({
  captureProductTaskSpawned: mocks.captureProductTaskSpawned,
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

const harnessSpec: HarnessSpec = {
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

describe("sweepDueTaskSchedules", () => {
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
          workspace_id text,
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
          user_workos_id text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        );
      `);
      await pg.query(
        `
          INSERT INTO goat.users (workos_user_id, email, timezone, task_spawning_enabled)
          VALUES ('user_1', 'founder@example.com', 'Europe/Amsterdam', true);
        `,
      );
      await pg.query(`
        INSERT INTO goat.workspace_members (workspace_id, user_workos_id)
        VALUES ('workspace_1', 'user_1')
      `);
      await pg.query(
        `
          INSERT INTO goat.task_schedules (
            id,
            user_workos_id,
            workspace_id,
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
            'workspace_1',
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
        sweepDueTaskSchedules({ now: new Date("2026-06-03T12:00:00.000Z") }),
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
          workspaceId: "workspace_1",
          name: "Daily briefing",
          cron: "0 9 * * *",
          timezone: "UTC",
          prompt: "Send a daily briefing.",
          plannedHarnessSpec: harnessSpec,
          nextRunAt: new Date("2026-06-01T09:00:00.000Z"),
        },
      ])
      .mockResolvedValueOnce([{ id: "goat_task_schedule_run_1" }])
      .mockResolvedValueOnce([{ authorized: true, featureEnabled: true, commandId: null }])
      .mockImplementationOnce((query) =>
        canonicalTaskCreateRow(query, {
          name: "Daily briefing",
          goal: "Send a daily briefing.",
          model: harnessSpec.model,
          scheduleId: "goat_task_schedule_1",
          workflowId: null,
          scheduledFor: new Date("2026-06-03T09:00:00.000Z"),
        }),
      )
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mocks.transaction.mockImplementation(async (callback) => callback({ execute }));

    const onTaskCreated = vi.fn();
    await expect(
      sweepDueTaskSchedules({
        now: new Date("2026-06-03T12:00:00.000Z"),
        onTaskCreated,
      }),
    ).resolves.toEqual({ checked: 1, created: 1 });

    expect(onTaskCreated).toHaveBeenCalledOnce();
    expect(mocks.captureProductTaskSpawned).toHaveBeenCalledWith(
      expect.objectContaining({
        userWorkosId: "user_1",
        workspaceId: "workspace_1",
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
    expect(sqlTextFromExecuteCall(execute, 0)).toContain("schedule.workspace_id IS NOT NULL");
    expect(sqlTextFromExecuteCall(execute, 0)).toContain(
      "member.workspace_id = schedule.workspace_id",
    );
    expect(sqlTextFromExecuteCall(execute, 3)).toContain("INSERT INTO goat.chat_sessions");
    expect(sqlTextFromExecuteCall(execute, 3)).toContain("INSERT INTO goat.codex_chat_turns");
    expect(sqlTextFromExecuteCall(execute, 3)).toContain("'run.queued'");
  });

  it("skips duplicate schedule runs without creating another task", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: "goat_task_schedule_1",
          userWorkosId: "user_1",
          workspaceId: "workspace_1",
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
      sweepDueTaskSchedules({ now: new Date("2026-06-03T12:00:00.000Z") }),
    ).resolves.toEqual({ checked: 1, created: 0 });

    expect(sqlTextFromExecuteCall(execute, 2)).toContain("UPDATE goat.task_schedules");
    expect(execute).toHaveBeenCalledTimes(5);
    expect(mocks.captureProductTaskSpawned).not.toHaveBeenCalled();
  });

  it("creates a workflow task for a due workflow schedule", async () => {
    const workflowHarnessSpec: HarnessSpec = {
      ...harnessSpec,
      initialUserMessage: "Task: Weekly update\n\nDraft the weekday update.",
      workflow: {
        id: "weekly-update",
        workspaceId: "workspace_1",
        skillIds: [],
        skillBundleIds: [],
        pluginIds: [],
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
      .mockResolvedValueOnce([{ authorized: true, featureEnabled: true, commandId: null }])
      .mockImplementationOnce((query) =>
        canonicalTaskCreateRow(query, {
          name: "Weekly update",
          goal: "Draft the weekday update.",
          model: workflowHarnessSpec.model,
          scheduleId: null,
          workflowId: "weekly-update",
          scheduledFor: new Date("2026-06-03T09:00:00.000Z"),
        }),
      )
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mocks.transaction.mockImplementation(async (callback) => callback({ execute }));

    const onTaskCreated = vi.fn();
    await expect(
      sweepDueTaskSchedules({
        now: new Date("2026-06-03T12:00:00.000Z"),
        onTaskCreated,
      }),
    ).resolves.toEqual({ checked: 1, created: 1 });

    expect(onTaskCreated).toHaveBeenCalledOnce();
    expect(mocks.captureProductTaskSpawned).toHaveBeenCalledWith(
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
    expect(sqlTextFromExecuteCall(execute, 4)).toContain("INSERT INTO goat.chat_sessions");
    expect(sqlTextFromExecuteCall(execute, 4)).toContain("workflow_id");
    expect(sqlTextFromExecuteCall(execute, 5)).toContain("UPDATE goat.workflow_schedule_runs");
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

function canonicalTaskCreateRow(
  query: SQL,
  input: {
    name: string;
    goal: string;
    model: string;
    scheduleId: string | null;
    workflowId: string | null;
    scheduledFor: Date;
  },
) {
  const compiled = new PgDialect().sqlToQuery(query);
  const requestHash = compiled.params.find(
    (value): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value),
  );
  if (!requestHash) throw new Error("Expected canonical Task request hash.");
  const now = new Date("2026-06-03T12:00:00.000Z");
  return [
    {
      authorized: true,
      featureEnabled: true,
      commandId: "task_command_1",
      requestHash,
      taskId: "goat_task_1",
      reservedConversationId: "goat_chat_1",
      messageId: "goat_chat_message_1",
      assistantMessageId: "goat_chat_message_2",
      runId: "goat_run_1",
      transactionId: "1",
      replayed: false,
      materialized: true,
      id: "goat_task_1",
      displayId: "TASK-1",
      name: input.name,
      goal: input.goal,
      taskConversationId: "goat_chat_1",
      status: "queued",
      source: "schedule",
      engine: "opencompany",
      model: input.model,
      workflowId: input.workflowId,
      scheduleId: input.scheduleId,
      scheduledFor: input.scheduledFor,
      result: null,
      error: null,
      reportedStatus: null,
      outcomeComment: null,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    },
  ];
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
