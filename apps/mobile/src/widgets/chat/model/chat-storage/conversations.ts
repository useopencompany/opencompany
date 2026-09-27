import type {
  AttachmentDto,
  ConversationDto,
  MessageDto,
  TaskReadModel,
} from "@opencompany/protocol/schemas";
import type { ChatMessage, ChatPart } from "../chat";
import { getChatDatabase, parseJson, values, withChatTransaction } from "./database";
import type {
  ChatPartition,
  ConversationRow,
  MessagePresentationCache,
  MessageRow,
  StoredConversation,
} from "./types";

function partIdentity(messageId: string, part: ChatPart, index: number): string {
  if (typeof part.id === "string" && part.id) return part.id;
  switch (part.type) {
    case "tool":
      return `tool:${part.toolCallId}`;
    case "approval":
      return `approval:${part.approvalId}`;
    case "artifact":
      return `artifact:${part.artifactId}`;
    default:
      return `${part.type}:${messageId}:${index}`;
  }
}

const normalizePartIdentities = (messageId: string, parts: ChatPart[]): ChatPart[] =>
  parts.map((part, index) => ({ ...part, id: partIdentity(messageId, part, index) }));

const conversationFromRow = (row: ConversationRow): StoredConversation => ({
  id: row.local_id,
  kind: row.kind,
  title: row.title,
  engine: row.engine,
  model: row.model,
  runtime: row.runtime_json ? parseJson<ConversationDto["runtime"]>(row.runtime_json) : null,
  updatedAt: row.updated_at,
  lastViewedAt: row.last_viewed_at,
  provisional: Boolean(row.provisional),
  pinnedAt: row.pinned_at,
  inSidebar: Boolean(row.in_sidebar),
  activityState: row.activity_state,
  hasUnseen: Boolean(row.has_unseen),
  awaitingInput: Boolean(row.awaiting_input),
  task:
    row.task_id && row.task_display_id && row.task_status
      ? { id: row.task_id, displayId: row.task_display_id, status: row.task_status }
      : null,
  hasLocalWork: Boolean(row.has_local_work),
  hasQueuedMessages: Boolean(row.has_queued_messages),
});

const CONVERSATION_COLUMNS = `c.*,
  EXISTS (
    SELECT 1 FROM outbox o WHERE o.user_id = c.user_id AND o.workspace_id = c.workspace_id
      AND o.conversation_id = c.local_id AND o.kind = 'message'
  ) AS has_queued_messages,
  EXISTS (
    SELECT 1 FROM outbox o WHERE o.user_id = c.user_id AND o.workspace_id = c.workspace_id
      AND o.conversation_id = c.local_id AND o.kind = 'message'
  ) OR EXISTS (
    SELECT 1 FROM run_checkpoints r WHERE r.user_id = c.user_id AND r.workspace_id = c.workspace_id
      AND r.conversation_id = c.local_id AND r.status IN ('queued', 'running', 'paused')
  ) AS has_local_work`;

