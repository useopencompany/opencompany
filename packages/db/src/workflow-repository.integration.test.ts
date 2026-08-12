import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import {
  type Actor,
  type AutomationExecutionPlanner,
  type AutomationTaskCreator,
  type CreateTaskResult,
  SCHEDULE_READ_PERMISSION,
  SCHEDULE_WRITE_PERMISSION,
  TaskScheduleApplicationService,
  WORKFLOW_READ_PERMISSION,
  WORKFLOW_WRITE_PERMISSION,
  WorkflowApplicationService,
} from "@opencompany/core";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresTaskScheduleRepository, PostgresWorkflowRepository } from "./workflow-repository";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const migrationPath = path.join(
  repositoryRoot,
  "drizzle/0207_goat_headless_workflow_foundation.sql",
);
const dialect = new PgDialect();
const now = new Date("2026-08-12T08:00:00.000Z");
const nextRunAt = new Date("2026-08-13T09:00:00.000Z");

describe("Postgres Workflow and Recurring Task repositories", () => {
  let database: PGlite;
  let workflows: WorkflowApplicationService;
  let schedules: TaskScheduleApplicationService;
  let migrationEvidence: {
    workflowVersion: number;
    workflowStepInstructions: string;
    workflowTriggerPrompt: string;
    workflowProjected: boolean;
    workflowScheduleProjected: boolean;
    taskScheduleVersion: number;
    taskScheduleProjected: boolean;
  };

  beforeEach(async () => {
    database = new PGlite();
    await database.exec(BASE_SCHEMA);
    await database.exec(`
      INSERT INTO goat.users (workos_user_id, task_spawning_enabled)
      VALUES ('migration_user', true);
      INSERT INTO goat.workspaces (id) VALUES ('migration_workspace');
      INSERT INTO goat.workflows (
        id, workspace_id, slug, name, instructions, model, trigger,
        schedule_cron, schedule_prompt, schedule_enabled, schedule_next_run_at
      ) VALUES (
        'migration_workflow', 'migration_workspace', 'legacy-workflow', 'Legacy workflow',
        'Preserve these instructions.', 'provider/model', 'schedule', '0 9 * * 1',
        'Run the legacy workflow.', true, '2026-08-13T09:00:00.000Z'
      );
      INSERT INTO goat.task_schedules (
        id, user_workos_id, workspace_id, name, source_description, cron, prompt,
        planned_harness_spec, next_run_at
      ) VALUES (
        'migration_schedule', 'migration_user', 'migration_workspace', 'Legacy schedule',
        'Existing recurring Task', '0 9 * * 1', 'Preserve this schedule.',
        '{"engine":"opencompany","model":"provider/model"}'::jsonb,
        '2026-08-13T09:00:00.000Z'
      );
    `);
    const migration = await readFile(migrationPath, "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await database.exec(statement);
    }
    const [migrationRow] = (
      await database.query<{
        workflow_version: number;
        workflow_step_instructions: string;
        workflow_trigger_prompt: string;
        workflow_projected: boolean;
        workflow_schedule_projected: boolean;
        task_schedule_version: number;
        task_schedule_projected: boolean;
      }>(`
        SELECT
          workflow.version AS workflow_version,
          (
            SELECT projection.steps->0->>'instructions'
            FROM goat.workflow_read_model_v1 AS projection
            WHERE projection.id = workflow.id
          ) AS workflow_step_instructions,
          (
            SELECT projection.trigger->>'prompt'
            FROM goat.workflow_read_model_v1 AS projection
            WHERE projection.id = workflow.id
          ) AS workflow_trigger_prompt,
          EXISTS (
            SELECT 1 FROM goat.workflow_read_model_v1
            WHERE id = workflow.id AND steps->0->>'instructions' = workflow.instructions
          ) AS workflow_projected,
          EXISTS (
            SELECT 1 FROM goat.workflow_schedule_read_model_v1
            WHERE workflow_id = workflow.id AND cron = workflow.schedule_cron
          ) AS workflow_schedule_projected,
          schedule.version AS task_schedule_version,
          EXISTS (
            SELECT 1 FROM goat.task_schedule_read_model_v1
            WHERE id = schedule.id AND actor_id = schedule.user_workos_id
          ) AS task_schedule_projected
        FROM goat.workflows AS workflow
        CROSS JOIN goat.task_schedules AS schedule
        WHERE workflow.id = 'migration_workflow'
          AND schedule.id = 'migration_schedule'
      `)
    ).rows;
    migrationEvidence = {
      workflowVersion: migrationRow?.workflow_version ?? 0,
      workflowStepInstructions: migrationRow?.workflow_step_instructions ?? "",
      workflowTriggerPrompt: migrationRow?.workflow_trigger_prompt ?? "",
      workflowProjected: migrationRow?.workflow_projected ?? false,
      workflowScheduleProjected: migrationRow?.workflow_schedule_projected ?? false,
      taskScheduleVersion: migrationRow?.task_schedule_version ?? 0,
      taskScheduleProjected: migrationRow?.task_schedule_projected ?? false,
    };

    await database.exec(`
      DELETE FROM goat.automation_command_idempotency;
      DELETE FROM goat.workflow_schedule_runs;
      DELETE FROM goat.task_schedule_runs;
      DELETE FROM goat.workflows;
      DELETE FROM goat.task_schedules;
      DELETE FROM goat.workspace_members;
      DELETE FROM goat.users;
      DELETE FROM goat.workspaces;
      INSERT INTO goat.users (workos_user_id, task_spawning_enabled)
      VALUES ('user_1', true), ('user_2', true), ('user_disabled', false);
      INSERT INTO goat.workspaces (id) VALUES ('workspace_1'), ('workspace_2');
      INSERT INTO goat.workspace_members (id, workspace_id, user_workos_id, role)
      VALUES
        ('member_1', 'workspace_1', 'user_1', 'admin'),
        ('member_2', 'workspace_2', 'user_2', 'admin'),
        ('member_disabled', 'workspace_1', 'user_disabled', 'member');
    `);
    const execute = async (query: SQL) => {
      const compiled = dialect.sqlToQuery(query);
      return database.query(compiled.sql, compiled.params as never[]);
    };
    const ids = deterministicIds();
    const planner = fakePlanner();
    const taskCreator = fakeTaskCreator();
    const options = {
      scheduleRules: {
        normalize: ({ cron, timezone }: { cron: string; timezone?: string | null }) => ({
          cron: cron.trim(),
          timezone: timezone?.trim() || "UTC",
          nextRunAt,
        }),
      },
      planner,
      taskCreator,
      now: () => now,
    };
    workflows = new WorkflowApplicationService(new PostgresWorkflowRepository(execute, { ids }), {
      ...options,
      newStepId: () => "step_new",
    });
    schedules = new TaskScheduleApplicationService(
      new PostgresTaskScheduleRepository(execute, { ids }),
      options,
    );
  });

  afterEach(async () => {
    await database.close();
  });

  it("adds versions and backfills canonical projections without destroying legacy definitions", () => {
    expect(migrationEvidence).toEqual({
      workflowVersion: 1,
      workflowStepInstructions: "Preserve these instructions.",
      workflowTriggerPrompt: "Run the legacy workflow.",
      workflowProjected: true,
      workflowScheduleProjected: true,
      taskScheduleVersion: 1,
      taskScheduleProjected: true,
    });
  });

  it("creates and idempotently replays one workspace-scoped Workflow", async () => {
    const command = {
      idempotencyKey: "workflow-create-1",
      name: "Weekly research",
      description: "Track the market",
    };

    const first = await workflows.createWorkflow(actor(), command);
    const replay = await workflows.createWorkflow(actor(), command);

    expect(first).toMatchObject({
      workflow: {
        id: "workflow_2",
        slug: "weekly-research",
        name: "Weekly research",
        steps: [{ id: "step_new", instructions: "" }],
        version: 1,
      },
      idempotentReplay: false,
    });
    expect(replay).toMatchObject({
      workflow: { id: first.workflow.id },
      transactionId: first.transactionId,
      idempotentReplay: true,
    });
    await expect(
      workflows.createWorkflow(actor(), { ...command, name: "Different command" }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      workflows.getWorkflow(
        actor({ userId: "user_2", workspaceId: "workspace_2" }),
        first.workflow.id,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      database.query<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM goat.workflows WHERE id = $1",
        [first.workflow.id],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  it("paginates Workflow and Recurring Task resources with actor-scoped opaque cursors", async () => {
    const firstWorkflow = await workflows.createWorkflow(actor(), {
      idempotencyKey: "workflow-page-1",
      name: "First workflow",
    });
    const secondWorkflow = await workflows.createWorkflow(actor(), {
      idempotencyKey: "workflow-page-2",
      name: "Second workflow",
    });
    const workflowPage = await workflows.listWorkflows(actor(), { limit: 1 });
    expect(workflowPage).toMatchObject({
      workflows: [{ id: secondWorkflow.workflow.id }],
      nextCursor: secondWorkflow.workflow.id,
    });
    await expect(
      workflows.listWorkflows(actor(), { cursor: workflowPage.nextCursor!, limit: 1 }),
    ).resolves.toMatchObject({ workflows: [{ id: firstWorkflow.workflow.id }], nextCursor: null });
    await expect(
      workflows.listWorkflows(actor(), { cursor: "missing_workflow", limit: 1 }),
    ).resolves.toEqual({ workflows: [], nextCursor: null });

    const scheduleCommand = {
      name: "Recurring research",
      cron: "0 9 * * *",
      prompt: "Research changes.",
    };
    const firstSchedule = await schedules.createTaskSchedule(actor(), {
      ...scheduleCommand,
      idempotencyKey: "schedule-page-1",
    });
    const secondSchedule = await schedules.createTaskSchedule(actor(), {
      ...scheduleCommand,
      idempotencyKey: "schedule-page-2",
    });
    const schedulePage = await schedules.listTaskSchedules(actor(), { limit: 1 });
    expect(schedulePage).toMatchObject({
      schedules: [{ id: secondSchedule.schedule.id }],
      nextCursor: secondSchedule.schedule.id,
    });
    await expect(
      schedules.listTaskSchedules(actor(), { cursor: schedulePage.nextCursor!, limit: 1 }),
    ).resolves.toMatchObject({ schedules: [{ id: firstSchedule.schedule.id }], nextCursor: null });
  });

  it("updates and archives a Workflow with optimistic concurrency and synchronized projections", async () => {
    const created = await workflows.createWorkflow(actor(), {
      idempotencyKey: "workflow-version-1",
      name: "Weekly research",
    });
    const updated = await workflows.updateWorkflow(actor(), created.workflow.id, {
      expectedVersion: 1,
      name: "Weekly market research",
      description: "Track material changes",
      steps: [
        {
          id: "step_1",
          title: "Research",
          model: "provider/model",
          instructions: "Find material changes.",
        },
      ],
      status: "active",
      trigger: {
        type: "schedule",
        cron: "0 9 * * 1",
        timezone: "Europe/Berlin",
        prompt: "Run market research.",
      },
    });

    expect(updated.workflow).toMatchObject({
      version: 2,
      name: "Weekly market research",
      trigger: {
        type: "schedule",
        cron: "0 9 * * 1",
        timezone: "Europe/Berlin",
        enabled: true,
        nextRunAt,
      },
    });
    await expect(
      workflows.updateWorkflow(actor(), created.workflow.id, {
        expectedVersion: 1,
        name: "Stale",
        description: "",
        steps: updated.workflow.steps,
        status: "active",
        trigger: { type: "manual" },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      database.query<{ workflow_version: number; schedule_version: number }>(
        `SELECT workflow.version AS workflow_version, schedule.version AS schedule_version
         FROM goat.workflow_read_model_v1 AS workflow
         JOIN goat.workflow_schedule_read_model_v1 AS schedule
           ON schedule.workflow_id = workflow.id
         WHERE workflow.id = $1`,
        [created.workflow.id],
      ),
    ).resolves.toMatchObject({ rows: [{ workflow_version: 2, schedule_version: 2 }] });

    await expect(workflows.archiveWorkflow(actor(), created.workflow.id, 2)).resolves.toMatchObject(
      { workflowId: created.workflow.id, version: 3 },
    );
    await expect(
      database.query<{ count: number }>(
        `SELECT (
          (SELECT COUNT(*) FROM goat.workflow_read_model_v1 WHERE id = $1)
          + (SELECT COUNT(*) FROM goat.workflow_schedule_read_model_v1 WHERE id = $1)
        )::int AS count`,
        [created.workflow.id],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it("keeps Recurring Tasks actor-owned, feature-gated, idempotent, and versioned", async () => {
    const command = {
      idempotencyKey: "schedule-create-1",
      name: "Weekly research",
      sourceDescription: "Tasks page",
      cron: "0 9 * * 1",
      timezone: "Europe/Berlin",
      prompt: "Research market changes.",
    };
    const first = await schedules.createTaskSchedule(actor(), command);
    const replay = await schedules.createTaskSchedule(actor(), command);

    expect(first).toMatchObject({
      schedule: {
        id: "schedule_2",
        name: "Weekly research",
        version: 1,
      },
      idempotentReplay: false,
    });
    expect(replay).toMatchObject({
      schedule: { id: first.schedule.id },
      transactionId: first.transactionId,
      idempotentReplay: true,
    });
    await expect(
      schedules.getTaskSchedule(
        actor({ userId: "user_2", workspaceId: "workspace_2" }),
        first.schedule.id,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      schedules.createTaskSchedule(actor({ userId: "user_disabled" }), {
        ...command,
        idempotencyKey: "disabled-schedule",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });

    await database.exec(`
      INSERT INTO goat.task_schedules (
        id, user_workos_id, workspace_id, name, source_description, cron, timezone,
        prompt, planned_harness_spec, enabled, next_run_at, version, created_at, updated_at
      ) VALUES (
        'legacy_personal_schedule', 'user_1', NULL, 'Legacy personal schedule', '',
        '0 8 * * *', 'UTC', 'Preserve this recurring Task.',
        '{"engine":"opencompany","model":"provider/model"}'::jsonb,
        true, '2026-08-13T08:00:00.000Z', 1, now(), now()
      )
    `);
    await expect(schedules.listTaskSchedules(actor())).resolves.toMatchObject({
      schedules: expect.arrayContaining([
        expect.objectContaining({ id: "legacy_personal_schedule", version: 1 }),
      ]),
    });
    await schedules.updateTaskSchedule(actor(), "legacy_personal_schedule", {
      expectedVersion: 1,
      name: "Legacy schedule retained",
      cron: "0 8 * * *",
      timezone: "UTC",
      prompt: "Preserve this recurring Task.",
    });
    await expect(
      database.query<{ workspace_id: string }>(
        "SELECT workspace_id FROM goat.task_schedules WHERE id = $1",
        ["legacy_personal_schedule"],
      ),
    ).resolves.toMatchObject({ rows: [{ workspace_id: "workspace_1" }] });

    const paused = await schedules.setTaskScheduleEnabled(actor(), first.schedule.id, {
      expectedVersion: 1,
      enabled: false,
    });
    expect(paused.schedule).toMatchObject({ enabled: false, version: 2 });
    await expect(
      schedules.setTaskScheduleEnabled(actor(), first.schedule.id, {
        expectedVersion: 1,
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      database.query<{ enabled: boolean; version: number }>(
        "SELECT enabled, version FROM goat.task_schedule_read_model_v1 WHERE id = $1",
        [first.schedule.id],
      ),
    ).resolves.toMatchObject({ rows: [{ enabled: false, version: 2 }] });

    await schedules.archiveTaskSchedule(actor(), first.schedule.id, 2);
    await database.exec(`
      UPDATE goat.users
      SET task_spawning_enabled = false
      WHERE workos_user_id = 'user_1'
    `);
    await expect(schedules.createTaskSchedule(actor(), command)).resolves.toMatchObject({
      schedule: { id: first.schedule.id, enabled: false, version: 3 },
      transactionId: first.transactionId,
      idempotentReplay: true,
    });
  });
});

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    userId: "user_1",
    workspaceId: "workspace_1",
    role: "admin",
    permissions: [
      WORKFLOW_READ_PERMISSION,
      WORKFLOW_WRITE_PERMISSION,
      SCHEDULE_READ_PERMISSION,
      SCHEDULE_WRITE_PERMISSION,
    ],
    authenticationMethod: "session",
    ...overrides,
  };
}

function deterministicIds() {
  let sequence = 0;
  const next = (kind: string) => `${kind}_${++sequence}`;
  return {
    command: () => next("command"),
    workflow: () => next("workflow"),
    taskSchedule: () => next("schedule"),
    scheduleRun: (kind: "workflow" | "task") => next(`${kind}_run`),
  };
}

function fakePlanner(): AutomationExecutionPlanner {
  return {
    prepareWorkflow: vi.fn(async () => executionPlan()),
    prepareTaskSchedule: vi.fn(async () => executionPlan()),
  };
}

function fakeTaskCreator(): AutomationTaskCreator {
  return { create: vi.fn(async () => taskResult()) };
}

function executionPlan() {
  return {
    engine: "opencompany" as const,
    model: "provider/model",
    payload: { engine: "opencompany", model: "provider/model", prompt: "Research" },
  };
}

function taskResult(): CreateTaskResult {
  return {
    task: {
      id: "task_1",
      displayId: "TASK-1",
      name: "Weekly research",
      goal: "Research market changes.",
      conversationId: "conversation_1",
      status: "queued",
      source: "schedule",
      engine: "opencompany",
      model: "provider/model",
      workflowId: null,
      scheduleId: "schedule_1",
      scheduledFor: null,
      outcome: { result: null, error: null, reportedStatus: null, comment: null },
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    messageId: "message_1",
    assistantMessageId: "message_2",
    runId: "run_1",
    transactionId: "42",
    idempotentReplay: false,
  };
}

const BASE_SCHEMA = `
  CREATE SCHEMA goat;
  CREATE TABLE goat.users (
    workos_user_id text PRIMARY KEY,
    task_spawning_enabled boolean NOT NULL DEFAULT false
  );
  CREATE TABLE goat.workspaces (id text PRIMARY KEY);
  CREATE TABLE goat.workspace_members (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    user_workos_id text NOT NULL,
    role text NOT NULL
  );
  CREATE TABLE goat.tasks (id text PRIMARY KEY);
  CREATE TABLE goat.task_schedules (
    id text PRIMARY KEY,
    user_workos_id text NOT NULL REFERENCES goat.users(workos_user_id) ON DELETE CASCADE,
    workspace_id text REFERENCES goat.workspaces(id) ON DELETE CASCADE,
    name text NOT NULL,
    source_description text NOT NULL DEFAULT '',
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
  CREATE TABLE goat.workflows (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES goat.workspaces(id) ON DELETE CASCADE,
    slug text NOT NULL,
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    instructions text NOT NULL DEFAULT '',
    model text NOT NULL DEFAULT '',
    steps jsonb NOT NULL DEFAULT '[]'::jsonb,
    trigger text NOT NULL DEFAULT 'manual',
    schedule_cron text,
    schedule_timezone text NOT NULL DEFAULT 'UTC',
    schedule_prompt text NOT NULL DEFAULT '',
    schedule_user_workos_id text REFERENCES goat.users(workos_user_id) ON DELETE SET NULL,
    schedule_harness_spec jsonb,
    schedule_enabled boolean NOT NULL DEFAULT false,
    schedule_last_run_at timestamptz,
    schedule_next_run_at timestamptz,
    status text NOT NULL DEFAULT 'active',
    created_by_workos_id text REFERENCES goat.users(workos_user_id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    archived_at timestamptz
  );
  CREATE UNIQUE INDEX goat_workflows_workspace_slug_idx
    ON goat.workflows(workspace_id, slug) WHERE archived_at IS NULL;
  CREATE TABLE goat.task_schedule_runs (
    id text PRIMARY KEY,
    schedule_id text NOT NULL REFERENCES goat.task_schedules(id) ON DELETE CASCADE,
    user_workos_id text NOT NULL REFERENCES goat.users(workos_user_id) ON DELETE CASCADE,
    scheduled_for timestamptz NOT NULL,
    task_id text REFERENCES goat.tasks(id) ON DELETE SET NULL,
    status text NOT NULL DEFAULT 'pending',
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (schedule_id, scheduled_for)
  );
  CREATE TABLE goat.workflow_schedule_runs (
    id text PRIMARY KEY,
    workflow_id text NOT NULL REFERENCES goat.workflows(id) ON DELETE CASCADE,
    workspace_id text NOT NULL REFERENCES goat.workspaces(id) ON DELETE CASCADE,
    user_workos_id text NOT NULL REFERENCES goat.users(workos_user_id) ON DELETE CASCADE,
    scheduled_for timestamptz NOT NULL,
    task_id text REFERENCES goat.tasks(id) ON DELETE SET NULL,
    status text NOT NULL DEFAULT 'pending',
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workflow_id, scheduled_for)
  );
`;
