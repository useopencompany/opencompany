import { createHash } from "node:crypto";
import type { ActionGatewayResponse } from "@opencompany/agent-runtime";
import { type SQL, sql } from "drizzle-orm";
import { actionApprovalInputHash } from "./action-governance";
import { stringifyPostgresJson } from "./postgres-json";

export type TaskActionRequest = {
  invocationId: string;
  action: string;
  params: Record<string, unknown>;
  decision: "pending" | "approved" | "denied";
  executionStatus: "pending" | "executing" | "completed";
  result: ActionGatewayResponse | null;
};

export type TaskActionLease = { runId: string; leaseId: string };

// An engine retry (including a fresh MCP request id) must find the same reviewed input.
export function taskActionInvocationId(
  runId: string,
  action: string,
  params: Record<string, unknown>,
) {
  return `task_action_${createHash("sha256")
    .update(JSON.stringify([runId, action, actionApprovalInputHash(params)]))
    .digest("hex")}`;
}

export class PostgresTaskActionApprovalRepository {
  constructor(private readonly execute: (query: SQL) => Promise<unknown>) {}

  async requests(runId: string): Promise<TaskActionRequest[]> {
    return this.rows<TaskActionRequest>(sql`
      SELECT entry.key AS "invocationId", entry.value ->> 'actionId' AS action,
             entry.value -> 'taskRequest' -> 'params' AS params,
             entry.value ->> 'status' AS decision,
             entry.value -> 'taskRequest' ->> 'executionStatus' AS "executionStatus",
             entry.value -> 'taskRequest' -> 'result' AS result
      FROM goat.action_turns AS action_turn
      CROSS JOIN LATERAL jsonb_each(action_turn.approval_records) AS entry
      WHERE action_turn.turn_id = ${runId} AND entry.value ? 'taskRequest'
      ORDER BY entry.key
    `);
  }

  // Present one approval at a time. Parallel engine calls must wait for the current
  // decision instead of creating independent approvals that race to resume the Run.
  async stage(input: TaskActionLease & { invocationId: string; params: Record<string, unknown> }) {
    const rows = await this.rows(sql`
      WITH fenced AS MATERIALIZED (
        SELECT run.id FROM goat.codex_chat_turns AS run
        JOIN goat.chat_sessions AS chat ON chat.id = run.chat_session_id
        WHERE run.id = ${input.runId} AND run.lease_id = ${input.leaseId}
          AND run.status = 'running' AND run.interrupt_requested_at IS NULL AND chat.kind = 'task'
          AND COALESCE(run.settings ->> 'taskActionApprovalPending', 'false') <> 'true'
        FOR UPDATE OF run
      ), staged AS (
        UPDATE goat.action_turns AS action_turn
        SET approval_records = jsonb_set(approval_records, ARRAY[${input.invocationId}, 'taskRequest'],
              jsonb_build_object('params', ${stringifyPostgresJson(input.params)}::jsonb,
                                 'executionStatus', 'pending')),
            updated_at = now()
        WHERE action_turn.turn_id IN (SELECT id FROM fenced)
          AND approval_records -> ${input.invocationId} ->> 'status' = 'pending'
          AND COALESCE(approval_records -> ${input.invocationId} ->> 'paramsHash',
                       approval_records -> ${input.invocationId} ->> 'inputHash') = ${actionApprovalInputHash(input.params)}
          AND NOT (approval_records -> ${input.invocationId} ? 'taskRequest')
        RETURNING turn_id
      )
      UPDATE goat.codex_chat_turns AS run
      SET settings = jsonb_set(settings, '{taskActionApprovalPending}', 'true'), updated_at = now()
      WHERE run.id IN (SELECT turn_id FROM staged)
      RETURNING run.id
    `);
    return rows.length === 1;
  }

  // Commit the execution claim before contacting the provider. A lost response is ambiguous:
  // recovery reports it for inspection instead of risking a duplicate external write.
  async claim(input: TaskActionLease & { invocationId: string }) {
    const rows = await this.rows(sql`
      UPDATE goat.action_turns AS action_turn
      SET approval_records = jsonb_set(approval_records,
            ARRAY[${input.invocationId}, 'taskRequest', 'executionStatus'], '"executing"'),
          updated_at = now()
      WHERE action_turn.turn_id = ${input.runId}
        AND approval_records -> ${input.invocationId} ->> 'status' IN ('approved', 'denied')
        AND approval_records -> ${input.invocationId} -> 'taskRequest' ->> 'executionStatus' = 'pending'
        AND EXISTS (
          SELECT 1 FROM goat.codex_chat_turns AS run
          WHERE run.id = action_turn.turn_id AND run.lease_id = ${input.leaseId}
            AND run.status = 'running' AND run.interrupt_requested_at IS NULL
        )
      RETURNING action_turn.id
    `);
    return rows.length === 1;
  }

  async complete(input: TaskActionLease & { invocationId: string; result: ActionGatewayResponse }) {
    const rows = await this.rows(sql`
      WITH completed AS (
      UPDATE goat.action_turns AS action_turn
      SET approval_records = jsonb_set(approval_records, ARRAY[${input.invocationId}, 'taskRequest'],
            (approval_records -> ${input.invocationId} -> 'taskRequest') ||
            jsonb_build_object('executionStatus', 'completed', 'result', ${stringifyPostgresJson(input.result)}::jsonb)),
          updated_at = now()
      WHERE action_turn.turn_id = ${input.runId}
        AND approval_records -> ${input.invocationId} -> 'taskRequest' ->> 'executionStatus' = 'executing'
        AND EXISTS (
          SELECT 1 FROM goat.codex_chat_turns AS run
          WHERE run.id = action_turn.turn_id AND run.lease_id = ${input.leaseId} AND run.status = 'running'
        )
      RETURNING action_turn.id, action_turn.turn_id
      ), projected AS (
        UPDATE goat.chat_messages AS message
        SET debug_trace = jsonb_set(message.debug_trace, '{uiMessageParts}', (
              SELECT jsonb_agg(CASE WHEN part.value ->> 'toolCallId' = ${input.invocationId}
                THEN (part.value - 'approval') || jsonb_build_object('state', 'output-available',
                  'output', ${stringifyPostgresJson({ ...input.result, status: input.result.ok ? "completed" : "failed" })}::jsonb)
                ELSE part.value END ORDER BY part.ordinality)
              FROM jsonb_array_elements(message.debug_trace -> 'uiMessageParts') WITH ORDINALITY AS part(value, ordinality)
            )), updated_at = now()
        FROM goat.codex_chat_turns AS run
        WHERE run.id IN (SELECT turn_id FROM completed) AND message.id = run.assistant_message_id
        RETURNING message.id
      )
      SELECT id FROM completed WHERE EXISTS (SELECT 1 FROM projected)
    `);
    return rows.length === 1;
  }

  private async rows<Row = { id: string }>(query: SQL): Promise<Row[]> {
    const result = await this.execute(query);
    return (Array.isArray(result) ? result : (result as { rows: Row[] }).rows) as Row[];
  }
}