export const listStoredConversations = async (
  partition: ChatPartition,
): Promise<StoredConversation[]> => {
  const database = await getChatDatabase();
  const rows = await database.getAllAsync<ConversationRow>(
    `SELECT ${CONVERSATION_COLUMNS} FROM conversations c
      WHERE c.user_id = ? AND c.workspace_id = ?
      ORDER BY c.updated_at DESC`,
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
    `SELECT local_id, role, content, parts_json, delivery, created_at,
            presentation_revision, presentation_etag
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
    parts: normalizePartIdentities(row.local_id, parseJson<ChatPart[]>(row.parts_json)).map(
      (part) =>
        part.type === "approval" &&
        part.status === "pending" &&
        sendingApprovals.has(part.approvalId)
          ? { ...part, status: "sending" }
          : part,
    ),
    delivery: row.delivery,
    createdAt: row.created_at,
  }));
};

export const getMessagePresentationCache = async (
  partition: ChatPartition,
  messageId: string,
): Promise<MessagePresentationCache | null> => {
  const database = await getChatDatabase();
  const row = await database.getFirstAsync<{
    presentation_revision: string | null;
    presentation_etag: string | null;
  }>(
    `SELECT presentation_revision, presentation_etag FROM messages
      WHERE user_id = ? AND workspace_id = ? AND local_id = ?`,
    ...values(partition),
    messageId,
  );
  return row ? { revision: row.presentation_revision, etag: row.presentation_etag } : null;
};

export const applyMessagePresentationSnapshot = async (
  partition: ChatPartition,
  messageId: string,
  snapshot: { revision: string; etag: string | null; content: string; parts: ChatPart[] },
): Promise<boolean> =>
  withChatTransaction(partition, async (database) => {
    const result = await database.runAsync(
      `UPDATE messages SET content = ?, parts_json = ?, presentation_revision = ?,
         presentation_etag = ?, updated_at = ?
       WHERE user_id = ? AND workspace_id = ? AND local_id = ?
         AND (presentation_revision IS NULL OR presentation_revision <= ?)`,
      snapshot.content,
      JSON.stringify(snapshot.parts),
      snapshot.revision,
      snapshot.etag,
      Date.now(),
      ...values(partition),
      messageId,
      snapshot.revision,
    );
    return result.changes > 0;
  });

export const getStoredConversation = async (
  partition: ChatPartition,
  conversationId: string,
): Promise<StoredConversation | null> => {
  const database = await getChatDatabase();
  const row = await database.getFirstAsync<ConversationRow>(
    `SELECT ${CONVERSATION_COLUMNS} FROM conversations c
      WHERE c.user_id = ? AND c.workspace_id = ? AND c.local_id = ?`,
    ...values(partition),
    conversationId,
  );
  return row ? conversationFromRow(row) : null;
};

/**
 * Writes server snapshots of chats, or of a Task's conversation read directly.
 *
 * `preserved` names conversations with a pin, rename, or archive the server may not reflect yet.
 * Their reader-owned fields keep the local value, so a refresh that started before the change
 * cannot undo it on screen. A row's kind is set by the list it first arrived in and never flips.
 */
export const mergeConversationSnapshots = async (
  partition: ChatPartition,
  conversations: ConversationDto[],
  preserved: ReadonlySet<string> = new Set(),
): Promise<void> => {
  return withChatTransaction(partition, async (database) => {
    const now = Date.now();
    for (const conversation of conversations) {
      const keepLocal = preserved.has(conversation.id) ? 1 : 0;
      await database.runAsync(
        `INSERT INTO conversations (
       user_id, workspace_id, local_id, title, engine, model, runtime_json,
       updated_at, last_viewed_at, provisional, pinned_at, activity_state, has_unseen,
       awaiting_input
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
     ON CONFLICT (user_id, workspace_id, local_id) DO UPDATE SET
       title = CASE WHEN ? THEN conversations.title ELSE excluded.title END,
       engine = excluded.engine, model = excluded.model,
       runtime_json = excluded.runtime_json, updated_at = excluded.updated_at, provisional = 0,
       pinned_at = CASE
         WHEN ? OR conversations.kind = 'task' THEN conversations.pinned_at
         ELSE excluded.pinned_at
       END,
       activity_state = excluded.activity_state,
       has_unseen = excluded.has_unseen, awaiting_input = excluded.awaiting_input`,
        ...values(partition),
        conversation.id,
        conversation.title,
        conversation.engine,
        conversation.model,
        JSON.stringify(conversation.runtime),
        conversation.updatedAt,
        now,
        conversation.pinnedAt ?? null,
        conversation.activityState,
        conversation.hasUnseen ? 1 : 0,
        conversation.awaitingInput ? 1 : 0,
        keepLocal,
        keepLocal,
      );
    }
  });
};

export const mergeTaskSnapshots = async (
  partition: ChatPartition,
  tasks: TaskReadModel[],
  preserved: ReadonlySet<string> = new Set(),
): Promise<void> => {
  return withChatTransaction(partition, async (database) => {
    const now = Date.now();
    for (const task of tasks) {
      await database.runAsync(
        `INSERT INTO conversations (
       user_id, workspace_id, local_id, kind, title, engine, model, runtime_json,
       updated_at, last_viewed_at, provisional, activity_state, has_unseen, awaiting_input,
       task_id, task_display_id, task_status
     ) VALUES (?, ?, ?, 'task', ?, ?, ?, NULL, ?, ?, 0, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, workspace_id, local_id) DO UPDATE SET
       kind = 'task', title = excluded.title, engine = excluded.engine, model = excluded.model,
       updated_at = excluded.updated_at, provisional = 0,
       activity_state = excluded.activity_state, has_unseen = excluded.has_unseen,
       awaiting_input = excluded.awaiting_input, task_id = excluded.task_id,
       task_display_id = excluded.task_display_id,
       task_status = CASE WHEN ? THEN conversations.task_status ELSE excluded.task_status END`,
        ...values(partition),
        task.conversationId,
        task.name,
        task.engine,
        task.model,
        task.updatedAt,
        now,
        task.status === "queued" || task.status === "running" ? "working" : "idle",
        task.hasUnseen ? 1 : 0,
        task.awaitingInput ? 1 : 0,
        task.id,
        task.displayId,
        task.status,
        preserved.has(task.conversationId) ? 1 : 0,
      );
    }
  });
};

/**
 * Marks exactly the listed conversations as sidebar members. Only call it with the IDs of a
 * complete, successful pagination: a partial list would drop every row it did not reach.
 * Provisional chats and those with a pending local change keep their membership.
 */
export const reconcileSidebarMembership = async (
  partition: ChatPartition,
  listedIds: readonly string[],
  preserved: ReadonlySet<string>,
): Promise<void> => {
  return withChatTransaction(partition, async (database) => {
    await database.runAsync(
      `UPDATE conversations
          SET in_sidebar = CASE WHEN local_id IN (SELECT value FROM json_each(?)) THEN 1 ELSE 0 END
        WHERE user_id = ? AND workspace_id = ? AND provisional = 0
          AND local_id NOT IN (SELECT value FROM json_each(?))`,
      JSON.stringify(listedIds),
      ...values(partition),
      JSON.stringify([...preserved]),
    );
  });
};

/** The reader-owned sidebar fields an action changes, and restores if the server refuses it. */
export interface SidebarFields {
  title: string;
  pinnedAt: string | null;
  inSidebar: boolean;
  hasUnseen: boolean;
}

export const writeSidebarFields = async (
  partition: ChatPartition,
  conversationId: string,
  fields: Partial<SidebarFields>,
): Promise<SidebarFields | null> =>
  withChatTransaction(partition, async (database) => {
    const current = await database.getFirstAsync<ConversationRow>(
      "SELECT * FROM conversations WHERE user_id = ? AND workspace_id = ? AND local_id = ?",
      ...values(partition),
      conversationId,
    );
    if (!current) return null;
    const previous: SidebarFields = {
      title: current.title,
      pinnedAt: current.pinned_at,
      inSidebar: Boolean(current.in_sidebar),
      hasUnseen: Boolean(current.has_unseen),
    };
    const next = { ...previous, ...fields };
    await database.runAsync(
      `UPDATE conversations SET title = ?, pinned_at = ?, in_sidebar = ?, has_unseen = ?
        WHERE user_id = ? AND workspace_id = ? AND local_id = ?`,
      next.title,
      next.pinnedAt,
      next.inSidebar ? 1 : 0,
      next.hasUnseen ? 1 : 0,
      ...values(partition),
      conversationId,
    );
    return previous;
  });

export const mergeMessageSnapshots = async (
  partition: ChatPartition,
  conversationId: string,
  messages: MessageDto[],
): Promise<void> => {
  return withChatTransaction(partition, async (database) => {
    for (const message of messages) {
      const parts: ChatPart[] = [
        ...(message.content
          ? ([
              { id: `text:${message.id}:0`, type: "text", text: message.content },
            ] satisfies ChatPart[])
          : []),
        ...message.attachments.map(
          (attachment: AttachmentDto): ChatPart => ({
            id: `attachment:${attachment.id}`,
            type: "attachment",
            attachment,
          }),
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
         WHERE presentation_revision IS NULL AND NOT EXISTS (
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
