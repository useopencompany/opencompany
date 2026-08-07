import { randomUUID } from "node:crypto";
import {
  claudeCodeCliModelNameForModelId,
  codexCliModelNameForModelId,
  GOAT_ACTION_HOST_TOOL_CONTRACT_VERSION,
} from "@opencompany/agent-runtime";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { getDb } from "./client";
import type { GoatChatMessageAttachment, GoatHarnessSpec, GoatTask } from "./goat-schema";

type GoatTaskSessionDb = {
  execute(query: SQL): Promise<unknown>;
};

export type GoatTaskSessionSkillSnapshot = {
  id: string;
  brainRef: string;
  name: string;
  description: string;
  instructions: string;
};

export type CreateGoatTaskSessionInput = {
  userWorkosId: string;
  workspaceId?: string | null;
  brainRef?: string | null;
  prompt: string;
  name: string;
  harnessSpec: GoatHarnessSpec;
  scheduleId?: string | null;
  scheduledFor?: Date | null;
  workflowId?: string | null;
  workflowBrainRef?: string | null;
  attachments?: GoatChatMessageAttachment[] | null;
  attachmentTexts?: Record<string, string> | null;
  now?: Date;
};

// The one write path for every new session-backed task. Callers remain responsible
// for validating product permissions and waking the durable turn worker.
export async function createGoatTaskSession(
  input: CreateGoatTaskSessionInput,
  db: GoatTaskSessionDb = getDb() as GoatTaskSessionDb,
): Promise<GoatTask> {
  const taskId = `goat_task_${randomUUID()}`;
  const chatSessionId = `goat_chat_${randomUUID()}`;
  const runtimeSessionId = `goat_codex_chat_${randomUUID()}`;
  const turnId = `goat_codex_chat_turn_${randomUUID()}`;
  const userMessageId = `goat_chat_msg_${randomUUID()}`;
  const assistantMessageId = `goat_chat_msg_${randomUUID()}`;
  const now = input.now ?? new Date();
  const assistantCreatedAt = new Date(now.getTime() + 1);
  const harnessSpec = input.harnessSpec;
  const engine = harnessSpec.engine;
  const runtimeModel = runtimeModelNameForHarness(engine, harnessSpec.model);
  if (!runtimeModel) {
    throw new Error(`Unsupported ${engine} task model: ${harnessSpec.model}`);
  }
  const requestedWorkspaceId =
    input.workspaceId?.trim() || harnessSpec.workflow?.workspaceId?.trim() || null;
  const requestedBrainRef = input.brainRef?.trim() || null;
  const initialUserMessage = harnessSpec.initialUserMessage.trim() || input.prompt;
  const attachments = input.attachments ?? [];
  const attachmentTexts = input.attachmentTexts ?? null;
  const settings = turnSettingsFromHarness(harnessSpec);
  const assistantDebugTrace = emptyAssistantDebugTrace(engine, runtimeModel);

  const task = rowsFromExecute<GoatTaskRow>(
    await db.execute(sql`
      WITH enabled_user AS MATERIALIZED (
        SELECT "user".workos_user_id
        FROM goat.users AS "user"
        WHERE "user".workos_user_id = ${input.userWorkosId}
          AND "user".task_spawning_enabled = true
        FOR UPDATE OF "user"
      ),
      resolved_workspace AS MATERIALIZED (
        SELECT member.workspace_id
        FROM goat.workspace_members AS member
        INNER JOIN enabled_user AS "user"
          ON "user".workos_user_id = member.user_workos_id
        WHERE ${requestedWorkspaceId}::text IS NULL
           OR member.workspace_id = ${requestedWorkspaceId}
        ORDER BY
          CASE WHEN member.workspace_id = ${requestedWorkspaceId} THEN 0 ELSE 1 END,
          member.created_at ASC,
          member.workspace_id ASC
        LIMIT 1
      ),
      resolved_brain AS MATERIALIZED (
        SELECT brain.id
        FROM goat.brains AS brain
        INNER JOIN resolved_workspace AS workspace
          ON workspace.workspace_id = brain.workspace_id
        WHERE ${requestedBrainRef}::text IS NULL
           OR brain.id = ${requestedBrainRef}
        ORDER BY
          CASE WHEN brain.id = ${requestedBrainRef} THEN 0 ELSE 1 END,
          CASE WHEN brain.slug = 'general' THEN 0 ELSE 1 END,
          brain.created_at ASC,
          brain.id ASC
        LIMIT 1
      ),
      created_chat AS (
        INSERT INTO goat.chat_sessions (
          id,
          user_workos_id,
          title,
          model,
          engine,
          kind,
          created_at,
          updated_at
        )
        SELECT
          ${chatSessionId},
          "user".workos_user_id,
          ${input.name},
          ${harnessSpec.model},
          ${engine},
          'task',
          ${now},
          ${assistantCreatedAt}
        FROM enabled_user AS "user"
        RETURNING id, user_workos_id
      ),
      created_task AS (
        INSERT INTO goat.tasks (
          id,
          name,
          user_workos_id,
          workspace_id,
          prompt,
          model,
          session_id,
          schedule_id,
          scheduled_for,
          workflow_id,
          workflow_brain_ref,
          status,
          stage,
          next_run_at,
          created_at,
          updated_at,
          harness_spec
        )
        SELECT
          ${taskId},
          ${input.name},
          chat.user_workos_id,
          (SELECT workspace_id FROM resolved_workspace),
          ${input.prompt},
          ${harnessSpec.model},
          chat.id,
          ${input.scheduleId ?? null},
          ${input.scheduledFor ?? null},
          ${input.workflowId ?? null},
          ${input.workflowBrainRef ?? null},
          'queued',
          'queued',
          ${now},
          ${now},
          ${now},
          ${JSON.stringify(harnessSpec)}::jsonb
        FROM created_chat AS chat
        RETURNING *
      ),
      inserted_user_message AS (
        INSERT INTO goat.chat_messages (
          id,
          session_id,
          role,
          content,
          attachments,
          attachment_texts,
          created_at,
          updated_at
        )
        SELECT
          ${userMessageId},
          task.session_id,
          'user',
          ${initialUserMessage},
          ${attachmentsJsonbValue(attachments)}::jsonb,
          ${attachmentTextsJsonbValue(attachmentTexts)}::jsonb,
          ${now},
          ${now}
        FROM created_task AS task
        RETURNING id
      ),
      inserted_assistant_message AS (
        INSERT INTO goat.chat_messages (
          id,
          session_id,
          role,
          content,
          debug_trace,
          created_at,
          updated_at
        )
        SELECT
          ${assistantMessageId},
          task.session_id,
          'assistant',
          '',
          ${JSON.stringify(assistantDebugTrace)}::jsonb,
          ${assistantCreatedAt},
          ${assistantCreatedAt}
        FROM created_task AS task
        RETURNING id
      ),
      inserted_runtime_session AS (
        INSERT INTO goat.codex_chat_sessions (
          id,
          user_workos_id,
          chat_session_id,
          engine,
          model,
          brain_ref,
          workspace_id,
          host_tool_contract_version,
          active_turn_id,
          status,
          created_at,
          updated_at
        )
        SELECT
          ${runtimeSessionId},
          task.user_workos_id,
          task.session_id,
          ${engine},
          ${runtimeModel},
          (SELECT id FROM resolved_brain),
          (SELECT workspace_id FROM resolved_workspace),
          ${engine === "opencompany" ? null : GOAT_ACTION_HOST_TOOL_CONTRACT_VERSION},
          ${turnId},
          'queued',
          ${now},
          ${now}
        FROM created_task AS task
        RETURNING id
      ),
      inserted_turn AS (
        INSERT INTO goat.codex_chat_turns (
          id,
          user_workos_id,
          codex_chat_session_id,
          chat_session_id,
          user_message_id,
          assistant_message_id,
          status,
          prompt,
          settings,
          created_at,
          updated_at
        )
        SELECT
          ${turnId},
          task.user_workos_id,
          runtime.id,
          task.session_id,
          ${userMessageId},
          ${assistantMessageId},
          'queued',
          ${initialUserMessage},
          ${JSON.stringify(settings)}::jsonb,
          ${now},
          ${now}
        FROM created_task AS task
        CROSS JOIN inserted_runtime_session AS runtime
        WHERE EXISTS (SELECT 1 FROM inserted_user_message)
          AND EXISTS (SELECT 1 FROM inserted_assistant_message)
        RETURNING id
      )
      SELECT
        task.id AS "id",
        task.display_id AS "displayId",
        task.name AS "name",
        task.user_workos_id AS "userWorkosId",
        task.workspace_id AS "workspaceId",
        task.prompt AS "prompt",
        task.model AS "model",
        task.session_id AS "sessionId",
        task.schedule_id AS "scheduleId",
        task.scheduled_for AS "scheduledFor",
        task.status AS "status",
        task.stage AS "stage",
        task.result AS "result",
        task.error AS "error",
        task.workflow_id AS "workflowId",
        task.workflow_brain_ref AS "workflowBrainRef",
        task.reported_outcome AS "reportedOutcome",
        task.outcome_comment AS "outcomeComment",
        task.harness_spec AS "harnessSpec",
        task.debug_trace AS "debugTrace",
        task.codex_engine_session_id AS "codexEngineSessionId",
        task.sandbox_id AS "sandboxId",
        task.attempts AS "attempts",
        task.next_run_at AS "nextRunAt",
        task.lease_id AS "leaseId",
        task.lease_owner AS "leaseOwner",
        task.lease_expires_at AS "leaseExpiresAt",
        task.archived_at AS "archivedAt",
        task.created_at AS "createdAt",
        task.updated_at AS "updatedAt"
      FROM created_task AS task
      WHERE EXISTS (SELECT 1 FROM inserted_turn)
    `),
  )[0];

  if (!task) {
    throw new Error("Unable to create Goat task session.");
  }
  return goatTaskFromRow(task);
}

