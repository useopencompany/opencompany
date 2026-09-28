import type { RunReadModel } from "@opencompany/protocol/schemas";
import { getChatDatabase, parseJson, values, withChatTransaction } from "./database";
import type { ChatPartition, CheckpointRow, RunCheckpoint } from "./types";

// The Run a conversation is executing, ahead of any queued behind it. A Task can hold several
// nonterminal Runs at once: the working one streams and takes Stop, the rest wait their turn.
export const ACTIVE_RUN_ORDER = `CASE status WHEN 'running' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, rowid ASC`;

const NONTERMINAL_RUN_STATUSES = new Set(["queued", "running", "paused"]);

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
      ORDER BY ${ACTIVE_RUN_ORDER} LIMIT 1`,
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

/** Reply Messages of Runs still waiting behind the active one, which render as pending. */
export const listQueuedRunMessageIds = async (
  partition: ChatPartition,
  conversationId: string,
): Promise<string[]> => {
  const database = await getChatDatabase();
  const rows = await database.getAllAsync<{ assistant_message_id: string }>(
    `SELECT assistant_message_id FROM run_checkpoints
      WHERE user_id = ? AND workspace_id = ? AND conversation_id = ? AND status = 'queued'`,
    ...values(partition),
    conversationId,
  );
  return rows.map((row) => row.assistant_message_id);
};

/**
 * Tracks the server's Runs by their explicit Message pairs. A Run seen for the first time while
 * working replays its stream from the start, so its reply is cleared to an empty projection. A
 * Run the server finished while nothing was streaming it settles here, so it stops rendering as
 * pending.
 */
export const syncRunSnapshots = async (
  partition: ChatPartition,
  conversationId: string,
  runs: RunReadModel[],
): Promise<void> => {
  return withChatTransaction(partition, async (database) => {
    for (const run of runs) {
      const existing = await database.getFirstAsync<{ status: string }>(
        "SELECT status FROM run_checkpoints WHERE user_id = ? AND workspace_id = ? AND run_id = ?",
        ...values(partition),
        run.id,
      );
      if (existing) {
        if (
          NONTERMINAL_RUN_STATUSES.has(existing.status) &&
          !NONTERMINAL_RUN_STATUSES.has(run.status)
        )
          await database.runAsync(
            `UPDATE run_checkpoints SET status = ?, is_stopping = 0, updated_at = ?
              WHERE user_id = ? AND workspace_id = ? AND run_id = ?`,
            run.status,
            Date.now(),
            ...values(partition),
            run.id,
          );
        continue;
      }
      if (!NONTERMINAL_RUN_STATUSES.has(run.status)) continue;
      const assistant = await database.getFirstAsync<{ local_id: string }>(
        "SELECT local_id FROM messages WHERE user_id = ? AND workspace_id = ? AND local_id = ?",
        ...values(partition),
        run.assistantMessageId,
      );
      if (!assistant) continue;
      await database.runAsync(
        `INSERT INTO run_checkpoints (user_id, workspace_id, run_id, conversation_id,
          assistant_message_id, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ...values(partition),
        run.id,
        conversationId,
        run.assistantMessageId,
        run.status,
        Date.now(),
      );
      await database.runAsync(
        "UPDATE messages SET content = '', parts_json = '[]' WHERE user_id = ? AND workspace_id = ? AND local_id = ?",
        ...values(partition),
        run.assistantMessageId,
      );
    }
  });
};

/**
 * Settles Runs this device still tracks as working in conversations the server lists as idle.
 * Nothing streams a conversation that is not open, so without this its row would spin forever.
 * Only checkpoints last touched before the listing started are settled, so a Run accepted while
 * the listing was in flight keeps its state.
 */
export const settleIdleConversationRuns = async (
  partition: ChatPartition,
  idleConversationIds: readonly string[],
  listingStartedAt: number,
): Promise<void> => {
  return withChatTransaction(partition, async (database) => {
    await database.runAsync(
      `UPDATE run_checkpoints SET status = 'completed', is_stopping = 0
        WHERE user_id = ? AND workspace_id = ? AND status IN ('queued', 'running', 'paused')
          AND updated_at < ? AND conversation_id IN (SELECT value FROM json_each(?))`,
      ...values(partition),
      listingStartedAt,
      JSON.stringify(idleConversationIds),
    );
  });
};
