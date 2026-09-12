import type { AttachmentDto, ConversationDto, MessageDto } from "@opencompany/protocol/schemas";
import type { ChatMessage, ChatPart } from "../chat";
import { getChatDatabase, parseJson, values, withChatTransaction } from "./database";
import type { ChatPartition, ConversationRow, MessageRow, StoredConversation } from "./types";

const conversationFromRow = (row: ConversationRow): StoredConversation => ({
  id: row.local_id,
  title: row.title,
  engine: row.engine,
  model: row.model,
  runtime: row.runtime_json ? parseJson<ConversationDto["runtime"]>(row.runtime_json) : null,
  updatedAt: row.updated_at,
  lastViewedAt: row.last_viewed_at,
  provisional: Boolean(row.provisional),
});

export const listStoredConversations = async (
  partition: ChatPartition,
): Promise<StoredConversation[]> => {
  const database = await getChatDatabase();
  const rows = await database.getAllAsync<ConversationRow>(
    `SELECT local_id, title, engine, model, runtime_json, updated_at,
            last_viewed_at, provisional
       FROM conversations
      WHERE user_id = ? AND workspace_id = ?
      ORDER BY updated_at DESC`,
    ...values(partition),
  );
  return rows.map(conversationFromRow);
};

export const listStoredMessages = async (
  partition: ChatPartition,
  conversationId: string,
): Promise<ChatMessage[]> => {
  const database = await getChatDatabase();
  const rows = await database.getAllAsync<MessageRow>(
    `SELECT local_id, role, content, parts_json, delivery, created_at
       FROM messages
      WHERE user_id = ? AND workspace_id = ? AND conversation_id = ?
      ORDER BY created_at ASC`,
    ...values(partition),
    conversationId,
  );
  const approvals = await database.getAllAsync<{ approval_id: string }>(
    "SELECT approval_id FROM outbox WHERE user_id = ? AND workspace_id = ? AND conversation_id = ? AND kind = 'approval'",
    ...values(partition),
    conversationId,
  );
  const sendingApprovals = new Set(approvals.map((row) => row.approval_id));
  return rows.map((row) => ({
    id: row.local_id,
    role: row.role,
    content: row.content,
    parts: parseJson<ChatPart[]>(row.parts_json).map((part) =>
      part.type === "approval" && part.status === "pending" && sendingApprovals.has(part.approvalId)
        ? { ...part, status: "sending" }
        : part,
    ),
    delivery: row.delivery,
    createdAt: row.created_at,
  }));
};

export const getStoredConversation = async (
  partition: ChatPartition,
  conversationId: string,
): Promise<StoredConversation | null> => {
  const database = await getChatDatabase();
  const row = await database.getFirstAsync<ConversationRow>(
    "SELECT * FROM conversations WHERE user_id = ? AND workspace_id = ? AND local_id = ?",
    ...values(partition),
    conversationId,
  );
  return row ? conversationFromRow(row) : null;
};

export const mergeConversationSnapshots = async (
  partition: ChatPartition,
  conversations: ConversationDto[],
): Promise<void> => {
  return withChatTransaction(partition, async (database) => {
    const now = Date.now();
    for (const conversation of conversations)
      await database.runAsync(
        `INSERT INTO conversations (
       user_id, workspace_id, local_id, title, engine, model, runtime_json,
       updated_at, last_viewed_at, provisional
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT (user_id, workspace_id, local_id) DO UPDATE SET
       title = excluded.title, engine = excluded.engine,
       model = excluded.model, runtime_json = excluded.runtime_json,
       updated_at = excluded.updated_at, provisional = 0`,
        ...values(partition),
        conversation.id,
        conversation.title,
        conversation.engine,
        conversation.model,
        JSON.stringify(conversation.runtime),
        conversation.updatedAt,
        now,
      );
  });
};

export const mergeMessageSnapshots = async (
  partition: ChatPartition,
  conversationId: string,
  messages: MessageDto[],
): Promise<void> => {
  return withChatTransaction(partition, async (database) => {
    for (const message of messages) {
      const parts: ChatPart[] = [
        ...(message.content
          ? ([{ type: "text", text: message.content }] satisfies ChatPart[])
          : []),
        ...message.attachments.map(
          (attachment: AttachmentDto): ChatPart => ({ type: "attachment", attachment }),
        ),
      ];
      await database.runAsync(
        `INSERT INTO messages (
           user_id, workspace_id, local_id, conversation_id, role, content,
           parts_json, delivery, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?)
         ON CONFLICT (user_id, workspace_id, local_id) DO UPDATE SET
           role = excluded.role, content = excluded.content,
           parts_json = excluded.parts_json,
           delivery = 'accepted', updated_at = excluded.updated_at
         WHERE NOT EXISTS (
           SELECT 1 FROM run_checkpoints r WHERE r.user_id = messages.user_id
             AND r.workspace_id = messages.workspace_id AND r.assistant_message_id = messages.local_id
         )`,
        ...values(partition),
        message.id,
        conversationId,
        message.role,
        message.content,
        JSON.stringify(parts),
        Date.parse(message.createdAt),
        Date.parse(message.updatedAt),
      );
    }
  });
};

export const markConversationViewed = async (
  partition: ChatPartition,
  conversationId: string,
): Promise<void> => {
  return withChatTransaction(partition, async (database) => {
    await database.runAsync(
      `UPDATE conversations SET last_viewed_at = ?
      WHERE user_id = ? AND workspace_id = ? AND local_id = ?`,
      Date.now(),
      ...values(partition),
      conversationId,
    );
  });
};