export async function enqueueGoatTaskSessionTurn(
  input: {
    taskId: string;
    userWorkosId: string;
    prompt: string;
    skills?: GoatTaskSessionSkillSnapshot[] | null | undefined;
    clientMessageId?: string | null | undefined;
    now?: Date;
  },
  db: GoatTaskSessionDb = getDb() as GoatTaskSessionDb,
) {
  const userMessageId = safeChatMessageId(input.clientMessageId) ?? `goat_chat_msg_${randomUUID()}`;
  const assistantMessageId = `goat_chat_msg_${randomUUID()}`;
  const turnId = `goat_codex_chat_turn_${randomUUID()}`;
  const now = input.now ?? new Date();
  const assistantCreatedAt = new Date(now.getTime() + 1);
  const skills = input.skills ?? [];
  const result = await db.execute(sql`
    WITH candidate AS MATERIALIZED (
      SELECT
        task.id,
        task.session_id,
        task.harness_spec,
        runtime.id AS runtime_session_id,
        runtime.engine,
        runtime.model
      FROM goat.tasks AS task
      INNER JOIN goat.chat_sessions AS chat
        ON chat.id = task.session_id
       AND chat.user_workos_id = task.user_workos_id
       AND chat.closed_at IS NULL
      INNER JOIN goat.codex_chat_sessions AS runtime
        ON runtime.chat_session_id = chat.id
       AND runtime.user_workos_id = task.user_workos_id
      WHERE task.id = ${input.taskId}
        AND task.user_workos_id = ${input.userWorkosId}
        AND task.archived_at IS NULL
        AND task.status IN ('succeeded', 'failed', 'canceled')
        AND NOT EXISTS (
          SELECT 1
          FROM goat.codex_chat_turns AS active_turn
          WHERE active_turn.codex_chat_session_id = runtime.id
            AND active_turn.status IN ('queued', 'running')
        )
      FOR UPDATE OF task, runtime
    ),
    continued_task AS (
      UPDATE goat.tasks AS task
      SET status = 'queued',
          stage = 'queued',
          result = NULL,
          error = NULL,
          reported_outcome = NULL,
          outcome_comment = NULL,
          next_run_at = ${now},
          lease_id = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = ${now}
      FROM candidate
      WHERE task.id = candidate.id
      RETURNING task.id, task.session_id, task.user_workos_id, task.harness_spec
    ),
    inserted_user_message AS (
      INSERT INTO goat.chat_messages (
        id,
        session_id,
        role,
        content,
        created_at,
        updated_at
      )
      SELECT
        ${userMessageId},
        task.session_id,
        'user',
        ${input.prompt},
        ${now},
        ${now}
      FROM continued_task AS task
      RETURNING id
    ),
    activated_skills AS (
      INSERT INTO goat.chat_session_skills (
        chat_session_id, skill_id, brain_ref, activated_message_id,
        name, description, instructions, created_at
      )
      SELECT
        task.session_id, skill.skill_id, skill.brain_ref, ${userMessageId},
        skill.name, skill.description, skill.instructions, ${now}
      FROM continued_task AS task
      CROSS JOIN jsonb_to_recordset(${taskSessionSkillsJsonbValue(skills)}::jsonb) AS skill(
        skill_id text,
        brain_ref text,
        name text,
        description text,
        instructions text
      )
      ON CONFLICT (chat_session_id, skill_id) DO NOTHING
      RETURNING skill_id
    ),
    inserted_assistant_message AS (
      INSERT INTO goat.chat_messages (
        id,
        session_id,
        role,
        content,
        debug_trace,
        created_at,
        updated_at
      )
      SELECT
        ${assistantMessageId},
        task.session_id,
        'assistant',
        '',
        jsonb_build_object(
          'schemaVersion',
          CASE
            WHEN candidate.engine = 'opencompany'
              THEN 'opencompany.chat.debug.v1'
            ELSE 'goat.codex_chat.debug.v1'
          END,
          'model',
          candidate.model,
          'uiMessageParts',
          '[]'::jsonb
        ),
        ${assistantCreatedAt},
        ${assistantCreatedAt}
      FROM continued_task AS task
      INNER JOIN candidate ON candidate.id = task.id
      RETURNING id
    ),
    inserted_turn AS (
      INSERT INTO goat.codex_chat_turns (
        id,
        user_workos_id,
        codex_chat_session_id,
        chat_session_id,
        user_message_id,
        assistant_message_id,
        status,
        prompt,
        settings,
        created_at,
        updated_at
      )
      SELECT
        ${turnId},
        task.user_workos_id,
        candidate.runtime_session_id,
        task.session_id,
        ${userMessageId},
        ${assistantMessageId},
        'queued',
        ${input.prompt},
        jsonb_strip_nulls(
          jsonb_build_object(
            'reasoningEffort', task.harness_spec->'codex'->>'reasoningEffort',
            'goalMode', task.harness_spec->'codex'->'goalMode'
          )
        ),
        ${now},
        ${now}
      FROM continued_task AS task
      INNER JOIN candidate ON candidate.id = task.id
      WHERE EXISTS (SELECT 1 FROM inserted_user_message)
        AND EXISTS (SELECT 1 FROM inserted_assistant_message)
      RETURNING codex_chat_session_id
    ),
    updated_runtime AS (
      UPDATE goat.codex_chat_sessions AS runtime
      SET status = CASE
            WHEN runtime.status IN ('queued', 'starting', 'running') THEN runtime.status
            ELSE 'queued'
          END,
          active_turn_id = CASE
            WHEN runtime.status IN ('queued', 'starting', 'running') THEN runtime.active_turn_id
            ELSE ${turnId}
          END,
          error = NULL,
          updated_at = ${now}
      FROM inserted_turn AS turn
      WHERE runtime.id = turn.codex_chat_session_id
      RETURNING runtime.chat_session_id
    )
    UPDATE goat.chat_sessions AS chat
    SET updated_at = ${assistantCreatedAt}
    FROM updated_runtime AS runtime
    WHERE chat.id = runtime.chat_session_id
    RETURNING ${userMessageId}::text AS id, ${input.taskId}::text AS task_id
  `);
  return rowsFromExecute<{ id: string; task_id: string }>(result)[0] ?? null;
}

