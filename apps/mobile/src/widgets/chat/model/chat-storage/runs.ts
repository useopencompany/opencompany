import type { RunDto } from "@opencompany/protocol/schemas";
import { getChatDatabase, parseJson, values, withChatTransaction } from "./database";
import type { ChatPartition, CheckpointRow, RunCheckpoint } from "./types";

export const getRunCheckpoint = async (
  partition: ChatPartition,
  runId: string,
): Promise<RunCheckpoint | null> => {
  const database = await getChatDatabase();
  const row = await database.getFirstAsync<CheckpointRow>(
    `SELECT r.run_id, r.conversation_id, r.assistant_message_id, r.status, m.content, m.parts_json,
            durable_cursor, presentation_cursor,
            (is_stopping OR EXISTS (SELECT 1 FROM outbox o WHERE o.user_id = r.user_id
              AND o.workspace_id = r.workspace_id AND o.run_id = r.run_id AND o.kind = 'stop')) AS is_stopping
       FROM run_checkpoints r JOIN messages m ON m.user_id = r.user_id
         AND m.workspace_id = r.workspace_id AND m.local_id = r.assistant_message_id
       WHERE r.user_id = ? AND r.workspace_id = ? AND r.run_id = ?`,
    ...values(partition),
    runId,
  );
  return row
    ? {
        runId: row.run_id,
        conversationId: row.conversation_id,
        assistantMessageId: row.assistant_message_id,
        status: row.status,
        content: row.content,
        parts: parseJson(row.parts_json),
        cursor: row.durable_cursor,
        presentationCursor: row.presentation_cursor,
        isStopping: Boolean(row.is_stopping),
      }
    : null;
};

export const getConversationRunCheckpoint = async (
  partition: ChatPartition,
  conversationId: string,
): Promise<RunCheckpoint | null> => {
  const database = await getChatDatabase();
  const row = await database.getFirstAsync<{ run_id: string }>(
    `SELECT run_id FROM run_checkpoints
      WHERE user_id = ? AND workspace_id = ? AND conversation_id = ?
        AND status IN ('queued', 'running', 'paused')
      ORDER BY updated_at DESC LIMIT 1`,
    ...values(partition),
    conversationId,
  );
  return row ? getRunCheckpoint(partition, row.run_id) : null;
};

export const applyRunProjection = async (
  partition: ChatPartition,
  checkpoint: RunCheckpoint,
): Promise<void> => {
  return withChatTransaction(partition, async (database) => {
    await database.runAsync(
      `UPDATE run_checkpoints SET status = ?, durable_cursor = ?,
         presentation_cursor = ?, is_stopping = ?, updated_at = ?
       WHERE user_id = ? AND workspace_id = ? AND run_id = ?`,
      checkpoint.status,
      checkpoint.cursor,
      checkpoint.presentationCursor,
      checkpoint.isStopping ? 1 : 0,
      Date.now(),
      ...values(partition),
      checkpoint.runId,
    );
    await database.runAsync(
      `UPDATE messages SET content = ?, parts_json = ?, updated_at = ?
        WHERE user_id = ? AND workspace_id = ? AND local_id = ?`,
      checkpoint.content,
      JSON.stringify(checkpoint.parts),
      Date.now(),
      ...values(partition),
      checkpoint.assistantMessageId,
    );
  });
};

export const setRunSnapshot = async (partition: ChatPartition, run: RunDto): Promise<void> => {
  return withChatTransaction(partition, async (database) => {
    const existing = await database.getFirstAsync<{ run_id: string }>(
      "SELECT run_id FROM run_checkpoints WHERE user_id = ? AND workspace_id = ? AND run_id = ?",
      ...values(partition),
      run.id,
    );
    if (existing) return; // Only stream events may advance an existing projection and its status.
    const assistant = await database.getFirstAsync<{ local_id: string }>(
      `SELECT local_id FROM messages WHERE user_id = ? AND workspace_id = ?
        AND conversation_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1`,
      ...values(partition),
      run.conversationId,
    );
    if (!assistant) return;
    await database.runAsync(
      `INSERT INTO run_checkpoints (user_id, workspace_id, run_id, conversation_id,
        assistant_message_id, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ...values(partition),
      run.id,
      run.conversationId,
      assistant.local_id,
      run.status,
      Date.now(),
    );
    // Start replay from an empty projection. A snapshot has no matching event cursor.
    await database.runAsync(
      "UPDATE messages SET content = '', parts_json = '[]' WHERE user_id = ? AND workspace_id = ? AND local_id = ?",
      ...values(partition),
      assistant.local_id,
    );
  });
};
