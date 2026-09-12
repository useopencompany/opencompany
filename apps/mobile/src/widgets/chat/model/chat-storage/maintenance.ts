import { getChatDatabase, values, withChatTransaction } from "./database";
import { attachmentDirectory, deleteFiles } from "./files";
import type { ChatPartition } from "./types";

export const hasPendingWorkspaceWork = async (partition: ChatPartition): Promise<boolean> => {
  const database = await getChatDatabase();
  const row = await database.getFirstAsync<{ count: number }>(
    `SELECT (
       (SELECT COUNT(*) FROM drafts WHERE user_id = ? AND workspace_id = ? AND text <> '') +
       (SELECT COUNT(*) FROM attachments WHERE user_id = ? AND workspace_id = ? AND owner_kind = 'draft') +
       (SELECT COUNT(*) FROM outbox WHERE user_id = ? AND workspace_id = ?)
     ) AS count`,
    ...values(partition),
    ...values(partition),
    ...values(partition),
  );
  return (row?.count ?? 0) > 0;
};

export const purgePartition = async (partition: ChatPartition): Promise<void> => {
  const uris = await withChatTransaction(null, async (database) => {
    const rows = await database.getAllAsync<{ uri: string }>(
      "SELECT uri FROM attachments WHERE user_id = ? AND workspace_id = ?",
      ...values(partition),
    );
    for (const table of [
      "run_checkpoints",
      "outbox",
      "attachments",
      "drafts",
      "messages",
      "conversations",
    ]) {
      await database.runAsync(
        `DELETE FROM ${table} WHERE user_id = ? AND workspace_id = ?`,
        ...values(partition),
      );
    }
    return rows.map((row) => row.uri);
  });
  deleteFiles(uris);
};

export const purgeAllChatData = async (): Promise<void> => {
  await withChatTransaction(null, async (database) => {
    for (const table of [
      "run_checkpoints",
      "outbox",
      "attachments",
      "drafts",
      "messages",
      "conversations",
    ]) {
      await database.execAsync(`DELETE FROM ${table}`);
    }
  });
  const directory = attachmentDirectory();
  if (directory.exists) directory.delete();
};

export const evictCompletedCache = async (partition: ChatPartition): Promise<void> => {
  const uris = await withChatTransaction(partition, async (database) => {
    await database.runAsync(
      `DELETE FROM conversations
        WHERE user_id = ? AND workspace_id = ? AND local_id IN (
          SELECT c.local_id FROM conversations c
           WHERE c.user_id = ? AND c.workspace_id = ?
             AND json_extract(c.runtime_json, '$.activeRunId') IS NULL
             AND NOT EXISTS (SELECT 1 FROM drafts d WHERE d.user_id = c.user_id AND d.workspace_id = c.workspace_id AND d.conversation_id = c.local_id)
             AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.user_id = c.user_id AND o.workspace_id = c.workspace_id AND o.conversation_id = c.local_id)
             AND NOT EXISTS (SELECT 1 FROM run_checkpoints r WHERE r.user_id = c.user_id AND r.workspace_id = c.workspace_id AND r.conversation_id = c.local_id AND r.status IN ('queued','running','paused'))
           ORDER BY c.last_viewed_at DESC LIMIT -1 OFFSET 100
        )`,
      ...values(partition),
      ...values(partition),
    );
    await database.runAsync(
      `DELETE FROM messages WHERE rowid IN (
         SELECT m.rowid FROM messages m JOIN conversations c
           ON c.user_id = m.user_id AND c.workspace_id = m.workspace_id AND c.local_id = m.conversation_id
          WHERE m.user_id = ? AND m.workspace_id = ? AND m.delivery = 'accepted'
            AND json_extract(c.runtime_json, '$.activeRunId') IS NULL
            AND NOT EXISTS (SELECT 1 FROM drafts d WHERE d.user_id = c.user_id AND d.workspace_id = c.workspace_id AND d.conversation_id = c.local_id)
            AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.user_id = c.user_id AND o.workspace_id = c.workspace_id AND o.conversation_id = c.local_id)
            AND NOT EXISTS (SELECT 1 FROM run_checkpoints r WHERE r.user_id = c.user_id AND r.workspace_id = c.workspace_id AND r.conversation_id = c.local_id AND r.status IN ('queued','running','paused'))
          ORDER BY m.created_at DESC LIMIT -1 OFFSET 10000
       )`,
      ...values(partition),
    );
    const orphans = await database.getAllAsync<{ local_id: string; uri: string }>(
      `SELECT a.local_id, a.uri FROM attachments a WHERE a.user_id = ? AND a.workspace_id = ?
        AND a.owner_kind = 'command'
        AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.user_id = a.user_id AND c.workspace_id = a.workspace_id AND c.local_id = a.conversation_id)
        AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.user_id = a.user_id AND o.workspace_id = a.workspace_id AND o.id = a.owner_id)`,
      ...values(partition),
    );
    for (const orphan of orphans)
      await database.runAsync(
        "DELETE FROM attachments WHERE user_id = ? AND workspace_id = ? AND local_id = ?",
        ...values(partition),
        orphan.local_id,
      );
    return orphans.map((row) => row.uri);
  });
  deleteFiles(uris);
};