function turnSettingsFromHarness(harnessSpec: GoatHarnessSpec) {
  const codex = harnessSpec.codex;
  return {
    ...(codex?.reasoningEffort ? { reasoningEffort: codex.reasoningEffort } : {}),
    ...(codex?.goalMode ? { goalMode: codex.goalMode } : {}),
  };
}

function runtimeModelNameForHarness(engine: GoatHarnessSpec["engine"], model: string) {
  if (engine === "codex") return codexCliModelNameForModelId(model);
  if (engine === "claude_code") return claudeCodeCliModelNameForModelId(model);
  return model;
}

function attachmentsJsonbValue(attachments: GoatChatMessageAttachment[]) {
  return attachments.length > 0 ? JSON.stringify(attachments) : null;
}

function taskSessionSkillsJsonbValue(skills: GoatTaskSessionSkillSnapshot[]) {
  return JSON.stringify(
    skills.map((skill) => ({
      skill_id: skill.id,
      brain_ref: skill.brainRef,
      name: skill.name,
      description: skill.description,
      instructions: skill.instructions,
    })),
  );
}

function attachmentTextsJsonbValue(attachmentTexts: Record<string, string> | null) {
  return attachmentTexts && Object.keys(attachmentTexts).length > 0
    ? JSON.stringify(attachmentTexts)
    : null;
}

