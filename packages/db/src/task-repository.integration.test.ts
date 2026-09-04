import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import {
  ACTION_HOST_TOOL_CONTRACT_VERSION,
  CHAT_HOST_TOOL_CONTRACT_VERSION,
} from "@opencompany/agent-runtime";
import {
  type Actor,
  TASK_READ_PERMISSION,
  TASK_WRITE_PERMISSION,
  TaskApplicationService,
} from "@opencompany/core";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PostgresChatAttachmentRepository } from "./chat-repository";
import { PostgresTaskRepository, type TaskRepositoryIdFactory } from "./task-repository";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const migrationPaths = [
  "0198_goat_headless_chat_foundation.sql",
  "0199_goat_chat_attachment_uploads.sql",
  "0200_goat_chat_run_pausing.sql",
  "0201_goat_chat_read_models_v1.sql",
  "0202_goat_headless_task_foundation.sql",
  "0204_goat_task_conversation_history_projection.sql",
  "0205_goat_task_history_projection_repair.sql",
  "0215_goat_chat_sidebar_state.sql",
  "0216_goat_conversation_runtime_summary.sql",
  "0223_goat_task_projection_preservation.sql",
  "0226_goat_immutable_skill_bundles.sql",
  "0228_goat_plugins.sql",
  "0245_goat_task_activities.sql",
  "0246_goat_task_waiting_status.sql",
].map((filename) => path.join(repositoryRoot, "drizzle", filename));
const dialect = new PgDialect();

