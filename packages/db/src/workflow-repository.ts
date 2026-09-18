import { createHash, randomUUID } from "node:crypto";
import {
  type Actor,
  CoreError,
  type VersionedRepositoryResult,
  WORKFLOW_RUN_STATUSES,
  type Workflow,
  type WorkflowAutomationTrigger,
  type WorkflowKind,
  type WorkflowMemory,
  type WorkflowMutationResult,
  type WorkflowPage,
  type WorkflowRepository,
  type WorkflowRun,
  type WorkflowRunStatus,
  type WorkflowScope,
  type WorkflowStep,
  type WorkflowTrigger,
} from "@opencompany/core";
import { newResourceId } from "@opencompany/core/resource-ids";
import { type SQL, sql } from "drizzle-orm";
import { stringifyPostgresJson } from "./postgres-json";

export type WorkflowSqlExecute = (query: SQL) => Promise<unknown>;

type RepositoryIds = {
  command: () => string;
  workflow: () => string;
  scheduleRun: (kind: "workflow") => string;
};

type WorkflowRepositoryOptions = {
  ids?: RepositoryIds;
  now?: () => Date;
  // Pins every query and write to one automation surface. Workflows and Company agents share this
  // table, and this is the boundary that keeps an agent out of the Workflows API and vice versa.
  kind?: WorkflowKind;
};