function emptyAssistantDebugTrace(engine: GoatHarnessSpec["engine"], model: string) {
  return {
    schemaVersion:
      engine === "opencompany" ? "opencompany.chat.debug.v1" : "goat.codex_chat.debug.v1",
    model,
    uiMessageParts: [],
  };
}

function safeChatMessageId(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed && /^goat_chat_msg_[0-9a-f-]{36}$/i.test(trimmed) ? trimmed : null;
}

type GoatTaskRow = Omit<
  GoatTask,
  "scheduledFor" | "nextRunAt" | "leaseExpiresAt" | "archivedAt" | "createdAt" | "updatedAt"
> & {
  scheduledFor: Date | string | null;
  nextRunAt: Date | string;
  leaseExpiresAt: Date | string | null;
  archivedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

function goatTaskFromRow(row: GoatTaskRow): GoatTask {
  return {
    ...row,
    scheduledFor: row.scheduledFor ? toDate(row.scheduledFor) : null,
    nextRunAt: toDate(row.nextRunAt),
    leaseExpiresAt: row.leaseExpiresAt ? toDate(row.leaseExpiresAt) : null,
    archivedAt: row.archivedAt ? toDate(row.archivedAt) : null,
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
  };
}

function toDate(value: Date | string) {
  return value instanceof Date ? value : new Date(value);
}

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as T[];
  }
  return [];
}