describe("Postgres Task repository", () => {
  let database: PGlite;
  let execute: (query: SQL) => Promise<unknown>;
  let service: TaskApplicationService;
  let migrationEvidence: {
    legacyTaskExists: boolean;
    legacyTaskProjected: boolean;
    canonicalTaskProjected: boolean;
    canonicalMessageProjected: boolean;
    historicalMessagesProjected: number;
    historicalRunsProjected: number;
    physicalHistoryUntouched: boolean;
    normalChatTaskCardUntouched: boolean;
    crossWorkspaceLinkRejected: boolean;
    crossWorkspaceRunRejected: boolean;
    projectionWipedBeforeRepair: boolean;
  };

  beforeEach(async () => {
    database = new PGlite();
    await database.exec(BASE_SCHEMA);
    await database.exec(`
      INSERT INTO goat.users (workos_user_id, task_spawning_enabled)
      VALUES ('migration_user', true);
      INSERT INTO goat.workspaces (id) VALUES ('migration_workspace'), ('migration_other_workspace');
      INSERT INTO goat.chat_sessions (id, user_workos_id, title, model, engine, kind)
      VALUES
        (
          'migration_task_conversation', 'migration_user', 'Existing Task',
          'moonshotai/kimi-k3', 'opencompany', 'task'
        ),
        (
          'migration_prior_task_conversation', 'migration_user', 'Prior workflow step',
          'moonshotai/kimi-k3', 'opencompany', 'task'
        ),
        (
          'migration_normal_chat', 'migration_user', 'Normal chat',
          'moonshotai/kimi-k3', 'opencompany', 'chat'
        ),
        (
          'migration_other_workspace_task_conversation', 'migration_user',
          'Malformed cross-workspace Task history', 'moonshotai/kimi-k3', 'opencompany', 'task'
        );
      INSERT INTO goat.tasks (
        id, name, user_workos_id, workspace_id, prompt, model, session_id, status, stage
      ) VALUES
        (
          'migration_legacy_task', 'Legacy Task', 'migration_user', 'migration_workspace',
          'Keep legacy history', 'moonshotai/kimi-k3', NULL, 'succeeded', 'completed'
        ),
        (
          'migration_canonical_task', 'Existing canonical Task', 'migration_user',
          'migration_workspace', 'Keep canonical history', 'moonshotai/kimi-k3',
          'migration_task_conversation', 'succeeded', 'completed'
        );
      INSERT INTO goat.chat_messages (id, session_id, role, content, task_id)
      VALUES
        (
          'migration_task_message', 'migration_task_conversation', 'user',
          'Keep this message', 'migration_canonical_task'
        ),
        (
          'migration_task_assistant', 'migration_task_conversation', 'assistant',
          'Kept', 'migration_canonical_task'
        ),
        (
          'migration_prior_task_message', 'migration_prior_task_conversation', 'user',
          'Prior workflow step', 'migration_canonical_task'
        ),
        (
          'migration_prior_task_assistant', 'migration_prior_task_conversation', 'assistant',
          'Prior step result', 'migration_canonical_task'
        ),
        (
          'migration_task_card', 'migration_normal_chat', 'assistant',
          'Task card', 'migration_canonical_task'
        ),
        (
          'migration_cross_workspace_message', 'migration_other_workspace_task_conversation',
          'assistant', 'Must stay isolated', 'migration_canonical_task'
        );
      INSERT INTO goat.codex_chat_sessions (
        id, user_workos_id, chat_session_id, engine, model, workspace_id
      ) VALUES
        (
          'migration_task_runtime', 'migration_user', 'migration_task_conversation',
          'opencompany', 'moonshotai/kimi-k3', 'migration_workspace'
        ),
        (
          'migration_prior_task_runtime', 'migration_user', 'migration_prior_task_conversation',
          'opencompany', 'moonshotai/kimi-k3', 'migration_workspace'
        ),
        (
          'migration_other_workspace_runtime', 'migration_user',
          'migration_other_workspace_task_conversation', 'opencompany',
          'moonshotai/kimi-k3', 'migration_other_workspace'
        );
      INSERT INTO goat.codex_chat_turns (
        id, user_workos_id, codex_chat_session_id, chat_session_id, user_message_id,
        assistant_message_id, status, prompt
      ) VALUES
        (
          'migration_prior_task_run', 'migration_user', 'migration_prior_task_runtime',
          'migration_prior_task_conversation', 'migration_prior_task_message',
          'migration_prior_task_assistant', 'completed', 'Prior workflow step'
        ),
        (
          'migration_cross_workspace_run', 'migration_user',
          'migration_other_workspace_runtime', 'migration_other_workspace_task_conversation',
          'migration_cross_workspace_message', 'migration_cross_workspace_message',
          'completed', 'Must stay isolated'
        );
    `);
    let projectionWipedBeforeRepair = false;
    for (const migrationPath of migrationPaths) {
      if (migrationPath.endsWith("0205_goat_task_history_projection_repair.sql")) {
        // Reproduce the production gap: valid physical Task history whose projection row is absent.
        await database.exec(`
          DELETE FROM goat.message_read_model_v1 WHERE id = 'migration_prior_task_message';
          DELETE FROM goat.run_read_model_v1 WHERE id = 'migration_prior_task_run';
        `);
      }
      if (migrationPath.endsWith("0223_goat_task_projection_preservation.sql")) {
        // Reproduce the production wipe: under the 0216 refresh function, any Conversation-row
        // touch (planner model bump, settlement, rename) deleted every canonical Task projection.
        await database.exec(`
          UPDATE goat.chat_sessions SET updated_at = now()
          WHERE id = 'migration_task_conversation';
        `);
        const wiped = await database.query<{ remaining: number }>(`
          SELECT COUNT(*)::int AS remaining
          FROM goat.message_read_model_v1
          WHERE conversation_id = 'migration_task_conversation'
        `);
        projectionWipedBeforeRepair = wiped.rows[0]?.remaining === 0;
      }
      const migration = await readFile(migrationPath, "utf8");
      const statements = migration.split("--> statement-breakpoint");
      for (const statement of statements) {
        if (statement.trim()) await database.exec(statement);
      }
      if (migrationPath.endsWith("0205_goat_task_history_projection_repair.sql")) {
        for (const statement of statements) {
          if (statement.trim()) await database.exec(statement);
        }
      }
    }
    const migrationRows = await database.query<{
      legacy_exists: boolean;
      legacy_projected: boolean;
      canonical_projected: boolean;
      message_projected: boolean;
      historical_messages_projected: number;
      historical_runs_projected: number;
      physical_history_untouched: boolean;
      normal_chat_task_card_untouched: boolean;
      cross_workspace_link_rejected: boolean;
      cross_workspace_run_rejected: boolean;
    }>(`
      SELECT
        EXISTS (
          SELECT 1 FROM goat.tasks WHERE id = 'migration_legacy_task' AND source = 'manual'
        ) AS legacy_exists,
        EXISTS (
          SELECT 1 FROM goat.task_read_model_v1 WHERE id = 'migration_legacy_task'
        ) AS legacy_projected,
        EXISTS (
          SELECT 1 FROM goat.task_read_model_v1
          WHERE id = 'migration_canonical_task'
            AND conversation_id = 'migration_task_conversation'
        ) AS canonical_projected,
        EXISTS (
          SELECT 1 FROM goat.message_read_model_v1
          WHERE id = 'migration_task_message'
            AND workspace_id = 'migration_workspace'
        ) AS message_projected,
        (
          SELECT COUNT(*)::int
          FROM goat.message_read_model_v1
          WHERE conversation_id = 'migration_task_conversation'
            AND id IN ('migration_prior_task_message', 'migration_prior_task_assistant')
        ) AS historical_messages_projected,
        (
          SELECT COUNT(*)::int
          FROM goat.run_read_model_v1
          WHERE conversation_id = 'migration_task_conversation'
            AND id = 'migration_prior_task_run'
        ) AS historical_runs_projected,
        EXISTS (
          SELECT 1
          FROM goat.chat_messages
          WHERE id = 'migration_prior_task_message'
            AND session_id = 'migration_prior_task_conversation'
        ) AS physical_history_untouched,
        EXISTS (
          SELECT 1
          FROM goat.message_read_model_v1
          WHERE id = 'migration_task_card'
            AND conversation_id = 'migration_normal_chat'
        ) AS normal_chat_task_card_untouched,
        EXISTS (
          SELECT 1
          FROM goat.message_read_model_v1
          WHERE id = 'migration_cross_workspace_message'
            AND conversation_id = 'migration_other_workspace_task_conversation'
            AND workspace_id = 'migration_other_workspace'
        ) AS cross_workspace_link_rejected,
        EXISTS (
          SELECT 1
          FROM goat.run_read_model_v1
          WHERE id = 'migration_cross_workspace_run'
            AND conversation_id = 'migration_other_workspace_task_conversation'
            AND workspace_id = 'migration_other_workspace'
        ) AS cross_workspace_run_rejected
    `);
    const migrationRow = migrationRows.rows[0];
    migrationEvidence = {
      legacyTaskExists: migrationRow?.legacy_exists ?? false,
      legacyTaskProjected: migrationRow?.legacy_projected ?? true,
      canonicalTaskProjected: migrationRow?.canonical_projected ?? false,
      canonicalMessageProjected: migrationRow?.message_projected ?? false,
      historicalMessagesProjected: migrationRow?.historical_messages_projected ?? 0,
      historicalRunsProjected: migrationRow?.historical_runs_projected ?? 0,
      physicalHistoryUntouched: migrationRow?.physical_history_untouched ?? false,
      normalChatTaskCardUntouched: migrationRow?.normal_chat_task_card_untouched ?? false,
      crossWorkspaceLinkRejected: migrationRow?.cross_workspace_link_rejected ?? false,
      crossWorkspaceRunRejected: migrationRow?.cross_workspace_run_rejected ?? false,
      projectionWipedBeforeRepair,
    };

    await database.exec(`
      DELETE FROM goat.task_command_idempotency;
      DELETE FROM goat.run_events;
      DELETE FROM goat.run_approvals;
      DELETE FROM goat.run_attempts;
      DELETE FROM goat.codex_chat_turns;
      DELETE FROM goat.codex_chat_sessions;
      DELETE FROM goat.chat_messages;
      DELETE FROM goat.tasks;
      DELETE FROM goat.chat_sessions;
      DELETE FROM goat.brains;
      DELETE FROM goat.workspace_members;
      DELETE FROM goat.users;
      DELETE FROM goat.workspaces;
    `);
    await database.exec(`
      INSERT INTO goat.users (workos_user_id, task_spawning_enabled)
      VALUES ('user_1', true), ('user_2', false), ('user_3', true);
      INSERT INTO goat.workspaces (id) VALUES ('workspace_1'), ('workspace_2');
      INSERT INTO goat.workspace_members (id, workspace_id, user_workos_id, role)
      VALUES
        ('member_1', 'workspace_1', 'user_1', 'admin'),
        ('member_2', 'workspace_2', 'user_2', 'admin'),
        ('member_3', 'workspace_1', 'user_3', 'member');
      INSERT INTO goat.brains (id, workspace_id, slug)
      VALUES
        ('brain_1', 'workspace_1', 'general'),
        ('brain_2', 'workspace_2', 'general');
    `);
    execute = async (query: SQL) => {
      const compiled = dialect.sqlToQuery(query);
      return database.query(compiled.sql, compiled.params as never[]);
    };
    service = new TaskApplicationService(
      new PostgresTaskRepository(execute, {
        ids: deterministicTaskIds(),
        now: () => new Date("2026-08-11T10:00:00.000Z"),
        resolveHarness: async ({ command }) => ({
          schemaVersion: "goat.harness.v1",
          engine: command.engine,
          model: command.model,
          systemPrompt: "",
          initialUserMessage: command.goal,
          tools: ["web_search"],
          skills: [],
          maxModelSteps: 16,
          resultMode: "assistant_final",
        }),
      }),
    );
  });

  afterEach(async () => {
    await database.close();
  });

  it("preserves legacy history through the Task's one canonical Conversation projection", () => {
    expect(migrationEvidence).toEqual({
      legacyTaskExists: true,
      legacyTaskProjected: false,
      canonicalTaskProjected: true,
      canonicalMessageProjected: true,
      historicalMessagesProjected: 2,
      historicalRunsProjected: 1,
      physicalHistoryUntouched: true,
      normalChatTaskCardUntouched: true,
      crossWorkspaceLinkRejected: true,
      crossWorkspaceRunRejected: true,
      projectionWipedBeforeRepair: true,
    });
  });

  it("keeps canonical Task projections when the Conversation row is touched after the repair", async () => {
    const created = await service.createTask(actor(), {
      idempotencyKey: "task-projection-preservation",
      goal: "Keep the transcript",
      engine: "opencompany",
      model: "moonshotai/kimi-k3",
      source: "manual",
    });
    const conversationId = created.task.conversationId;
    const projectedMessages = async () =>
      (
        await database.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM goat.message_read_model_v1
           WHERE conversation_id = $1`,
          [conversationId],
        )
      ).rows[0]?.count;
    expect(await projectedMessages()).toBe(2);

    // The codex Task planner bumps model/updated_at at turn start; settlement and renames touch
    // the same row. None of these may drop the projected transcript.
    await database.exec(`
      UPDATE goat.chat_sessions SET model = 'moonshotai/kimi-k3-planned', updated_at = now()
      WHERE id = '${conversationId}';
    `);
    expect(await projectedMessages()).toBe(2);

    await service.updateTask(actor(), created.task.id, { name: "Renamed task" });
    expect(await projectedMessages()).toBe(2);
    await expect(
      database.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM goat.run_read_model_v1 WHERE conversation_id = $1`,
        [conversationId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });

    // Deleting the Conversation still cleans up every projection.
    await database.exec(`
      DELETE FROM goat.run_events WHERE run_id IN (
        SELECT id FROM goat.codex_chat_turns WHERE chat_session_id = '${conversationId}'
      );
      DELETE FROM goat.codex_chat_turns WHERE chat_session_id = '${conversationId}';
      DELETE FROM goat.codex_chat_sessions WHERE chat_session_id = '${conversationId}';
      DELETE FROM goat.chat_messages WHERE session_id = '${conversationId}';
      DELETE FROM goat.tasks WHERE session_id = '${conversationId}';
      DELETE FROM goat.chat_sessions WHERE id = '${conversationId}';
    `);
    expect(await projectedMessages()).toBe(0);
  });

  it("serves preserved legacy history only through the authorized compatibility boundary", async () => {
    await database.exec(`
      INSERT INTO goat.tasks (
        id, name, user_workos_id, workspace_id, prompt, model, session_id, status, stage
      ) VALUES (
        'legacy_task_1', 'Legacy research', 'user_1', 'workspace_1',
        'Preserve this history', 'moonshotai/kimi-k3', NULL, 'succeeded', 'completed'
      );
      INSERT INTO goat.task_messages (
        id, task_id, user_workos_id, role, status, content, created_at, completed_at
      ) VALUES (
        'legacy_message_1', 'legacy_task_1', 'user_1', 'assistant', 'completed',
        'Historical result', '2026-08-10T09:00:00.000Z', '2026-08-10T10:00:00.000Z'
      );
      INSERT INTO goat.task_events (
        task_id, user_workos_id, message_id, type, payload
      ) VALUES (
        'legacy_task_1', 'user_1', 'legacy_message_1', 'message.completed',
        '{"messageId":"legacy_message_1"}'::jsonb
      );
      INSERT INTO goat.task_model_usage (
        task_id, user_workos_id, total_cost_usd_micros
      ) VALUES ('legacy_task_1', 'user_1', 1200);
    `);

    await expect(service.listLegacyTasks(actor())).resolves.toMatchObject([
      { id: "legacy_task_1", name: "Legacy research" },
    ]);
    await expect(service.getLegacyTaskHistory(actor(), "legacy_task_1")).resolves.toMatchObject({
      task: { id: "legacy_task_1" },
      messages: [{ id: "legacy_message_1", content: "Historical result" }],
      events: [{ id: 1, type: "message.completed" }],
    });
    await expect(service.getTaskSummary(actor(), "legacy_task_1")).resolves.toEqual({
      cost: { hasRecordedCosts: true, totalCostUsdMicros: 1200 },
      durationMs: 3_600_000,
    });
    await expect(
      service.getLegacyTaskHistory(
        actor({ userId: "user_2", workspaceId: "workspace_2" }),
        "legacy_task_1",
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("atomically creates and idempotently replays one Task, Conversation, Message, and Run", async () => {
    const command = {
      idempotencyKey: "task-create-1",
      name: "Prepare the launch",
      goal: "Prepare a launch readiness brief",
      engine: "opencompany" as const,
      model: "moonshotai/kimi-k3",
      source: "manual" as const,
    };

    const first = await service.createTask(actor(), command);
    const replay = await service.createTask(actor(), command);

    expect(first).toMatchObject({
      task: {
        id: "task_2",
        name: command.name,
        goal: command.goal,
        conversationId: "conversation_3",
        status: "queued",
        source: "manual",
      },
      messageId: "message_4",
      assistantMessageId: "message_5",
      runId: "run_7",
      idempotentReplay: false,
    });
    expect(replay).toEqual({ ...first, idempotentReplay: true });

    await expect(
      database.query<{ host_tool_contract_version: string }>(
        `SELECT host_tool_contract_version
         FROM goat.codex_chat_sessions
         WHERE chat_session_id = $1`,
        [first.task.conversationId],
      ),
    ).resolves.toMatchObject({
      rows: [{ host_tool_contract_version: CHAT_HOST_TOOL_CONTRACT_VERSION }],
    });

    expect(
      (
        await database.query<{
          tasks: number;
          conversations: number;
          messages: number;
          runs: number;
          activities: number;
        }>(`
          SELECT
            (SELECT COUNT(*)::int FROM goat.tasks) AS tasks,
            (SELECT COUNT(*)::int FROM goat.chat_sessions WHERE kind = 'task') AS conversations,
            (SELECT COUNT(*)::int FROM goat.chat_messages) AS messages,
            (SELECT COUNT(*)::int FROM goat.codex_chat_turns) AS runs,
            (SELECT COUNT(*)::int FROM goat.task_activities) AS activities
        `)
      ).rows,
    ).toEqual([{ tasks: 1, conversations: 1, messages: 2, runs: 1, activities: 1 }]);
    await expect(
      database.query<{
        task_id: string;
        author: string;
        author_workos_id: string;
        kind: string;
        metadata: Record<string, unknown>;
      }>(`
        SELECT task_id, author, author_workos_id, kind, metadata
        FROM goat.task_activities
      `),
    ).resolves.toMatchObject({
      rows: [
        {
          task_id: first.task.id,
          author: "user",
          author_workos_id: "user_1",
          kind: "created",
          metadata: { source: "manual" },
        },
      ],
    });
    expect(
      (
        await database.query<{
          type: string;
          sequence: number;
          payload: Record<string, unknown>;
        }>(`
          SELECT type, sequence, payload FROM goat.run_events ORDER BY sequence
        `)
      ).rows,
    ).toEqual([
      {
        type: "run.queued",
        sequence: 1,
        payload: {
          conversationId: first.task.conversationId,
          triggerMessageId: first.messageId,
        },
      },
    ]);
    expect(
      (
        await database.query<{ harness_spec: { tools: string[] } }>(`
          SELECT harness_spec FROM goat.tasks
        `)
      ).rows,
    ).toEqual([{ harness_spec: expect.objectContaining({ tools: ["web_search"] }) }]);
    expect(
      (
        await database.query<{
          task_workspace: string;
          message_count: number;
          run_workspace: string;
        }>(`
          SELECT
            task.workspace_id AS task_workspace,
            (
              SELECT COUNT(*)::int
              FROM goat.message_read_model_v1 AS message
              WHERE message.conversation_id = task.conversation_id
                AND message.workspace_id = 'workspace_1'
            ) AS message_count,
            run.workspace_id AS run_workspace
          FROM goat.task_read_model_v1 AS task
          JOIN goat.run_read_model_v1 AS run ON run.conversation_id = task.conversation_id
        `)
      ).rows,
    ).toEqual([{ task_workspace: "workspace_1", message_count: 2, run_workspace: "workspace_1" }]);

    await expect(
      service.createTask(actor(), { ...command, goal: "A conflicting goal" }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("rejects retired models when creating a new Codex Task", async () => {
    await expect(
      service.createTask(actor(), {
        idempotencyKey: "retired-codex-model",
        goal: "Review the repository",
        engine: "codex",
        model: "openai/gpt-5.5",
        source: "manual",
      }),
    ).rejects.toMatchObject({
      code: "invalid_argument",
      message: "Unsupported codex Task model.",
    });
  });

  it("stamps external-engine Tasks with the action host-tool contract", async () => {
    const created = await service.createTask(actor(), {
      idempotencyKey: "codex-task-host-contract",
      goal: "Review the repository",
      engine: "codex",
      model: "openai/gpt-5.6-sol",
      source: "manual",
    });

    await expect(
      database.query<{ host_tool_contract_version: string }>(
        `SELECT host_tool_contract_version
         FROM goat.codex_chat_sessions
         WHERE chat_session_id = $1`,
        [created.task.conversationId],
      ),
    ).resolves.toMatchObject({
      rows: [{ host_tool_contract_version: ACTION_HOST_TOOL_CONTRACT_VERSION }],
    });
  });

  it("snapshots currently enabled Plugin IDs into the Workflow Harness at Task creation", async () => {
    await database.exec(`
      INSERT INTO goat.plugins (
        id, workspace_id, name, status, manifest, source_type, source_url, source_path,
        source_ref, resolved_commit, integrity, install_report
      ) VALUES
        (
          'plugin_enabled', 'workspace_1', 'enabled-plugin', 'enabled',
          '{"name":"enabled-plugin"}'::jsonb, 'github', 'https://github.com/example/plugins',
          'enabled-plugin', 'main', '${"a".repeat(40)}', 'sha256:${"b".repeat(64)}',
          '{"ignoredManifestFields":[],"skills":[],"mcp":{"status":"absent"},"collisions":[]}'::jsonb
        ),
        (
          'plugin_disabled', 'workspace_1', 'disabled-plugin', 'disabled',
          '{"name":"disabled-plugin"}'::jsonb, 'github', 'https://github.com/example/plugins',
          'disabled-plugin', 'main', '${"a".repeat(40)}', 'sha256:${"c".repeat(64)}',
          '{"ignoredManifestFields":[],"skills":[],"mcp":{"status":"absent"},"collisions":[]}'::jsonb
        )
    `);
    const workflowService = new TaskApplicationService(
      new PostgresTaskRepository(execute, {
        ids: deterministicTaskIds(),
        resolveHarness: async ({ command }) => ({
          schemaVersion: "goat.harness.v1",
          engine: command.engine,
          model: command.model,
          systemPrompt: "Run the workflow.",
          initialUserMessage: command.goal,
          tools: [],
          skills: [],
          maxModelSteps: 16,
          resultMode: "assistant_final",
          workflow: {
            id: "release-workflow",
            workspaceId: "workspace_1",
            skillIds: [],
            skillBundleIds: [],
            pluginIds: [],
            steps: [
              {
                index: 0,
                title: "Release",
                engine: command.engine,
                model: command.model,
                systemPrompt: "Run the workflow.",
                systemBlocks: ["Run the workflow."],
                skillIds: [],
                skillBundleIds: [],
              },
            ],
          },
        }),
      }),
    );
    const command = {
      idempotencyKey: "workflow-plugin-snapshot",
      name: "Release",
      goal: "Prepare the release.",
      engine: "opencompany" as const,
      model: "moonshotai/kimi-k3",
      source: "workflow" as const,
      workflowId: "release-workflow",
    };
    const created = await workflowService.createTask(actor(), command);

    await database.exec(`
      INSERT INTO goat.plugins (
        id, workspace_id, name, status, manifest, source_type, source_url, source_path,
        source_ref, resolved_commit, integrity, install_report
      ) VALUES (
        'plugin_late', 'workspace_1', 'late-plugin', 'enabled',
        '{"name":"late-plugin"}'::jsonb, 'github', 'https://github.com/example/plugins',
        'late-plugin', 'main', '${"a".repeat(40)}', 'sha256:${"d".repeat(64)}',
        '{"ignoredManifestFields":[],"skills":[],"mcp":{"status":"absent"},"collisions":[]}'::jsonb
      )
    `);
    await expect(workflowService.createTask(actor(), command)).resolves.toEqual({
      ...created,
      idempotentReplay: true,
    });

    await expect(
      database.query<{ plugin_ids: string[] }>(
        "SELECT harness_spec->'workflow'->'pluginIds' AS plugin_ids FROM goat.tasks WHERE id = $1",
        [created.task.id],
      ),
    ).resolves.toMatchObject({ rows: [{ plugin_ids: ["plugin_enabled"] }] });
  });

  it("enforces feature policy and actor/workspace isolation without partial writes", async () => {
    const command = {
      idempotencyKey: "task-disabled",
      goal: "This must not be created",
      engine: "opencompany" as const,
      model: "moonshotai/kimi-k3",
      source: "manual" as const,
    };
    await expect(
      service.createTask(actor({ userId: "user_2", workspaceId: "workspace_2" }), command),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(
      (await database.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM goat.tasks"))
        .rows,
    ).toEqual([{ count: 0 }]);

    const created = await service.createTask(actor(), {
      ...command,
      idempotencyKey: "task-shared",
    });
    await expect(
      service.getTask(actor({ userId: "user_3" }), created.task.id),
    ).resolves.toMatchObject({ id: created.task.id });
    await expect(
      service.getTask(actor({ userId: "user_1", workspaceId: "workspace_2" }), created.task.id),
    ).rejects.toMatchObject({ code: "not_found" });
    await database.exec(`DELETE FROM goat.workspace_members WHERE id = 'member_3'`);
    await expect(
      service.getTask(actor({ userId: "user_3" }), created.task.id),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("records a user comment verbatim and reopens its canonical Task run atomically", async () => {
    const created = await service.createTask(actor(), {
      idempotencyKey: "task-comment-resume",
      goal: "Start with a plan and wait for approval.",
      engine: "opencompany",
      model: "moonshotai/kimi-k3",
      source: "manual",
    });
    await database.query(
      `UPDATE goat.codex_chat_turns
       SET status = 'completed', completed_at = now()
       WHERE id = $1`,
      [created.runId],
    );
    await database.query(
      `UPDATE goat.codex_chat_sessions
       SET status = 'idle', active_turn_id = NULL
       WHERE chat_session_id = $1`,
      [created.task.conversationId],
    );
    await database.query(
      `UPDATE goat.tasks
       SET status = 'waiting', stage = 'completed', result = 'Here is the plan.',
           reported_outcome = 'needs_attention', outcome_comment = 'Approve the plan.', attempts = 1
       WHERE id = $1`,
      [created.task.id],
    );

    const body = "  Approved — also rename the config flag.\n";
    const resumed = await service.createComment(actor(), created.task.displayId.toLowerCase(), {
      id: "task_comment_1",
      body,
    });

    expect(resumed).toMatchObject({
      task: {
        id: created.task.id,
        status: "running",
        outcome: { result: null, error: null, reportedStatus: null, comment: null },
      },
      comment: {
        id: "task_comment_1",
        taskId: created.task.id,
        authorWorkosId: "user_1",
        body,
      },
      idempotentReplay: false,
    });
    await expect(
      database.query<{
        status: string;
        stage: string;
        attempts: number;
        runtime_status: string;
        active_turn_id: string;
        user_content: string;
        user_task_id: string;
        assistant_content: string;
        run_prompt: string;
        run_result_mode: string;
        run_status: string;
        run_owner: string;
        event_type: string;
        comment_body: string;
        comment_author: string;
        status_activity: string;
      }>(
        `SELECT
           task.status,
           task.stage,
           task.attempts,
           runtime.status AS runtime_status,
           runtime.active_turn_id,
           user_message.content AS user_content,
           user_message.task_id AS user_task_id,
           assistant_message.content AS assistant_content,
           run.prompt AS run_prompt,
           run.settings->>'taskResultMode' AS run_result_mode,
           run.status AS run_status,
           run.user_workos_id AS run_owner,
           event.type AS event_type,
           comment.body AS comment_body,
           comment.author_workos_id AS comment_author,
           resumed.body AS status_activity
         FROM goat.tasks AS task
         JOIN goat.codex_chat_sessions AS runtime ON runtime.chat_session_id = task.session_id
         JOIN goat.codex_chat_turns AS run ON run.id = $2
         JOIN goat.chat_messages AS user_message ON user_message.id = run.user_message_id
         JOIN goat.chat_messages AS assistant_message ON assistant_message.id = run.assistant_message_id
         JOIN goat.run_events AS event ON event.run_id = run.id AND event.type = 'run.queued'
         JOIN goat.task_activities AS comment ON comment.id = 'task_comment_1'
         JOIN goat.task_activities AS resumed
           ON resumed.task_id = task.id AND resumed.kind = 'status_changed'
         WHERE task.id = $1`,
        [created.task.id, resumed.runId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          status: "running",
          stage: "queued",
          attempts: 2,
          runtime_status: "queued",
          active_turn_id: resumed.runId,
          user_content: body,
          user_task_id: created.task.id,
          assistant_content: "",
          run_prompt: body,
          run_result_mode: "assistant_final",
          run_status: "queued",
          run_owner: "user_1",
          event_type: "run.queued",
          comment_body: body,
          comment_author: "user_1",
          status_activity: "Resumed by user.",
        },
      ],
    });

    await expect(
      service.createComment(actor(), created.task.id, { id: "task_comment_1", body }),
    ).resolves.toMatchObject({
      messageId: resumed.messageId,
      assistantMessageId: resumed.assistantMessageId,
      runId: resumed.runId,
      idempotentReplay: true,
    });
    await expect(
      service.createComment(actor(), created.task.id, {
        id: "task_comment_1",
        body: "Changed after the first request.",
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      service.createComment(actor(), created.task.id, {
        id: "task_comment_2",
        body: "A second comment while active.",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      service.createComment(
        actor({ userId: "user_2", workspaceId: "workspace_2" }),
        created.task.id,
        { id: "task_comment_other_workspace", body: "Not authorized." },
      ),
    ).rejects.toMatchObject({ code: "not_found" });

    expect(
      (
        await database.query<{ messages: number; runs: number; comments: number }>(
          `SELECT
             (SELECT COUNT(*)::int FROM goat.chat_messages WHERE session_id = $1) AS messages,
             (SELECT COUNT(*)::int FROM goat.codex_chat_turns WHERE chat_session_id = $1) AS runs,
             (SELECT COUNT(*)::int FROM goat.task_activities
               WHERE task_id = $2 AND kind = 'comment') AS comments`,
          [created.task.conversationId, created.task.id],
        )
      ).rows,
    ).toEqual([{ messages: 4, runs: 2, comments: 1 }]);
  });

  it("allows a workspace member to comment but keeps the resumed Run owned by the Task owner", async () => {
    const created = await service.createTask(actor(), {
      idempotencyKey: "task-member-comment",
      goal: "Ask the workspace for review.",
      engine: "opencompany",
      model: "moonshotai/kimi-k3",
      source: "manual",
    });
    await database.query(
      `UPDATE goat.codex_chat_turns SET status = 'completed', completed_at = now() WHERE id = $1`,
      [created.runId],
    );
    await database.query(
      `UPDATE goat.codex_chat_sessions SET status = 'idle', active_turn_id = NULL
       WHERE chat_session_id = $1`,
      [created.task.conversationId],
    );
    await database.query(
      `UPDATE goat.tasks SET status = 'succeeded', stage = 'completed' WHERE id = $1`,
      [created.task.id],
    );

    const result = await service.createComment(
      actor({ userId: "user_3", role: "member" }),
      created.task.id,
      {
        id: "task_comment_member",
        body: "Please add the customer quote.",
      },
    );

    expect(result.comment.authorWorkosId).toBe("user_3");
    await expect(
      database.query<{ run_owner: string; comment_author: string }>(
        `SELECT run.user_workos_id AS run_owner, activity.author_workos_id AS comment_author
         FROM goat.codex_chat_turns AS run
         JOIN goat.task_activities AS activity ON activity.id = 'task_comment_member'
         WHERE run.id = $1`,
        [result.runId],
      ),
    ).resolves.toMatchObject({
      rows: [{ run_owner: "user_1", comment_author: "user_3" }],
    });
  });

  it("rejects comments on archived Tasks", async () => {
    const created = await service.createTask(actor(), {
      idempotencyKey: "task-archived-comment",
      goal: "Finish and archive.",
      engine: "opencompany",
      model: "moonshotai/kimi-k3",
      source: "manual",
    });
    await database.query(
      `UPDATE goat.codex_chat_turns SET status = 'completed', completed_at = now() WHERE id = $1`,
      [created.runId],
    );
    await database.query(
      `UPDATE goat.codex_chat_sessions SET status = 'idle', active_turn_id = NULL
       WHERE chat_session_id = $1`,
      [created.task.conversationId],
    );
    await database.query(
      `UPDATE goat.tasks
       SET status = 'succeeded', stage = 'completed', archived_at = now()
       WHERE id = $1`,
      [created.task.id],
    );

    await expect(
      service.createComment(actor(), created.task.id, {
        id: "task_comment_archived",
        body: "Reopen this.",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("uses a stable cursor and accepts either opaque or display Task identity", async () => {
    const first = await service.createTask(actor(), {
      idempotencyKey: "task-page-1",
      goal: "First task",
      engine: "opencompany",
      model: "moonshotai/kimi-k3",
      source: "manual",
    });
    const second = await service.createTask(actor(), {
      idempotencyKey: "task-page-2",
      goal: "Second task",
      engine: "opencompany",
      model: "moonshotai/kimi-k3",
      source: "manual",
    });

    const firstPage = await service.listTasks(actor(), { limit: 1 });
    if (!firstPage.nextCursor) throw new Error("Expected another Task page.");
    const secondPage = await service.listTasks(actor(), {
      cursor: firstPage.nextCursor,
      limit: 1,
    });
    expect(new Set([...firstPage.tasks, ...secondPage.tasks].map((task) => task.id))).toEqual(
      new Set([first.task.id, second.task.id]),
    );
    await expect(
      service.getTask(actor(), second.task.displayId.toLowerCase()),
    ).resolves.toMatchObject({ id: second.task.id });
  });

  it("claims an attachment once and replays without resolving it again", async () => {
    const uploads = new PostgresChatAttachmentRepository(
      execute,
      () => new Date("2026-08-11T10:00:00.000Z"),
    );
    await expect(
      uploads.create({
        actor: actor(),
        id: "attachment_1",
        format: "pdf",
        mediaType: "application/pdf",
        filename: "launch.pdf",
        sizeBytes: 2048,
        blobPathname: "private/user_1/launch.pdf",
        blobUrl: "https://blob.invalid/launch.pdf",
        extractedText: "Private launch context",
        expiresAt: new Date("2026-08-12T10:00:00.000Z"),
      }),
    ).resolves.toMatchObject({ id: "attachment_1" });
    let resolutions = 0;
    const attachmentService = new TaskApplicationService(
      new PostgresTaskRepository(execute, {
        ids: deterministicTaskIds(),
        now: () => new Date("2026-08-11T10:00:00.000Z"),
        resolveAttachments: async (input) => {
          resolutions += 1;
          return uploads.resolve(input);
        },
      }),
    );
    const command = {
      idempotencyKey: "task-attachment",
      goal: "Review the launch plan",
      engine: "opencompany" as const,
      model: "moonshotai/kimi-k3",
      source: "manual" as const,
      attachmentIds: ["attachment_1"],
    };

    const first = await attachmentService.createTask(actor(), command);
    await expect(attachmentService.createTask(actor(), command)).resolves.toEqual({
      ...first,
      idempotentReplay: true,
    });
    expect(resolutions).toBe(1);
    expect(
      (
        await database.query<{ claimed_message_id: string; claimed_at: Date }>(`
          SELECT claimed_message_id, claimed_at
          FROM goat.chat_attachment_uploads
          WHERE id = 'attachment_1'
        `)
      ).rows,
    ).toEqual([
      {
        claimed_message_id: first.messageId,
        claimed_at: new Date("2026-08-11T10:00:00.000Z"),
      },
    ]);
  });

  it("bounds legacy producer metadata inside the canonical Task transaction", async () => {
    const compatibilityService = new TaskApplicationService(
      new PostgresTaskRepository(execute, {
        ids: deterministicTaskIds(),
        now: () => new Date("2026-08-11T10:00:00.000Z"),
        compatibility: {
          brainRef: "brain_1",
          workflowBrainRef: "workflow_brain_1",
          resolvedAttachments: {
            attachments: [
              {
                id: "legacy_attachment_1",
                kind: "pdf",
                mediaType: "application/pdf",
                filename: "legacy.pdf",
                sizeBytes: 512,
                blobPathname: "private/user_1/legacy.pdf",
                blobUrl: "https://blob.invalid/legacy.pdf",
              },
            ],
            attachmentTexts: { legacy_attachment_1: "Legacy attachment text" },
          },
        },
        resolveHarness: async ({ command }) => ({
          schemaVersion: "goat.harness.v1",
          engine: command.engine,
          model: command.model,
          systemPrompt: "Prepared workflow",
          initialUserMessage: command.goal,
          tools: [],
          skills: [],
          maxModelSteps: 16,
          resultMode: "assistant_final",
        }),
      }),
    );

    const created = await compatibilityService.createTask(actor(), {
      idempotencyKey: "workflow-legacy-boundary-1",
      goal: "Run the prepared workflow",
      engine: "opencompany",
      model: "moonshotai/kimi-k3",
      source: "workflow",
      workflowId: "workflow_1",
      attachmentIds: ["legacy_attachment_1"],
    });

    expect(
      await database.query<{
        brain_ref: string;
        workflow_brain_ref: string;
        attachment_id: string;
        has_task_id: boolean;
      }>(
        `SELECT
           runtime.brain_ref,
           task.workflow_brain_ref,
           message.attachments->0->>'id' AS attachment_id,
           event.payload ? 'taskId' AS has_task_id
         FROM goat.tasks AS task
         JOIN goat.codex_chat_sessions AS runtime ON runtime.chat_session_id = task.session_id
         JOIN goat.chat_messages AS message
           ON message.session_id = task.session_id AND message.role = 'user'
         JOIN goat.codex_chat_turns AS run ON run.chat_session_id = task.session_id
         JOIN goat.run_events AS event ON event.run_id = run.id AND event.type = 'run.queued'
         WHERE task.id = $1`,
        [created.task.id],
      ),
    ).toMatchObject({
      rows: [
        {
          brain_ref: "brain_1",
          workflow_brain_ref: "workflow_brain_1",
          attachment_id: "legacy_attachment_1",
          has_task_id: false,
        },
      ],
    });
    expect(
      await database.query<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM goat.chat_attachment_uploads",
      ),
    ).toMatchObject({ rows: [{ count: 0 }] });
  });

  it("archives only terminal Tasks and reflects the lifecycle in the read model", async () => {
    const created = await service.createTask(actor(), {
      idempotencyKey: "task-archive",
      goal: "Finish before archive",
      engine: "opencompany",
      model: "moonshotai/kimi-k3",
      source: "manual",
    });
    await expect(
      service.updateTask(actor(), created.task.id, { archived: true }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    await database.query(
      `UPDATE goat.tasks SET status = 'succeeded', stage = 'completed' WHERE id = $1`,
      [created.task.id],
    );
    await expect(
      service.updateTask(actor(), created.task.id, { archived: true }),
    ).resolves.toMatchObject({
      task: { id: created.task.id, status: "archived" },
    });
    expect(
      (
        await database.query<{ status: string }>(
          "SELECT status FROM goat.task_read_model_v1 WHERE id = $1",
          [created.task.id],
        )
      ).rows,
    ).toEqual([{ status: "archived" }]);
  });

  it("renames Task metadata and its one canonical Conversation together", async () => {
    const created = await service.createTask(actor(), {
      idempotencyKey: "task-rename",
      goal: "Draft the brief",
      engine: "opencompany",
      model: "moonshotai/kimi-k3",
      source: "workflow",
    });

    await expect(
      service.updateTask(actor(), created.task.id, { name: "Launch brief" }),
    ).resolves.toMatchObject({ task: { name: "Launch brief" } });
    await expect(
      database.query<{ task_name: string; conversation_title: string }>(
        `SELECT task.name AS task_name, conversation.title AS conversation_title
         FROM goat.tasks AS task
         JOIN goat.chat_sessions AS conversation ON conversation.id = task.session_id
         WHERE task.id = $1`,
        [created.task.id],
      ),
    ).resolves.toMatchObject({
      rows: [{ task_name: "Launch brief", conversation_title: "Launch brief" }],
    });
  });
});

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    userId: "user_1",
    workspaceId: "workspace_1",
    role: "admin",
    permissions: [TASK_READ_PERMISSION, TASK_WRITE_PERMISSION],
    authenticationMethod: "session",
    ...overrides,
  };
}

function deterministicTaskIds(): TaskRepositoryIdFactory {
  let sequence = 0;
  const next = (kind: string) => `${kind}_${++sequence}`;
  return {
    command: () => next("command"),
    task: () => next("task"),
    conversation: () => next("conversation"),
    message: () => next("message"),
    runtime: () => next("runtime"),
    run: () => next("run"),
    event: () => next("event"),
  };
}

const BASE_SCHEMA = `
  CREATE SCHEMA goat;
  CREATE SEQUENCE goat.task_display_id_seq;
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
  CREATE TABLE goat.brains (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    slug text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE goat.chat_sessions (
    id text PRIMARY KEY,
    user_workos_id text NOT NULL REFERENCES goat.users(workos_user_id),
    title text NOT NULL DEFAULT 'New chat',
    model text NOT NULL,
    engine text NOT NULL DEFAULT 'opencompany',
    kind text NOT NULL DEFAULT 'chat',
    closed_at timestamptz,
    pinned_at timestamptz,
    last_seen_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE goat.tasks (
    id text PRIMARY KEY,
    display_id text NOT NULL DEFAULT ('TASK-' || nextval('goat.task_display_id_seq')::text),
    name text NOT NULL DEFAULT 'Untitled task',
    user_workos_id text NOT NULL REFERENCES goat.users(workos_user_id),
    workspace_id text REFERENCES goat.workspaces(id),
    prompt text NOT NULL,
    model text NOT NULL,
    session_id text REFERENCES goat.chat_sessions(id),
    schedule_id text,
    scheduled_for timestamptz,
    status text NOT NULL DEFAULT 'queued',
    stage text NOT NULL DEFAULT 'queued',
    result text,
    error text,
    workflow_id text,
    workflow_brain_ref text,
    reported_outcome text,
    outcome_comment text,
    harness_spec jsonb NOT NULL DEFAULT '{}'::jsonb,
    debug_trace jsonb NOT NULL DEFAULT '{}'::jsonb,
    codex_engine_session_id text,
    sandbox_id text,
    attempts integer NOT NULL DEFAULT 0,
    next_run_at timestamptz NOT NULL DEFAULT now(),
    lease_id text,
    lease_owner text,
    lease_expires_at timestamptz,
    archived_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE goat.tasks ADD CONSTRAINT goat_tasks_status_check
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled'));
  CREATE UNIQUE INDEX goat_tasks_session_idx ON goat.tasks(session_id) WHERE session_id IS NOT NULL;
  CREATE TABLE goat.task_messages (
    id text PRIMARY KEY,
    task_id text NOT NULL REFERENCES goat.tasks(id),
    user_workos_id text NOT NULL REFERENCES goat.users(workos_user_id),
    role text NOT NULL,
    status text NOT NULL,
    content text NOT NULL DEFAULT '',
    tool_name text,
    tool_call_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz
  );
  CREATE TABLE goat.task_events (
    id serial PRIMARY KEY,
    task_id text NOT NULL REFERENCES goat.tasks(id),
    user_workos_id text NOT NULL REFERENCES goat.users(workos_user_id),
    message_id text REFERENCES goat.task_messages(id),
    type text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE goat.task_model_usage (
    id serial PRIMARY KEY,
    task_id text NOT NULL REFERENCES goat.tasks(id),
    user_workos_id text NOT NULL REFERENCES goat.users(workos_user_id),
    total_cost_usd_micros bigint NOT NULL DEFAULT 0
  );
  CREATE TABLE goat.task_tool_usage (
    id serial PRIMARY KEY,
    task_id text NOT NULL REFERENCES goat.tasks(id),
    user_workos_id text NOT NULL REFERENCES goat.users(workos_user_id),
    total_cost_usd_micros bigint NOT NULL DEFAULT 0
  );
  CREATE TABLE goat.task_sandbox_usage (
    id serial PRIMARY KEY,
    task_id text NOT NULL REFERENCES goat.tasks(id),
    user_workos_id text NOT NULL REFERENCES goat.users(workos_user_id),
    total_cost_usd_micros bigint NOT NULL DEFAULT 0
  );
  CREATE TABLE goat.chat_messages (
    id text PRIMARY KEY,
    session_id text NOT NULL REFERENCES goat.chat_sessions(id),
    role text NOT NULL,
    content text NOT NULL DEFAULT '',
    task_id text,
    debug_trace jsonb,
    attachments jsonb,
    attachment_texts jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE goat.credit_ledger (
    id serial PRIMARY KEY,
    user_workos_id text NOT NULL REFERENCES goat.users(workos_user_id),
    chat_session_id text REFERENCES goat.chat_sessions(id),
    amount_usd_micros bigint NOT NULL
  );
  CREATE TABLE goat.codex_chat_sessions (
    id text PRIMARY KEY,
    user_workos_id text NOT NULL,
    chat_session_id text NOT NULL UNIQUE REFERENCES goat.chat_sessions(id),
    engine text NOT NULL DEFAULT 'codex',
    model text NOT NULL,
    brain_ref text,
    workspace_id text,
    host_tool_contract_version text,
    sandbox_id text,
    codex_thread_id text,
    active_turn_id text,
    status text NOT NULL DEFAULT 'queued',
    error text,
    sandbox_timeout_armed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE goat.codex_chat_turns (
    id text PRIMARY KEY,
    user_workos_id text NOT NULL,
    codex_chat_session_id text NOT NULL REFERENCES goat.codex_chat_sessions(id),
    chat_session_id text NOT NULL REFERENCES goat.chat_sessions(id),
    user_message_id text NOT NULL REFERENCES goat.chat_messages(id),
    assistant_message_id text NOT NULL UNIQUE REFERENCES goat.chat_messages(id),
    codex_turn_id text,
    status text NOT NULL DEFAULT 'queued',
    prompt text NOT NULL,
    settings jsonb NOT NULL DEFAULT '{}',
    error text,
    interrupt_requested_at timestamptz,
    attempts integer NOT NULL DEFAULT 0,
    recovery_attempts integer NOT NULL DEFAULT 0,
    engine_recovery_required boolean NOT NULL DEFAULT false,
    engine_turn_baseline_ids jsonb,
    lease_id text,
    lease_owner text,
    lease_expires_at timestamptz,
    run_after timestamptz,
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE goat.codex_chat_interactions (
    id text PRIMARY KEY,
    user_workos_id text NOT NULL,
    codex_chat_session_id text NOT NULL,
    codex_chat_turn_id text NOT NULL,
    lease_id text NOT NULL,
    request_id text NOT NULL,
    item_id text,
    method text NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    request jsonb NOT NULL,
    response jsonb,
    resolved_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
`;
