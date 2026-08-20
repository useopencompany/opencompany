import { createHash, randomUUID } from "node:crypto";
import {
  type Actor,
  CoreError,
  type TaskSchedule,
  type TaskScheduleMutationResult,
  type TaskSchedulePage,
  type TaskScheduleRepository,
  type VersionedRepositoryResult,
  type Workflow,
  type WorkflowMutationResult,
  type WorkflowPage,
  type WorkflowRepository,
  type WorkflowStep,
  type WorkflowTrigger,
} from "@opencompany/core";
import { type SQL, sql } from "drizzle-orm";

export type WorkflowSqlExecute = (query: SQL) => Promise<unknown>;

type RepositoryIds = {
  command: () => string;
  workflow: () => string;
  taskSchedule: () => string;
  scheduleRun: (kind: "workflow" | "task") => string;
};

type WorkflowRepositoryOptions = {
  ids?: RepositoryIds;
  now?: () => Date;
};

type WorkflowRow = {
  id: string;
  slug: string;
  name: string;
  description: string;
  instructions: string;
  model: string;
  steps: unknown;
  status: "draft" | "active";
  trigger: "manual" | "slack" | "linear" | "schedule" | "event";
  scheduleCron: string | null;
  scheduleTimezone: string;
  schedulePrompt: string;
  scheduleEnabled: boolean;
  scheduleLastRunAt: Date | string | null;
  scheduleNextRunAt: Date | string | null;
  eventConfig: unknown;
  version: number | string;
  archivedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

type TaskScheduleRow = {
  id: string;
  name: string;
  sourceDescription: string;
  cron: string;
  timezone: string;
  prompt: string;
  plannedHarnessSpec?: unknown;
  enabled: boolean;
  lastRunAt: Date | string | null;
  nextRunAt: Date | string;
  version: number | string;
  createdAt: Date | string;
  updatedAt: Date | string;
};

type CreateReservationRow = {
  authorized: boolean;
  featureEnabled?: boolean;
  commandId: string | null;
  requestHash: string | null;
  operation: "workflow.create" | "task_schedule.create" | null;
  resourceId: string | null;
  transactionId: number | string | null;
  replayed: boolean | null;
};

const defaultIds: RepositoryIds = {
  command: () => `goat_automation_command_${randomUUID()}`,
  workflow: () => `goat_wf_${randomUUID()}`,
  taskSchedule: () => `goat_task_schedule_${randomUUID()}`,
  scheduleRun: (kind) => `goat_${kind}_schedule_run_${randomUUID()}`,
};

export class PostgresWorkflowRepository implements WorkflowRepository {
  constructor(
    private readonly execute: WorkflowSqlExecute,
    private readonly options: WorkflowRepositoryOptions = {},
  ) {}

  async listWorkflows(input: {
    actor: Actor;
    cursor?: string;
    limit: number;
  }): Promise<WorkflowPage> {
    const rows = await this.rows<WorkflowRow>(sql`
      ${workflowSelect()}
      WHERE workflow.workspace_id = ${input.actor.workspaceId}
        AND workflow.archived_at IS NULL
        AND ${workspaceMembership(input.actor)}
        AND (
          ${input.cursor ?? null}::text IS NULL
          OR EXISTS (
            SELECT 1
            FROM goat.workflows AS cursor_workflow
            WHERE cursor_workflow.id = ${input.cursor ?? null}
              AND cursor_workflow.workspace_id = ${input.actor.workspaceId}
              AND (workflow.updated_at, workflow.id)
                < (cursor_workflow.updated_at, cursor_workflow.id)
          )
        )
      ORDER BY workflow.updated_at DESC, workflow.id DESC
      LIMIT ${input.limit + 1}
    `);
    const hasNext = rows.length > input.limit;
    const page = rows.slice(0, input.limit);
    return {
      workflows: page.map(mapWorkflow),
      nextCursor: hasNext ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async getWorkflow(input: { actor: Actor; workflowId: string }): Promise<Workflow | null> {
    const [row] = await this.rows<WorkflowRow>(sql`
      ${workflowSelect()}
      WHERE workflow.workspace_id = ${input.actor.workspaceId}
        AND (workflow.id = ${input.workflowId} OR workflow.slug = ${input.workflowId})
        AND workflow.archived_at IS NULL
        AND ${workspaceMembership(input.actor)}
      LIMIT 1
    `);
    return row ? mapWorkflow(row) : null;
  }

  async createWorkflow(input: {
    actor: Actor;
    idempotencyKey: string;
    name: string;
    description: string;
    initialStep: WorkflowStep;
  }): Promise<WorkflowMutationResult> {
    const ids = this.options.ids ?? defaultIds;
    const commandId = ids.command();
    const workflowId = ids.workflow();
    const now = this.options.now?.() ?? new Date();
    const baseSlug = normalizeSlug(input.name);
    const fallbackSlug = `${baseSlug.slice(0, 55)}-${workflowId.slice(-8)}`;
    const requestHash = commandHash("workflow.create", {
      name: input.name,
      description: input.description,
    });
    const [row] = await this.rows<CreateReservationRow & WorkflowRow>(sql`
      WITH actor_scope AS MATERIALIZED (
        SELECT workspace.id
        FROM goat.workspaces AS workspace
        JOIN goat.workspace_members AS member
          ON member.workspace_id = workspace.id
         AND member.user_workos_id = ${input.actor.userId}
        WHERE workspace.id = ${input.actor.workspaceId}
        FOR UPDATE OF workspace
      ),
      reservation AS MATERIALIZED (
        INSERT INTO goat.automation_command_idempotency (
          command_id, user_workos_id, workspace_id, idempotency_key,
          request_hash, operation, resource_id, created_at, touched_at
        )
        SELECT
          ${commandId}, ${input.actor.userId}, ${input.actor.workspaceId},
          ${input.idempotencyKey}, ${requestHash}, 'workflow.create', ${workflowId}, ${now}, ${now}
        FROM actor_scope
        ON CONFLICT (user_workos_id, workspace_id, idempotency_key)
        DO UPDATE SET touched_at = EXCLUDED.touched_at
        RETURNING *
      ),
      winner AS MATERIALIZED (
        SELECT * FROM reservation WHERE command_id = ${commandId}
      ),
      candidate AS MATERIALIZED (
        SELECT CASE
          WHEN NOT EXISTS (
            SELECT 1 FROM goat.workflows
            WHERE workspace_id = ${input.actor.workspaceId}
              AND slug = ${baseSlug}
              AND archived_at IS NULL
          ) THEN ${baseSlug}
          ELSE COALESCE(
            (
              SELECT ${baseSlug.slice(0, 60)} || '-' || candidate_number::text
              FROM generate_series(2, 999) AS candidate_number
              WHERE NOT EXISTS (
                SELECT 1 FROM goat.workflows
                WHERE workspace_id = ${input.actor.workspaceId}
                  AND slug = ${baseSlug.slice(0, 60)} || '-' || candidate_number::text
                  AND archived_at IS NULL
              )
              ORDER BY candidate_number
              LIMIT 1
            ),
            ${fallbackSlug}
          )
        END AS slug
        FROM winner
      ),
      created AS MATERIALIZED (
        INSERT INTO goat.workflows (
          id, workspace_id, slug, name, description, instructions, model, steps,
          trigger, schedule_cron, schedule_timezone, schedule_prompt,
          schedule_user_workos_id, schedule_harness_spec, schedule_enabled,
          schedule_next_run_at, status, created_by_workos_id, version,
          created_at, updated_at
        )
        SELECT
          winner.resource_id, ${input.actor.workspaceId}, candidate.slug, ${input.name},
          ${input.description}, '', '', ${JSON.stringify([input.initialStep])}::jsonb,
          'manual', NULL, 'UTC', '', NULL, NULL, false, NULL, 'active',
          ${input.actor.userId}, 1, ${now}, ${now}
        FROM winner
        CROSS JOIN candidate
        RETURNING *
      ),
      selected_workflow AS MATERIALIZED (
        SELECT created.*
        FROM created
        UNION ALL
        SELECT existing.*
        FROM goat.workflows AS existing
        JOIN reservation ON reservation.resource_id = existing.id
        WHERE NOT EXISTS (SELECT 1 FROM created)
      )
      SELECT
        EXISTS (SELECT 1 FROM actor_scope) AS authorized,
        reservation.command_id AS "commandId",
        reservation.request_hash AS "requestHash",
        reservation.operation,
        reservation.resource_id AS "resourceId",
        reservation.transaction_id AS "transactionId",
        reservation.command_id <> ${commandId} AS replayed,
        workflow.id,
        workflow.slug,
        workflow.name,
        workflow.description,
        workflow.instructions,
        workflow.model,
        workflow.steps,
        workflow.status,
        workflow.trigger,
        workflow.schedule_cron AS "scheduleCron",
        workflow.schedule_timezone AS "scheduleTimezone",
        workflow.schedule_prompt AS "schedulePrompt",
        workflow.schedule_enabled AS "scheduleEnabled",
        workflow.schedule_last_run_at AS "scheduleLastRunAt",
        workflow.schedule_next_run_at AS "scheduleNextRunAt",
        workflow.event_config AS "eventConfig",
        workflow.version,
        workflow.archived_at AS "archivedAt",
        workflow.created_at AS "createdAt",
        workflow.updated_at AS "updatedAt"
      FROM (SELECT 1) AS singleton
      LEFT JOIN reservation ON true
      LEFT JOIN selected_workflow AS workflow ON workflow.id = reservation.resource_id
      LIMIT 1
    `);
    if (!row?.authorized) throw new CoreError("not_found", "Workspace membership not found.");
    assertReservation(row, "workflow.create", requestHash);
    if (!row.id) throw new Error("Workflow command reservation did not materialize.");
    return {
      workflow: mapWorkflow(row),
      transactionId: String(row.transactionId),
      idempotentReplay: row.replayed === true,
    };
  }

  async updateWorkflow(input: Parameters<WorkflowRepository["updateWorkflow"]>[0]) {
    const now = this.options.now?.() ?? new Date();
    const scheduled = input.trigger.type === "schedule";
    const eventDriven = input.trigger.type === "event";
    const scheduleEnabled = input.trigger.type === "schedule" && input.trigger.enabled !== false;
    const schedulePrompt =
      input.trigger.type === "schedule" ? input.trigger.prompt?.trim() || "Run this workflow." : "";
    const [row] = await this.rows<WorkflowRow & { transactionId: number | string }>(sql`
      UPDATE goat.workflows AS workflow
      SET name = ${input.name},
          description = ${input.description},
          steps = ${JSON.stringify(input.steps)}::jsonb,
          trigger = ${scheduled ? "schedule" : eventDriven ? "event" : "manual"},
          schedule_cron = ${scheduled ? (input.schedule?.definition.cron ?? null) : null},
          schedule_timezone = ${scheduled ? (input.schedule?.definition.timezone ?? "UTC") : "UTC"},
          schedule_prompt = ${schedulePrompt},
          schedule_enabled = ${scheduleEnabled},
          schedule_user_workos_id = ${scheduled ? input.actor.userId : null},
          schedule_harness_spec = ${
            input.schedule?.execution ? JSON.stringify(input.schedule.execution.payload) : null
          }::jsonb,
          schedule_next_run_at = ${
            scheduled && scheduleEnabled && input.status === "active"
              ? (input.schedule?.definition.nextRunAt ?? null)
              : null
          },
          event_config = ${eventDriven ? JSON.stringify(input.trigger) : null}::jsonb,
          event_user_workos_id = ${eventDriven ? input.actor.userId : null},
          event_harness_spec = ${
            input.event?.execution ? JSON.stringify(input.event.execution.payload) : null
          }::jsonb,
          status = ${input.status},
          version = workflow.version + 1,
          updated_at = ${now}
      WHERE workflow.id = ${input.workflowId}
        AND workflow.workspace_id = ${input.actor.workspaceId}
        AND workflow.archived_at IS NULL
        AND workflow.version = ${input.expectedVersion}
        AND ${workspaceMembership(input.actor)}
      RETURNING
        workflow.id,
        workflow.slug,
        workflow.name,
        workflow.description,
        workflow.instructions,
        workflow.model,
        workflow.steps,
        workflow.status,
        workflow.trigger,
        workflow.schedule_cron AS "scheduleCron",
        workflow.schedule_timezone AS "scheduleTimezone",
        workflow.schedule_prompt AS "schedulePrompt",
        workflow.schedule_enabled AS "scheduleEnabled",
        workflow.schedule_last_run_at AS "scheduleLastRunAt",
        workflow.schedule_next_run_at AS "scheduleNextRunAt",
        workflow.event_config AS "eventConfig",
        workflow.version,
        workflow.archived_at AS "archivedAt",
        workflow.created_at AS "createdAt",
        workflow.updated_at AS "updatedAt",
        pg_current_xact_id()::xid::text::bigint AS "transactionId"
    `);
    if (row) {
      return {
        status: "updated" as const,
        value: mapWorkflow(row),
        transactionId: String(row.transactionId),
      };
    }
    return this.workflowMiss(input.actor, input.workflowId);
  }

  async archiveWorkflow(input: Parameters<WorkflowRepository["archiveWorkflow"]>[0]) {
    const now = this.options.now?.() ?? new Date();
    const [row] = await this.rows<{
      id: string;
      version: number | string;
      transactionId: number | string;
    }>(sql`
      UPDATE goat.workflows AS workflow
      SET archived_at = ${now},
          schedule_enabled = false,
          schedule_next_run_at = NULL,
          version = workflow.version + 1,
          updated_at = ${now}
      WHERE workflow.id = ${input.workflowId}
        AND workflow.workspace_id = ${input.actor.workspaceId}
        AND workflow.archived_at IS NULL
        AND workflow.version = ${input.expectedVersion}
        AND ${workspaceMembership(input.actor)}
      RETURNING
        workflow.id,
        workflow.version,
        pg_current_xact_id()::xid::text::bigint AS "transactionId"
    `);
    if (row) {
      return {
        status: "updated" as const,
        value: { workflowId: row.id, version: Number(row.version) },
        transactionId: String(row.transactionId),
      };
    }
    return this.workflowMiss(input.actor, input.workflowId);
  }

  async recordRunNow(input: {
    actor: Actor;
    workflowId: string;
    taskId: string;
    occurredAt: Date;
  }): Promise<void> {
    const ids = this.options.ids ?? defaultIds;
    await this.execute(sql`
      INSERT INTO goat.workflow_schedule_runs (
        id, workflow_id, workspace_id, user_workos_id, scheduled_for,
        task_id, status, created_at, updated_at
      )
      SELECT
        ${ids.scheduleRun("workflow")}, workflow.id, workflow.workspace_id,
        ${input.actor.userId}, ${input.occurredAt}, ${input.taskId}, 'created',
        ${input.occurredAt}, ${input.occurredAt}
      FROM goat.workflows AS workflow
      WHERE workflow.id = ${input.workflowId}
        AND workflow.workspace_id = ${input.actor.workspaceId}
        AND workflow.archived_at IS NULL
        AND ${workspaceMembership(input.actor)}
      ON CONFLICT (workflow_id, scheduled_for) DO UPDATE
      SET task_id = EXCLUDED.task_id,
          status = 'created',
          updated_at = EXCLUDED.updated_at
    `);
  }

  async listTaskSchedules(input: {
    actor: Actor;
    cursor?: string;
    limit: number;
  }): Promise<TaskSchedulePage> {
    const rows = await this.rows<TaskScheduleRow>(sql`
      ${taskScheduleSelect()}
      WHERE schedule.user_workos_id = ${input.actor.userId}
        AND (schedule.workspace_id = ${input.actor.workspaceId} OR schedule.workspace_id IS NULL)
        AND schedule.deleted_at IS NULL
        AND ${workspaceMembership(input.actor)}
        AND (
          ${input.cursor ?? null}::text IS NULL
          OR EXISTS (
            SELECT 1
            FROM goat.task_schedules AS cursor_schedule
            WHERE cursor_schedule.id = ${input.cursor ?? null}
              AND cursor_schedule.user_workos_id = ${input.actor.userId}
              AND (
                cursor_schedule.workspace_id = ${input.actor.workspaceId}
                OR cursor_schedule.workspace_id IS NULL
              )
              AND (schedule.updated_at, schedule.id)
                < (cursor_schedule.updated_at, cursor_schedule.id)
          )
        )
      ORDER BY schedule.updated_at DESC, schedule.id DESC
      LIMIT ${input.limit + 1}
    `);
    const hasNext = rows.length > input.limit;
    const page = rows.slice(0, input.limit);
    return {
      schedules: page.map(mapTaskSchedule),
      nextCursor: hasNext ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async assertTaskScheduleWriteAllowed(actor: Actor): Promise<void> {
    const [row] = await this.rows<{ featureEnabled: boolean }>(sql`
      SELECT actor_user.task_spawning_enabled AS "featureEnabled"
      FROM goat.users AS actor_user
      JOIN goat.workspace_members AS member
        ON member.user_workos_id = actor_user.workos_user_id
       AND member.workspace_id = ${actor.workspaceId}
      WHERE actor_user.workos_user_id = ${actor.userId}
      LIMIT 1
    `);
    if (!row) throw new CoreError("not_found", "Workspace membership not found.");
    if (!row.featureEnabled) {
      throw new CoreError("forbidden", "Tasks & Workflows is disabled for this actor.");
    }
  }

  async replayTaskScheduleCreate(
    input: Parameters<TaskScheduleRepository["replayTaskScheduleCreate"]>[0],
  ): Promise<TaskScheduleMutationResult | null> {
    const requestHash = taskScheduleCreateHash(input);
    const [row] = await this.rows<CreateReservationRow & TaskScheduleRow>(sql`
      WITH actor_scope AS MATERIALIZED (
        SELECT actor_user.task_spawning_enabled
        FROM goat.users AS actor_user
        JOIN goat.workspace_members AS member
          ON member.user_workos_id = actor_user.workos_user_id
         AND member.workspace_id = ${input.actor.workspaceId}
        WHERE actor_user.workos_user_id = ${input.actor.userId}
      )
      SELECT
        EXISTS (SELECT 1 FROM actor_scope) AS authorized,
        COALESCE((SELECT task_spawning_enabled FROM actor_scope), false) AS "featureEnabled",
        reservation.command_id AS "commandId",
        reservation.request_hash AS "requestHash",
        reservation.operation,
        reservation.resource_id AS "resourceId",
        reservation.transaction_id AS "transactionId",
        true AS replayed,
        schedule.id,
        schedule.name,
        schedule.source_description AS "sourceDescription",
        schedule.cron,
        schedule.timezone,
        schedule.prompt,
        schedule.enabled,
        schedule.last_run_at AS "lastRunAt",
        schedule.next_run_at AS "nextRunAt",
        schedule.version,
        schedule.created_at AS "createdAt",
        schedule.updated_at AS "updatedAt"
      FROM (SELECT 1) AS singleton
      LEFT JOIN actor_scope ON true
      LEFT JOIN goat.automation_command_idempotency AS reservation
        ON reservation.user_workos_id = ${input.actor.userId}
       AND reservation.workspace_id = ${input.actor.workspaceId}
       AND reservation.idempotency_key = ${input.idempotencyKey}
       AND EXISTS (SELECT 1 FROM actor_scope)
      LEFT JOIN goat.task_schedules AS schedule
        ON schedule.id = reservation.resource_id
       AND schedule.user_workos_id = ${input.actor.userId}
       AND (schedule.workspace_id = ${input.actor.workspaceId} OR schedule.workspace_id IS NULL)
      LIMIT 1
    `);
    if (!row?.authorized) throw new CoreError("not_found", "Workspace membership not found.");
    if (!row.commandId) return null;
    assertReservation(row, "task_schedule.create", requestHash);
    if (!row.id) throw new Error("Recurring Task command reservation did not materialize.");
    return {
      schedule: mapTaskSchedule(row),
      transactionId: String(row.transactionId),
      idempotentReplay: true,
    };
  }

  async getTaskSchedule(input: { actor: Actor; scheduleId: string }): Promise<TaskSchedule | null> {
    const [row] = await this.rows<TaskScheduleRow>(sql`
      ${taskScheduleSelect()}
      WHERE schedule.id = ${input.scheduleId}
        AND schedule.user_workos_id = ${input.actor.userId}
        AND (schedule.workspace_id = ${input.actor.workspaceId} OR schedule.workspace_id IS NULL)
        AND schedule.deleted_at IS NULL
        AND ${workspaceMembership(input.actor)}
      LIMIT 1
    `);
    return row ? mapTaskSchedule(row) : null;
  }

  async createTaskSchedule(
    input: Parameters<TaskScheduleRepository["createTaskSchedule"]>[0],
  ): Promise<TaskScheduleMutationResult> {
    const ids = this.options.ids ?? defaultIds;
    const commandId = ids.command();
    const scheduleId = ids.taskSchedule();
    const now = this.options.now?.() ?? new Date();
    const requestHash = taskScheduleCreateHash(input);
    const [row] = await this.rows<CreateReservationRow & TaskScheduleRow>(sql`
      WITH actor_scope AS MATERIALIZED (
        SELECT actor_user.workos_user_id, actor_user.task_spawning_enabled
        FROM goat.users AS actor_user
        JOIN goat.workspace_members AS member
          ON member.user_workos_id = actor_user.workos_user_id
         AND member.workspace_id = ${input.actor.workspaceId}
        WHERE actor_user.workos_user_id = ${input.actor.userId}
        FOR UPDATE OF actor_user
      ),
      reservation AS MATERIALIZED (
        INSERT INTO goat.automation_command_idempotency (
          command_id, user_workos_id, workspace_id, idempotency_key,
          request_hash, operation, resource_id, created_at, touched_at
        )
        SELECT
          ${commandId}, ${input.actor.userId}, ${input.actor.workspaceId},
          ${input.idempotencyKey}, ${requestHash}, 'task_schedule.create', ${scheduleId},
          ${now}, ${now}
        FROM actor_scope
        WHERE actor_scope.task_spawning_enabled = true
        ON CONFLICT (user_workos_id, workspace_id, idempotency_key)
        DO UPDATE SET touched_at = EXCLUDED.touched_at
        RETURNING *
      ),
      winner AS MATERIALIZED (
        SELECT * FROM reservation WHERE command_id = ${commandId}
      ),
      created AS MATERIALIZED (
        INSERT INTO goat.task_schedules (
          id, user_workos_id, workspace_id, name, source_description,
          cron, timezone, prompt, planned_harness_spec, enabled,
          next_run_at, version, created_at, updated_at
        )
        SELECT
          winner.resource_id, ${input.actor.userId}, ${input.actor.workspaceId},
          ${input.name}, ${input.sourceDescription}, ${input.schedule.cron},
          ${input.schedule.timezone}, ${input.prompt}, ${JSON.stringify(input.execution.payload)}::jsonb,
          true, ${input.schedule.nextRunAt}, 1, ${now}, ${now}
        FROM winner
        RETURNING *
      ),
      selected_schedule AS MATERIALIZED (
        SELECT created.*
        FROM created
        UNION ALL
        SELECT existing.*
        FROM goat.task_schedules AS existing
        JOIN reservation ON reservation.resource_id = existing.id
        WHERE NOT EXISTS (SELECT 1 FROM created)
      )
      SELECT
        EXISTS (SELECT 1 FROM actor_scope) AS authorized,
        COALESCE((SELECT task_spawning_enabled FROM actor_scope), false) AS "featureEnabled",
        reservation.command_id AS "commandId",
        reservation.request_hash AS "requestHash",
        reservation.operation,
        reservation.resource_id AS "resourceId",
        reservation.transaction_id AS "transactionId",
        reservation.command_id <> ${commandId} AS replayed,
        schedule.id,
        schedule.name,
        schedule.source_description AS "sourceDescription",
        schedule.cron,
        schedule.timezone,
        schedule.prompt,
        schedule.enabled,
        schedule.last_run_at AS "lastRunAt",
        schedule.next_run_at AS "nextRunAt",
        schedule.version,
        schedule.created_at AS "createdAt",
        schedule.updated_at AS "updatedAt"
      FROM (SELECT 1) AS singleton
      LEFT JOIN actor_scope ON true
      LEFT JOIN reservation ON true
      LEFT JOIN selected_schedule AS schedule
        ON schedule.id = reservation.resource_id
       AND schedule.user_workos_id = ${input.actor.userId}
       AND schedule.workspace_id = ${input.actor.workspaceId}
      LIMIT 1
    `);
    if (!row?.authorized) throw new CoreError("not_found", "Workspace membership not found.");
    if (!row.featureEnabled) {
      throw new CoreError("forbidden", "Tasks & Workflows is disabled for this actor.");
    }
    assertReservation(row, "task_schedule.create", requestHash);
    if (!row.id) throw new Error("Recurring Task command reservation did not materialize.");
    return {
      schedule: mapTaskSchedule(row),
      transactionId: String(row.transactionId),
      idempotentReplay: row.replayed === true,
    };
  }

  async updateTaskSchedule(input: Parameters<TaskScheduleRepository["updateTaskSchedule"]>[0]) {
    const now = this.options.now?.() ?? new Date();
    const [row] = await this.rows<TaskScheduleRow & { transactionId: number | string }>(sql`
      UPDATE goat.task_schedules AS schedule
      SET name = ${input.name},
          workspace_id = ${input.actor.workspaceId},
          source_description = ${input.sourceDescription},
          cron = ${input.schedule.cron},
          timezone = ${input.schedule.timezone},
          prompt = ${input.prompt},
          planned_harness_spec = ${JSON.stringify(input.execution.payload)}::jsonb,
          next_run_at = ${input.schedule.nextRunAt},
          version = schedule.version + 1,
          updated_at = ${now}
      WHERE schedule.id = ${input.scheduleId}
        AND schedule.user_workos_id = ${input.actor.userId}
        AND (schedule.workspace_id = ${input.actor.workspaceId} OR schedule.workspace_id IS NULL)
        AND schedule.deleted_at IS NULL
        AND schedule.version = ${input.expectedVersion}
        AND ${enabledWorkspaceMember(input.actor)}
      RETURNING
        schedule.id,
        schedule.name,
        schedule.source_description AS "sourceDescription",
        schedule.cron,
        schedule.timezone,
        schedule.prompt,
        schedule.enabled,
        schedule.last_run_at AS "lastRunAt",
        schedule.next_run_at AS "nextRunAt",
        schedule.version,
        schedule.created_at AS "createdAt",
        schedule.updated_at AS "updatedAt",
        pg_current_xact_id()::xid::text::bigint AS "transactionId"
    `);
    if (row) {
      return {
        status: "updated" as const,
        value: mapTaskSchedule(row),
        transactionId: String(row.transactionId),
      };
    }
    return this.taskScheduleMiss(input.actor, input.scheduleId);
  }

  async setTaskScheduleEnabled(
    input: Parameters<TaskScheduleRepository["setTaskScheduleEnabled"]>[0],
  ) {
    const now = this.options.now?.() ?? new Date();
    const [row] = await this.rows<TaskScheduleRow & { transactionId: number | string }>(sql`
      UPDATE goat.task_schedules AS schedule
      SET enabled = ${input.enabled},
          workspace_id = ${input.actor.workspaceId},
          next_run_at = COALESCE(${input.nextRunAt ?? null}, schedule.next_run_at),
          version = schedule.version + 1,
          updated_at = ${now}
      WHERE schedule.id = ${input.scheduleId}
        AND schedule.user_workos_id = ${input.actor.userId}
        AND (schedule.workspace_id = ${input.actor.workspaceId} OR schedule.workspace_id IS NULL)
        AND schedule.deleted_at IS NULL
        AND schedule.version = ${input.expectedVersion}
        AND ${enabledWorkspaceMember(input.actor)}
      RETURNING
        schedule.id,
        schedule.name,
        schedule.source_description AS "sourceDescription",
        schedule.cron,
        schedule.timezone,
        schedule.prompt,
        schedule.enabled,
        schedule.last_run_at AS "lastRunAt",
        schedule.next_run_at AS "nextRunAt",
        schedule.version,
        schedule.created_at AS "createdAt",
        schedule.updated_at AS "updatedAt",
        pg_current_xact_id()::xid::text::bigint AS "transactionId"
    `);
    if (row) {
      return {
        status: "updated" as const,
        value: mapTaskSchedule(row),
        transactionId: String(row.transactionId),
      };
    }
    return this.taskScheduleMiss(input.actor, input.scheduleId);
  }

  async archiveTaskSchedule(input: Parameters<TaskScheduleRepository["archiveTaskSchedule"]>[0]) {
    const now = this.options.now?.() ?? new Date();
    const [row] = await this.rows<{
      id: string;
      version: number | string;
      transactionId: number | string;
    }>(sql`
      UPDATE goat.task_schedules AS schedule
      SET enabled = false,
          workspace_id = ${input.actor.workspaceId},
          deleted_at = ${now},
          version = schedule.version + 1,
          updated_at = ${now}
      WHERE schedule.id = ${input.scheduleId}
        AND schedule.user_workos_id = ${input.actor.userId}
        AND (schedule.workspace_id = ${input.actor.workspaceId} OR schedule.workspace_id IS NULL)
        AND schedule.deleted_at IS NULL
        AND schedule.version = ${input.expectedVersion}
        AND ${enabledWorkspaceMember(input.actor)}
      RETURNING
        schedule.id,
        schedule.version,
        pg_current_xact_id()::xid::text::bigint AS "transactionId"
    `);
    if (row) {
      return {
        status: "updated" as const,
        value: { scheduleId: row.id, version: Number(row.version) },
        transactionId: String(row.transactionId),
      };
    }
    return this.taskScheduleMiss(input.actor, input.scheduleId);
  }

  async loadTaskScheduleExecution(input: { actor: Actor; scheduleId: string }): Promise<{
    schedule: TaskSchedule;
    execution: { engine: "opencompany" | "codex" | "claude_code"; model: string; payload: unknown };
  } | null> {
    const [row] = await this.rows<TaskScheduleRow>(sql`
      SELECT
        schedule.id,
        schedule.name,
        schedule.source_description AS "sourceDescription",
        schedule.cron,
        schedule.timezone,
        schedule.prompt,
        schedule.planned_harness_spec AS "plannedHarnessSpec",
        schedule.enabled,
        schedule.last_run_at AS "lastRunAt",
        schedule.next_run_at AS "nextRunAt",
        schedule.version,
        schedule.created_at AS "createdAt",
        schedule.updated_at AS "updatedAt"
      FROM goat.task_schedules AS schedule
      WHERE schedule.id = ${input.scheduleId}
        AND schedule.user_workos_id = ${input.actor.userId}
        AND (schedule.workspace_id = ${input.actor.workspaceId} OR schedule.workspace_id IS NULL)
        AND schedule.deleted_at IS NULL
        AND ${enabledWorkspaceMember(input.actor)}
      LIMIT 1
    `);
    if (!row) return null;
    const plan = executionFromPayload(row.plannedHarnessSpec);
    return { schedule: mapTaskSchedule(row), execution: plan };
  }

  async recordTaskScheduleRunNow(input: {
    actor: Actor;
    scheduleId: string;
    taskId: string;
    occurredAt: Date;
  }): Promise<void> {
    const ids = this.options.ids ?? defaultIds;
    await this.execute(sql`
      INSERT INTO goat.task_schedule_runs (
        id, schedule_id, user_workos_id, scheduled_for,
        task_id, status, created_at, updated_at
      )
      SELECT
        ${ids.scheduleRun("task")}, schedule.id, ${input.actor.userId},
        ${input.occurredAt}, ${input.taskId}, 'created', ${input.occurredAt}, ${input.occurredAt}
      FROM goat.task_schedules AS schedule
      WHERE schedule.id = ${input.scheduleId}
        AND schedule.user_workos_id = ${input.actor.userId}
        AND (schedule.workspace_id = ${input.actor.workspaceId} OR schedule.workspace_id IS NULL)
        AND schedule.deleted_at IS NULL
        AND ${workspaceMembership(input.actor)}
      ON CONFLICT (schedule_id, scheduled_for) DO UPDATE
      SET task_id = EXCLUDED.task_id,
          status = 'created',
          updated_at = EXCLUDED.updated_at
    `);
  }

  private async workflowMiss(
    actor: Actor,
    workflowId: string,
  ): Promise<VersionedRepositoryResult<never>> {
    const [row] = await this.rows<{ version: number | string }>(sql`
      SELECT workflow.version
      FROM goat.workflows AS workflow
      WHERE workflow.id = ${workflowId}
        AND workflow.workspace_id = ${actor.workspaceId}
        AND workflow.archived_at IS NULL
        AND ${workspaceMembership(actor)}
      LIMIT 1
    `);
    return row ? { status: "conflict" } : { status: "not_found" };
  }

  private async taskScheduleMiss(
    actor: Actor,
    scheduleId: string,
  ): Promise<VersionedRepositoryResult<never>> {
    const [row] = await this.rows<{ version: number | string }>(sql`
      SELECT schedule.version
      FROM goat.task_schedules AS schedule
      WHERE schedule.id = ${scheduleId}
        AND schedule.user_workos_id = ${actor.userId}
        AND (schedule.workspace_id = ${actor.workspaceId} OR schedule.workspace_id IS NULL)
        AND schedule.deleted_at IS NULL
        AND ${workspaceMembership(actor)}
      LIMIT 1
    `);
    return row ? { status: "conflict" } : { status: "not_found" };
  }

  private async rows<T>(query: SQL): Promise<T[]> {
    return rowsFromExecute<T>(await this.execute(query));
  }
}

export class PostgresTaskScheduleRepository implements TaskScheduleRepository {
  private readonly repository: PostgresWorkflowRepository;

  constructor(execute: WorkflowSqlExecute, options: WorkflowRepositoryOptions = {}) {
    this.repository = new PostgresWorkflowRepository(execute, options);
  }

  listTaskSchedules(input: Parameters<TaskScheduleRepository["listTaskSchedules"]>[0]) {
    return this.repository.listTaskSchedules(input);
  }

  assertTaskScheduleWriteAllowed(actor: Actor) {
    return this.repository.assertTaskScheduleWriteAllowed(actor);
  }

  replayTaskScheduleCreate(
    input: Parameters<TaskScheduleRepository["replayTaskScheduleCreate"]>[0],
  ) {
    return this.repository.replayTaskScheduleCreate(input);
  }

  getTaskSchedule(input: Parameters<TaskScheduleRepository["getTaskSchedule"]>[0]) {
    return this.repository.getTaskSchedule(input);
  }

  createTaskSchedule(input: Parameters<TaskScheduleRepository["createTaskSchedule"]>[0]) {
    return this.repository.createTaskSchedule(input);
  }

  updateTaskSchedule(input: Parameters<TaskScheduleRepository["updateTaskSchedule"]>[0]) {
    return this.repository.updateTaskSchedule(input);
  }

  setTaskScheduleEnabled(input: Parameters<TaskScheduleRepository["setTaskScheduleEnabled"]>[0]) {
    return this.repository.setTaskScheduleEnabled(input);
  }

  archiveTaskSchedule(input: Parameters<TaskScheduleRepository["archiveTaskSchedule"]>[0]) {
    return this.repository.archiveTaskSchedule(input);
  }

  loadTaskScheduleExecution(
    input: Parameters<TaskScheduleRepository["loadTaskScheduleExecution"]>[0],
  ) {
    return this.repository.loadTaskScheduleExecution(input);
  }

  recordRunNow(input: Parameters<TaskScheduleRepository["recordRunNow"]>[0]) {
    return this.repository.recordTaskScheduleRunNow(input);
  }
}

function workflowSelect() {
  return sql`
    SELECT
      workflow.id,
      workflow.slug,
      workflow.name,
      workflow.description,
      workflow.instructions,
      workflow.model,
      workflow.steps,
      workflow.status,
      workflow.trigger,
      workflow.schedule_cron AS "scheduleCron",
      workflow.schedule_timezone AS "scheduleTimezone",
      workflow.schedule_prompt AS "schedulePrompt",
      workflow.schedule_enabled AS "scheduleEnabled",
      workflow.schedule_last_run_at AS "scheduleLastRunAt",
      workflow.schedule_next_run_at AS "scheduleNextRunAt",
      workflow.event_config AS "eventConfig",
      workflow.version,
      workflow.archived_at AS "archivedAt",
      workflow.created_at AS "createdAt",
      workflow.updated_at AS "updatedAt"
    FROM goat.workflows AS workflow
  `;
}

function taskScheduleSelect() {
  return sql`
    SELECT
      schedule.id,
      schedule.name,
      schedule.source_description AS "sourceDescription",
      schedule.cron,
      schedule.timezone,
      schedule.prompt,
      schedule.enabled,
      schedule.last_run_at AS "lastRunAt",
      schedule.next_run_at AS "nextRunAt",
      schedule.version,
      schedule.created_at AS "createdAt",
      schedule.updated_at AS "updatedAt"
    FROM goat.task_schedules AS schedule
  `;
}

function workspaceMembership(actor: Actor) {
  return sql`EXISTS (
    SELECT 1
    FROM goat.workspace_members AS current_member
    WHERE current_member.workspace_id = ${actor.workspaceId}
      AND current_member.user_workos_id = ${actor.userId}
  )`;
}

function enabledWorkspaceMember(actor: Actor) {
  return sql`EXISTS (
    SELECT 1
    FROM goat.users AS feature_user
    JOIN goat.workspace_members AS current_member
      ON current_member.user_workos_id = feature_user.workos_user_id
     AND current_member.workspace_id = ${actor.workspaceId}
    WHERE feature_user.workos_user_id = ${actor.userId}
      AND feature_user.task_spawning_enabled = true
  )`;
}

function mapWorkflow(row: WorkflowRow): Workflow {
  const steps = workflowSteps(row);
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    steps,
    status: row.status,
    trigger: workflowTrigger(row),
    version: Number(row.version),
    archivedAt: nullableDate(row.archivedAt),
    createdAt: asDate(row.createdAt),
    updatedAt: asDate(row.updatedAt),
  };
}

function workflowSteps(row: Pick<WorkflowRow, "slug" | "steps" | "instructions" | "model">) {
  if (Array.isArray(row.steps) && row.steps.length > 0) {
    return row.steps.map(workflowStep);
  }
  if (!row.instructions.trim() && !row.model.trim()) return [];
  return [
    {
      id: `step-${row.slug.slice(0, 64)}`,
      title: "",
      model: row.model,
      instructions: row.instructions,
    },
  ];
}

function workflowStep(value: unknown): WorkflowStep {
  if (!isRecord(value)) throw new Error("Workflow storage contains an invalid step.");
  const runtimeModel = stringValue(value.runtimeModel);
  const reasoningEffort = stringValue(value.reasoningEffort);
  return {
    id: requiredString(value.id, "id"),
    title: requiredString(value.title, "title", true),
    model: requiredString(value.model, "model", true),
    instructions: requiredString(value.instructions, "instructions", true),
    ...(runtimeModel ? { runtimeModel } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

function workflowTrigger(row: WorkflowRow): WorkflowTrigger {
  if (row.trigger === "event") return workflowEventTrigger(row.eventConfig);
  if (row.trigger !== "schedule") return { type: "manual" };
  return {
    type: "schedule",
    cron: row.scheduleCron?.trim() || "0 9 * * 1",
    timezone: row.scheduleTimezone.trim() || "UTC",
    prompt: row.schedulePrompt.trim() || "Run this workflow.",
    enabled: row.scheduleEnabled,
    lastRunAt: nullableDate(row.scheduleLastRunAt),
    nextRunAt: nullableDate(row.scheduleNextRunAt),
  };
}

function workflowEventTrigger(value: unknown): Extract<WorkflowTrigger, { type: "event" }> {
  if (!isRecord(value) || value.provider !== "linear" || value.event !== "issue_enters_triage") {
    throw new Error("Workflow storage contains an invalid event trigger.");
  }
  const team = isRecord(value.team) ? value.team : null;
  const key = team ? stringValue(team.key) : null;
  return {
    type: "event",
    provider: "linear",
    event: "issue_enters_triage",
    integrationId: requiredString(value.integrationId, "integrationId"),
    team: {
      id: requiredString(team?.id, "team.id"),
      name: requiredString(team?.name, "team.name"),
      triageStateId: requiredString(team?.triageStateId, "team.triageStateId"),
      ...(key ? { key } : {}),
    },
    prompt: requiredString(value.prompt, "prompt"),
  };
}

function mapTaskSchedule(row: TaskScheduleRow): TaskSchedule {
  return {
    id: row.id,
    name: row.name,
    sourceDescription: row.sourceDescription,
    cron: row.cron,
    timezone: row.timezone,
    prompt: row.prompt,
    enabled: row.enabled,
    lastRunAt: nullableDate(row.lastRunAt),
    nextRunAt: asDate(row.nextRunAt),
    version: Number(row.version),
    createdAt: asDate(row.createdAt),
    updatedAt: asDate(row.updatedAt),
  };
}

function executionFromPayload(payload: unknown) {
  if (!isRecord(payload))
    throw new Error("Recurring Task storage contains an invalid execution plan.");
  const engine = payload.engine;
  if (engine !== "opencompany" && engine !== "codex" && engine !== "claude_code") {
    throw new Error("Recurring Task storage contains an invalid execution engine.");
  }
  const model = requiredString(payload.model, "model");
  return {
    engine: engine as "opencompany" | "codex" | "claude_code",
    model,
    payload,
  };
}

function assertReservation(
  row: CreateReservationRow,
  operation: "workflow.create" | "task_schedule.create",
  requestHash: string,
) {
  if (!row.commandId || !row.resourceId || row.transactionId === null) {
    throw new Error("Automation command reservation did not materialize.");
  }
  if (row.operation !== operation || row.requestHash !== requestHash) {
    throw new CoreError(
      "idempotency_conflict",
      "The Idempotency-Key was already used for another command.",
    );
  }
}

function commandHash(operation: string, input: unknown) {
  return createHash("sha256").update(stableJson({ operation, input })).digest("hex");
}

function taskScheduleCreateHash(input: {
  name: string;
  sourceDescription: string;
  prompt: string;
  schedule: { cron: string; timezone: string };
}) {
  return commandHash("task_schedule.create", {
    name: input.name,
    sourceDescription: input.sourceDescription,
    prompt: input.prompt,
    cron: input.schedule.cron,
    timezone: input.schedule.timezone,
  });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function normalizeSlug(value: string) {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64)
    .replace(/-+$/gu, "");
  return slug || "workflow";
}

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

function asDate(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Automation storage contains an invalid date.");
  return date;
}

function nullableDate(value: Date | string | null) {
  return value === null ? null : asDate(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function requiredString(value: unknown, field: string, empty = false) {
  if (typeof value !== "string" || (!empty && !value)) {
    throw new Error(`Automation storage contains an invalid ${field}.`);
  }
  return value;
}