type WorkflowRow = {
  id: string;
  slug: string;
  kind: WorkflowKind;
  name: string;
  description: string;
  instructions: string;
  model: string;
  steps: unknown;
  status: "draft" | "active";
  scope: "personal" | "company";
  slackChannelEnabled: boolean;
  slackBotDisplayName: string;
  slackBotAvatarUrl: string;
  createdByUserId: string | null;
  ownerUserId: string | null;
  ownerActive: boolean;
  lastRunAt?: Date | string | null;
  trigger: "manual" | "slack" | "linear" | "schedule" | "event";
  scheduleCron: string | null;
  scheduleTimezone: string;
  schedulePrompt: string;
  scheduleEnabled: boolean;
  scheduleLastRunAt: Date | string | null;
  scheduleNextRunAt: Date | string | null;
  eventConfig: unknown;
  automationTriggers: unknown;
  version: number | string;
  archivedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

type WorkflowRunRow = {
  id: string;
  taskId: string | null;
  displayId: string | null;
  conversationId: string | null;
  name: string;
  status: string;
  triggerKind: string;
  triggerLabel: string;
  result: string | null;
  error: string | null;
  awaitingInput: boolean;
  createdAt: Date | string;
  updatedAt: Date | string;
};

type WorkflowMemoryRow = {
  workflowId: string;
  enabled: boolean;
  content: string;
  contentUpdatedAt: Date | string | null;
};

type CreateReservationRow = {
  authorized: boolean;
  commandId: string | null;
  requestHash: string | null;
  operation: "workflow.create" | null;
  resourceId: string | null;
  transactionId: number | string | null;
  replayed: boolean | null;
};

const defaultIds: RepositoryIds = {
  command: () => `goat_automation_command_${randomUUID()}`,
  workflow: () => newResourceId("workflow"),
  scheduleRun: (kind) => newResourceId(`${kind}_schedule_run`),
};

export class PostgresWorkflowRepository implements WorkflowRepository {
  private readonly kind: WorkflowKind;

  constructor(
    private readonly execute: WorkflowSqlExecute,
    private readonly options: WorkflowRepositoryOptions = {},
  ) {
    this.kind = options.kind ?? "workflow";
  }

  async listWorkflows(input: {
    actor: Actor;
    cursor?: string;
    limit: number;
  }): Promise<WorkflowPage> {
    const rows = await this.rows<WorkflowRow>(sql`
      ${workflowSelect(this.kind)}
      WHERE workflow.workspace_id = ${input.actor.workspaceId}
        AND workflow.archived_at IS NULL
        AND ${workspaceMembership(input.actor)}
        AND ${workflowVisibility(input.actor, this.kind)}
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
      ${workflowSelect(this.kind)}
      WHERE workflow.workspace_id = ${input.actor.workspaceId}
        AND (workflow.id = ${input.workflowId} OR workflow.slug = ${input.workflowId})
        AND workflow.archived_at IS NULL
        AND ${workspaceMembership(input.actor)}
        AND ${workflowVisibility(input.actor, this.kind)}
      LIMIT 1
    `);
    return row ? mapWorkflow(row) : null;
  }

  async createWorkflow(input: {
    actor: Actor;
    idempotencyKey: string;
    name: string;
    description: string;
    scope: WorkflowScope;
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
          id, workspace_id, slug, kind, name, description, instructions, model, steps,
          trigger, schedule_cron, schedule_timezone, schedule_prompt,
          schedule_user_workos_id, schedule_harness_spec, schedule_enabled,
          schedule_next_run_at, status, scope, created_by_workos_id, owner_workos_id, version,
          created_at, updated_at
        )
        SELECT
          winner.resource_id, ${input.actor.workspaceId}, candidate.slug, ${this.kind},
          ${input.name}, ${input.description}, '', '',
          ${stringifyPostgresJson([input.initialStep])}::jsonb,
          'manual', NULL, 'UTC', '', NULL, NULL, false, NULL, 'draft', ${input.scope},
          ${input.actor.userId},
          -- An agent's creator is its owner. Workflows have no owner: they execute as whoever
          -- activated the trigger that fires them.
          ${this.kind === "agent" ? input.actor.userId : null}, 1, ${now}, ${now}
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
        ${workflowProjection(this.kind)}
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
    const automationTriggers = input.automationTriggers
      ? storedAutomationTriggers(input.automationTriggers)
      : null;
    const scheduled = input.trigger.type === "schedule";
    const eventDriven = input.trigger.type === "event";
    const scheduleEnabled = input.trigger.type === "schedule" && input.trigger.enabled !== false;
    const schedulePrompt =
      input.trigger.type === "schedule" ? input.trigger.prompt?.trim() || "Run this workflow." : "";
    const [row] = await this.rows<WorkflowRow & { transactionId: number | string }>(sql`
      UPDATE goat.workflows AS workflow
      SET name = ${input.name},
          description = ${input.description},
          steps = ${stringifyPostgresJson(input.steps)}::jsonb,
          scope = ${input.scope},
          slack_channel_enabled = ${input.slackChannel.enabled},
          slack_bot_display_name = ${input.slackChannel.displayName},
          slack_bot_avatar_url = ${input.slackChannel.avatarUrl},
          -- A legacy company workflow has no recorded creator. Whoever takes it personal owns it.
          created_by_workos_id = CASE
            WHEN ${input.scope} = 'personal'
              THEN COALESCE(workflow.created_by_workos_id, ${input.actor.userId})
            ELSE workflow.created_by_workos_id
          END,
          automation_triggers = CASE
            WHEN ${automationTriggers ? stringifyPostgresJson(automationTriggers) : null}::jsonb IS NULL
              THEN workflow.automation_triggers
            ELSE (
              SELECT COALESCE(
                jsonb_agg(
                  CASE
                    WHEN workflow.status = 'active'
                      AND ${input.status} = 'active'
                      AND next_trigger.value->>'type' = 'event'
                      AND previous_trigger.value IS NOT NULL
                      AND (
                        next_trigger.value
                          - 'prompt' - 'userWorkosId' - 'activatedAt' - 'harnessSpec'
                      ) = (
                        previous_trigger.value
                          - 'prompt' - 'userWorkosId' - 'activatedAt' - 'harnessSpec'
                      )
                    THEN jsonb_set(
                      next_trigger.value,
                      '{activatedAt}',
                      COALESCE(
                        previous_trigger.value->'activatedAt',
                        next_trigger.value->'activatedAt'
                      )
                    )
                    ELSE next_trigger.value
                  END
                  ORDER BY next_trigger.ordinality
                ),
                '[]'::jsonb
              )
              FROM jsonb_array_elements(
                ${automationTriggers ? stringifyPostgresJson(automationTriggers) : null}::jsonb
              ) WITH ORDINALITY AS next_trigger(value, ordinality)
              LEFT JOIN LATERAL (
                SELECT previous.value
                FROM jsonb_array_elements(workflow.automation_triggers) AS previous(value)
                WHERE previous.value->>'id' = next_trigger.value->>'id'
                LIMIT 1
              ) AS previous_trigger ON true
            )
          END,
          trigger = ${scheduled ? "schedule" : eventDriven ? "event" : "manual"},
          schedule_cron = ${scheduled ? (input.schedule?.definition.cron ?? null) : null},
          schedule_timezone = ${scheduled ? (input.schedule?.definition.timezone ?? "UTC") : "UTC"},
          schedule_prompt = ${schedulePrompt},
          schedule_enabled = ${scheduleEnabled},
          schedule_user_workos_id = ${scheduled ? input.actor.userId : null},
          schedule_harness_spec = ${
            input.schedule?.execution
              ? stringifyPostgresJson(input.schedule.execution.payload)
              : null
          }::jsonb,
          schedule_next_run_at = ${
            scheduled && scheduleEnabled && input.status === "active"
              ? (input.schedule?.definition.nextRunAt ?? null)
              : null
          },
          event_config = ${eventDriven ? stringifyPostgresJson(input.trigger) : null}::jsonb,
          event_activated_at = CASE WHEN ${eventDriven} THEN
            CASE WHEN workflow.status = 'active' AND ${input.status} = 'active'
              AND workflow.event_user_workos_id = ${input.actor.userId}
              AND (workflow.event_config - 'prompt') =
                  (${eventDriven ? stringifyPostgresJson(input.trigger) : null}::jsonb - 'prompt')
              THEN COALESCE(workflow.event_activated_at, ${now})
              ELSE ${now} END
            ELSE NULL END,
          event_user_workos_id = ${eventDriven ? input.actor.userId : null},
          event_harness_spec = ${
            input.event?.execution ? stringifyPostgresJson(input.event.execution.payload) : null
          }::jsonb,
          status = ${input.status},
          version = workflow.version + 1,
          updated_at = ${now}
      WHERE workflow.id = ${input.workflowId}
        AND workflow.workspace_id = ${input.actor.workspaceId}
        AND workflow.archived_at IS NULL
        AND workflow.version = ${input.expectedVersion}
        AND ${workspaceMembership(input.actor)}
        AND ${workflowVisibility(input.actor, this.kind)}
      RETURNING
        ${workflowProjection(this.kind)},
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
        AND ${workflowVisibility(input.actor, this.kind)}
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

  // Run history is the union of the Tasks an agent produced and the provider events that matched
  // it but never became work. The second half is the point: an event dropped because the owner's
  // connection is missing has to be visible, not silent.
  async listRuns(input: {
    actor: Actor;
    workflowId: string;
    limit: number;
  }): Promise<WorkflowRun[]> {
    const rows = await this.rows<WorkflowRunRow>(sql`
      WITH agent AS MATERIALIZED (
        SELECT workflow.id, workflow.name
        FROM goat.workflows AS workflow
        WHERE ${visibleWorkflow(input.actor, input.workflowId, this.kind)}
        LIMIT 1
      ),
      task_runs AS (
        SELECT
          task.id,
          task.id AS "taskId",
          task.display_id AS "displayId",
          task.session_id AS "conversationId",
          task.name,
          goat.canonical_task_status_v1(task.status, task.archived_at) AS status,
          -- Both columns branch on the same conditions so the label can never describe a
          -- different trigger than the kind. 'manual-test' is the trigger id recordRunNow stamps
          -- on a Run now, which is a manual run that happens to land in the schedule table.
          CASE
            WHEN event_run.id IS NOT NULL THEN 'event'
            WHEN schedule_run.id IS NOT NULL AND schedule_run.trigger_id <> 'manual-test'
              THEN 'schedule'
            ELSE 'manual'
          END AS "triggerKind",
          CASE
            WHEN event_run.id IS NOT NULL
              THEN event_run.provider || ' · ' || event_run.event_type
            WHEN schedule_run.id IS NOT NULL AND schedule_run.trigger_id <> 'manual-test'
              THEN 'Schedule'
            ELSE 'Run now'
          END AS "triggerLabel",
          task.result,
          task.error,
          CASE
            WHEN task.session_id IS NULL THEN false
            ELSE goat.conversation_awaiting_input_v1(task.session_id)
          END AS "awaitingInput",
          task.created_at AS "createdAt",
          task.updated_at AS "updatedAt"
        FROM goat.tasks AS task
        JOIN agent ON agent.id = task.agent_id
        LEFT JOIN goat.workflow_event_runs AS event_run ON event_run.task_id = task.id
        LEFT JOIN goat.workflow_schedule_runs AS schedule_run ON schedule_run.task_id = task.id
      ),
      blocked_runs AS (
        SELECT
          event_run.id,
          NULL::text AS "taskId",
          NULL::text AS "displayId",
          NULL::text AS "conversationId",
          agent.name,
          'blocked' AS status,
          'event' AS "triggerKind",
          event_run.provider || ' · ' || event_run.event_type AS "triggerLabel",
          NULL::text AS result,
          COALESCE(
            event_run.last_error,
            'The owner''s ' || event_run.provider ||
              ' connection is missing or no longer authorizes this event, so this run was skipped.'
          ) AS error,
          false AS "awaitingInput",
          event_run.created_at AS "createdAt",
          event_run.updated_at AS "updatedAt"
        FROM goat.workflow_event_runs AS event_run
        JOIN agent ON agent.id = event_run.workflow_id
        WHERE event_run.task_id IS NULL
          AND event_run.status IN ('ignored', 'failed')
      )
      SELECT * FROM (
        SELECT * FROM task_runs
        UNION ALL
        SELECT * FROM blocked_runs
      ) AS run
      ORDER BY run."createdAt" DESC, run.id DESC
      LIMIT ${input.limit}
    `);
    return rows.map(mapWorkflowRun);
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
        id, workflow_id, trigger_id, workspace_id, user_workos_id, scheduled_for,
        task_id, status, created_at, updated_at
      )
      SELECT
        ${ids.scheduleRun("workflow")}, workflow.id, 'manual-test', workflow.workspace_id,
        ${input.actor.userId}, ${input.occurredAt}, ${input.taskId}, 'created',
        ${input.occurredAt}, ${input.occurredAt}
      FROM goat.workflows AS workflow
      WHERE workflow.id = ${input.workflowId}
        AND workflow.workspace_id = ${input.actor.workspaceId}
        AND workflow.archived_at IS NULL
        AND ${workspaceMembership(input.actor)}
        AND ${workflowVisibility(input.actor, this.kind)}
      ON CONFLICT (workflow_id, trigger_id, scheduled_for) DO UPDATE
      SET task_id = EXCLUDED.task_id,
          status = 'created',
          updated_at = EXCLUDED.updated_at
    `);
  }

  async getWorkflowMemory(input: {
    actor: Actor;
    workflowId: string;
  }): Promise<WorkflowMemory | null> {
    const [row] = await this.rows<WorkflowMemoryRow>(sql`
      ${workflowMemorySelect()}
      WHERE ${visibleWorkflow(input.actor, input.workflowId, this.kind)}
      LIMIT 1
    `);
    return row ? mapWorkflowMemory(row) : null;
  }

  async setWorkflowMemoryEnabled(input: {
    actor: Actor;
    workflowId: string;
    enabled: boolean;
  }): Promise<WorkflowMemory | null> {
    const now = this.options.now?.() ?? new Date();
    // The memory row is created lazily on first toggle, so a workflow that never used memory
    // carries no row at all.
    const [row] = await this.rows<WorkflowMemoryRow>(sql`
      INSERT INTO goat.workflow_memories (workflow_id, workspace_id, enabled, created_at, updated_at)
      SELECT workflow.id, workflow.workspace_id, ${input.enabled}, ${now}, ${now}
      FROM goat.workflows AS workflow
      WHERE ${visibleWorkflow(input.actor, input.workflowId, this.kind)}
      ON CONFLICT (workflow_id) DO UPDATE
      SET enabled = EXCLUDED.enabled,
          updated_at = EXCLUDED.updated_at
      RETURNING
        workflow_id AS "workflowId",
        enabled,
        content,
        content_updated_at AS "contentUpdatedAt"
    `);
    return row ? mapWorkflowMemory(row) : null;
  }

  async clearWorkflowMemory(input: {
    actor: Actor;
    workflowId: string;
  }): Promise<WorkflowMemory | null> {
    const now = this.options.now?.() ?? new Date();
    const [row] = await this.rows<WorkflowMemoryRow>(sql`
      UPDATE goat.workflow_memories AS memory
      SET content = '',
          content_updated_at = NULL,
          updated_at = ${now}
      FROM goat.workflows AS workflow
      WHERE memory.workflow_id = workflow.id
        AND ${visibleWorkflow(input.actor, input.workflowId, this.kind)}
      RETURNING
        memory.workflow_id AS "workflowId",
        memory.enabled,
        memory.content,
        memory.content_updated_at AS "contentUpdatedAt"
    `);
    if (row) return mapWorkflowMemory(row);
    // No memory row yet: clearing is a no-op, but the workflow still has to exist and be visible.
    return this.getWorkflowMemory(input);
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
        AND ${workflowVisibility(actor, this.kind)}
      LIMIT 1
    `);
    return row ? { status: "conflict" } : { status: "not_found" };
  }

  private async rows<T>(query: SQL): Promise<T[]> {
    return rowsFromExecute<T>(await this.execute(query));
  }
}

function workflowSelect(kind: WorkflowKind) {
  return sql`
    SELECT
      ${workflowProjection(kind)}
    FROM goat.workflows AS workflow
  `;
}

// Shared by every projection of an automation row so the list, single read, create, and update
// paths cannot drift apart.
function workflowProjection(kind: WorkflowKind) {
  return sql`
      workflow.id,
      workflow.slug,
      workflow.kind,
      workflow.name,
      workflow.description,
      workflow.instructions,
      workflow.model,
      workflow.steps,
      workflow.status,
      workflow.scope,
      workflow.slack_channel_enabled AS "slackChannelEnabled",
      workflow.slack_bot_display_name AS "slackBotDisplayName",
      workflow.slack_bot_avatar_url AS "slackBotAvatarUrl",
      workflow.created_by_workos_id AS "createdByUserId",
      workflow.owner_workos_id AS "ownerUserId",
      ${ownerActiveProjection()},
      ${lastRunAtProjection(kind)},
      workflow.trigger,
      workflow.schedule_cron AS "scheduleCron",
      workflow.schedule_timezone AS "scheduleTimezone",
      workflow.schedule_prompt AS "schedulePrompt",
      workflow.schedule_enabled AS "scheduleEnabled",
      workflow.schedule_last_run_at AS "scheduleLastRunAt",
      workflow.schedule_next_run_at AS "scheduleNextRunAt",
      workflow.event_config AS "eventConfig",
      workflow.automation_triggers AS "automationTriggers",
      workflow.version,
      workflow.archived_at AS "archivedAt",
      workflow.created_at AS "createdAt",
      workflow.updated_at AS "updatedAt"`;
}

// An owner who left the workspace can no longer authorize anything, so the agent reads as
// ownerless and callers refuse to run it rather than silently using someone else's connections.
function ownerActiveProjection() {
  return sql`EXISTS (
      SELECT 1
      FROM goat.workspace_members AS owner_member
      WHERE owner_member.workspace_id = workflow.workspace_id
        AND owner_member.user_workos_id = workflow.owner_workos_id
    ) AS "ownerActive"`;
}

// Only the Company agents surface shows a last run, and only agent runs carry `tasks.agent_id`.
function lastRunAtProjection(kind: WorkflowKind) {
  if (kind !== "agent") return sql`NULL::timestamptz AS "lastRunAt"`;
  return sql`(
      SELECT max(run.created_at)
      FROM goat.tasks AS run
      WHERE run.agent_id = workflow.id
    ) AS "lastRunAt"`;
}

// Left join so a workflow with no memory row still reads as disabled-and-empty.
function workflowMemorySelect() {
  return sql`
    SELECT
      workflow.id AS "workflowId",
      COALESCE(memory.enabled, false) AS enabled,
      COALESCE(memory.content, '') AS content,
      memory.content_updated_at AS "contentUpdatedAt"
    FROM goat.workflows AS workflow
    LEFT JOIN goat.workflow_memories AS memory ON memory.workflow_id = workflow.id
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

// A company workflow belongs to the workspace; a personal one only to its creator. A personal row
// whose creator was removed matches nobody, which keeps it out of every list and mutation.
function workflowVisibility(actor: Actor, kind: WorkflowKind) {
  return sql`workflow.kind = ${kind} AND (
    workflow.scope = 'company'
    OR workflow.created_by_workos_id = ${actor.userId}
  )`;
}

// Callers address a workflow by either its id or its workspace-scoped slug, which is what the
// editor route carries.
function visibleWorkflow(actor: Actor, workflowId: string, kind: WorkflowKind) {
  return sql`(workflow.id = ${workflowId} OR workflow.slug = ${workflowId})
    AND workflow.workspace_id = ${actor.workspaceId}
    AND workflow.archived_at IS NULL
    AND ${workspaceMembership(actor)}
    AND ${workflowVisibility(actor, kind)}`;
}

function mapWorkflowMemory(row: WorkflowMemoryRow): WorkflowMemory {
  return {
    workflowId: row.workflowId,
    enabled: row.enabled,
    content: row.content,
    updatedAt: nullableDate(row.contentUpdatedAt),
  };
}

function mapWorkflowRun(row: WorkflowRunRow): WorkflowRun {
  return {
    id: row.id,
    taskId: row.taskId,
    displayId: row.displayId,
    conversationId: row.conversationId,
    name: row.name,
    status: workflowRunStatus(row.status),
    triggerKind:
      row.triggerKind === "event" || row.triggerKind === "schedule" ? row.triggerKind : "manual",
    triggerLabel: row.triggerLabel,
    result: row.result,
    error: row.error,
    awaitingInput: row.awaitingInput === true,
    createdAt: asDate(row.createdAt),
    updatedAt: asDate(row.updatedAt),
  };
}

// `canonical_task_status_v1` folds an archived Task into `archived`, which is not a run outcome.
// Anything unrecognized reads as canceled rather than inventing a state the UI cannot render.
function workflowRunStatus(value: string): WorkflowRunStatus {
  return (WORKFLOW_RUN_STATUSES as readonly string[]).includes(value)
    ? (value as WorkflowRunStatus)
    : "canceled";
}

function mapWorkflow(row: WorkflowRow): Workflow {
  const steps = workflowSteps(row);
  return {
    id: row.id,
    slug: row.slug,
    kind: row.kind,
    name: row.name,
    description: row.description,
    steps,
    status: row.status,
    scope: row.scope,
    slackChannel: {
      enabled: row.slackChannelEnabled,
      displayName: row.slackBotDisplayName,
      avatarUrl: row.slackBotAvatarUrl,
    },
    createdByUserId: row.createdByUserId,
    ownerUserId: row.ownerUserId,
    ownerActive: row.ownerActive === true,
    lastRunAt: nullableDate(row.lastRunAt ?? null),
    trigger: workflowTrigger(row),
    triggers: workflowAutomationTriggers(row.automationTriggers),
    version: Number(row.version),
    archivedAt: nullableDate(row.archivedAt),
    createdAt: asDate(row.createdAt),
    updatedAt: asDate(row.updatedAt),
  };
}

function storedAutomationTriggers(
  triggers: NonNullable<Parameters<WorkflowRepository["updateWorkflow"]>[0]["automationTriggers"]>,
) {
  return triggers.map(({ trigger, userWorkosId, activatedAt, execution }) => ({
    ...trigger,
    lastRunAt: trigger.type === "schedule" ? (trigger.lastRunAt?.toISOString() ?? null) : undefined,
    nextRunAt: trigger.type === "schedule" ? (trigger.nextRunAt?.toISOString() ?? null) : undefined,
    userWorkosId,
    activatedAt: activatedAt.toISOString(),
    harnessSpec: execution?.payload ?? null,
  }));
}

function workflowAutomationTriggers(value: unknown): WorkflowAutomationTrigger[] {
  if (!Array.isArray(value)) return [];
  const triggers: WorkflowAutomationTrigger[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) continue;
    const id = stringValue(candidate.id);
    if (!id) continue;
    if (candidate.type === "event") {
      try {
        triggers.push({ ...workflowEventTrigger(candidate), id });
      } catch {
        continue;
      }
      continue;
    }
    if (candidate.type !== "schedule") continue;
    const cron = stringValue(candidate.cron);
    const timezone = stringValue(candidate.timezone);
    const prompt = stringValue(candidate.prompt);
    if (!cron || !timezone || !prompt) continue;
    triggers.push({
      id,
      type: "schedule",
      cron,
      timezone,
      prompt,
      enabled: candidate.enabled === true,
      lastRunAt: nullableDate(candidate.lastRunAt as Date | string | null),
      nextRunAt: nullableDate(candidate.nextRunAt as Date | string | null),
    });
  }
  return triggers;
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
  if (!isRecord(value)) {
    throw new Error("Workflow storage contains an invalid event trigger.");
  }
  const provider = requiredString(value.provider, "provider");
  const event = requiredString(value.event, "event");
  const storedFilters = isRecord(value.filters)
    ? value.filters
    : legacyLinearEventFilters(provider, event, value.team);
  if (!storedFilters) throw new Error("Workflow storage contains invalid event filters.");
  return {
    type: "event",
    provider,
    event,
    integrationId: requiredString(value.integrationId, "integrationId"),
    filters: Object.fromEntries(
      Object.entries(storedFilters).map(([id, filter]) => [id, workflowEventFilter(filter, id)]),
    ),
    prompt: requiredString(value.prompt, "prompt"),
  };
}

function legacyLinearEventFilters(provider: string, event: string, value: unknown) {
  if (provider !== "linear" || event !== "issue_enters_triage" || !isRecord(value)) return null;
  const key = stringValue(value.key);
  return {
    team: {
      id: requiredString(value.id, "team.id"),
      name: requiredString(value.name, "team.name"),
      ...(key ? { key } : {}),
      metadata: { triageStateId: requiredString(value.triageStateId, "team.triageStateId") },
    },
  };
}

function workflowEventFilter(value: unknown, filterId: string) {
  if (!isRecord(value)) throw new Error(`Workflow event filter ${filterId} is invalid.`);
  const key = stringValue(value.key);
  const metadata = isRecord(value.metadata)
    ? Object.fromEntries(
        Object.entries(value.metadata).map(([id, item]) => [id, requiredString(item, id)]),
      )
    : undefined;
  return {
    id: requiredString(value.id, `${filterId}.id`),
    name: requiredString(value.name, `${filterId}.name`),
    ...(key ? { key } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function assertReservation(
  row: CreateReservationRow,
  operation: "workflow.create",
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
