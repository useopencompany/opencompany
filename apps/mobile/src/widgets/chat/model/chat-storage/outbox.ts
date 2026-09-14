import {
  CHAT_ATTACHMENTS_PER_MESSAGE,
  validateChatAttachment,
} from "@opencompany/core/attachments";
import {
  type AttachmentDto,
  type CreateMessageBody,
  CreateMessageBodySchema,
  type ResolveApprovalBody,
  ResolveApprovalBodySchema,
} from "@opencompany/protocol/schemas";
import { z } from "zod";
import type { ChatPart } from "../chat";
import type { ComposerAttachment } from "../chat-composer-context";
import { getChatDatabase, values, withChatTransaction } from "./database";
import { attachmentFromRow } from "./drafts";
import {
  type AttachmentRow,
  type ChatPartition,
  type DraftRow,
  type MessageCommand,
  NEW_CHAT_ID,
  type OutboxCommand,
  type OutboxRow,
} from "./types";

const provisionalTitle = (text: string, attachments: ComposerAttachment[]): string => {
  const normalized = text.trim().replace(/\s+/gu, " ");
  if (normalized) return normalized.slice(0, 60);
  return attachments[0]?.name ?? "New chat";
};

export const queueMessageFromDraft = async (
  partition: ChatPartition,
  sourceConversationId: string,
): Promise<{ conversationId: string; commandId: string; clientMessageId: string }> => {
  return withChatTransaction(partition, async (database) => {
    const result = {
      conversationId:
        sourceConversationId === NEW_CHAT_ID
          ? globalThis.crypto.randomUUID()
          : sourceConversationId,
      commandId: globalThis.crypto.randomUUID(),
      clientMessageId: globalThis.crypto.randomUUID(),
    };

    const existingConversation = await database.getFirstAsync<{ provisional: number }>(
      "SELECT provisional FROM conversations WHERE user_id = ? AND workspace_id = ? AND local_id = ?",
      ...values(partition),
      sourceConversationId,
    );
    const isNewConversation =
      sourceConversationId === NEW_CHAT_ID || Boolean(existingConversation?.provisional);
    const pending = await database.getFirstAsync<{ blocked: number }>(
      `SELECT 1 AS blocked FROM outbox
        WHERE user_id = ? AND workspace_id = ? AND conversation_id = ? AND kind = 'message'
       UNION ALL
       SELECT 1 AS blocked FROM run_checkpoints
        WHERE user_id = ? AND workspace_id = ? AND conversation_id = ?
          AND status IN ('queued', 'running', 'paused')
       LIMIT 1`,
      ...values(partition),
      sourceConversationId,
      ...values(partition),
      sourceConversationId,
    );
    if (pending) throw new Error("Wait for the current response before sending another message.");

    const draft = await database.getFirstAsync<DraftRow>(
      `SELECT conversation_id, text, model_id FROM drafts
        WHERE user_id = ? AND workspace_id = ? AND conversation_id = ?`,
      ...values(partition),
      sourceConversationId,
    );
    const attachments = await database.getAllAsync<AttachmentRow>(
      `SELECT local_id, conversation_id, uri, kind, filename, media_type, size_bytes, width,
              height, upload_generation, server_attachment_id, expires_at
         FROM attachments
        WHERE user_id = ? AND workspace_id = ? AND owner_kind = 'draft' AND owner_id = ?`,
      ...values(partition),
      sourceConversationId,
    );
    if (attachments.length > CHAT_ATTACHMENTS_PER_MESSAGE)
      throw new Error(
        "Remove extra attachments before sending. A message can contain up to five files.",
      );
    for (const attachment of attachments) {
      const validation = validateChatAttachment({
        filename: attachment.filename,
        mediaType: attachment.media_type,
        sizeBytes: attachment.size_bytes,
      });
      if (!validation.ok) throw new Error(validation.message);
    }
    const text = draft?.text.trim() ?? "";
    if (!text && attachments.length === 0) throw new Error("A message or attachment is required.");
    const now = Date.now();
    const timestamp = new Date(now).toISOString();
    await database.runAsync(
      `INSERT INTO conversations (
         user_id, workspace_id, local_id, title, engine, model, runtime_json,
         updated_at, last_viewed_at, provisional
       ) VALUES (?, ?, ?, ?, 'opencompany', ?, NULL, ?, ?, ?)
       ON CONFLICT (user_id, workspace_id, local_id) DO UPDATE SET updated_at = excluded.updated_at`,
      ...values(partition),
      result.conversationId,
      provisionalTitle(text, attachments.map(attachmentFromRow)),
      draft?.model_id ?? "moonshotai/kimi-k3",
      timestamp,
      now,
      isNewConversation ? 1 : 0,
    );
    const localAttachments: AttachmentDto[] = attachments.map((attachment) => ({
      id: attachment.local_id,
      filename: attachment.filename,
      mediaType: attachment.media_type,
      sizeBytes: attachment.size_bytes,
      kind: attachment.kind === "image" ? "image" : "document",
    }));
    const parts: ChatPart[] = [
      ...(text ? ([{ type: "text", text }] satisfies ChatPart[]) : []),
      ...localAttachments.map(
        (attachment, index): ChatPart => ({
          type: "attachment",
          attachment,
          localUri: attachments[index]?.uri,
        }),
      ),
    ];
    await database.runAsync(
      `INSERT INTO messages (
         user_id, workspace_id, local_id, conversation_id, role, content,
         parts_json, delivery, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'user', ?, ?, 'queued', ?, ?)`,
      ...values(partition),
      result.clientMessageId,
      result.conversationId,
      text,
      JSON.stringify(parts),
      now,
      now,
    );
    await database.runAsync(
      `INSERT INTO outbox (
         user_id, workspace_id, id, kind, status, conversation_id, client_message_id,
         intent_json, idempotency_key, created_at
       ) VALUES (?, ?, ?, 'message', 'queued', ?, ?, ?, ?, ?)`,
      ...values(partition),
      result.commandId,
      result.conversationId,
      result.clientMessageId,
      JSON.stringify({
        content: text,
        model: draft?.model_id ?? "moonshotai/kimi-k3",
        isNewConversation,
      }),
      `mobile-message:${result.clientMessageId}`,
      now,
    );
    await database.runAsync(
      `UPDATE attachments SET conversation_id = ?, owner_kind = 'command', owner_id = ?
        WHERE user_id = ? AND workspace_id = ? AND owner_kind = 'draft' AND owner_id = ?`,
      result.conversationId,
      result.commandId,
      ...values(partition),
      sourceConversationId,
    );
    await database.runAsync(
      "DELETE FROM drafts WHERE user_id = ? AND workspace_id = ? AND conversation_id = ?",
      ...values(partition),
      sourceConversationId,
    );
    return result;
  });
};

export const hasPendingMessageCommand = async (
  partition: ChatPartition,
  conversationId: string,
): Promise<boolean> => {
  const database = await getChatDatabase();
  const row = await database.getFirstAsync<{ pending: number }>(
    `SELECT 1 AS pending FROM outbox
      WHERE user_id = ? AND workspace_id = ? AND conversation_id = ? AND kind = 'message'
      LIMIT 1`,
    ...values(partition),
    conversationId,
  );
  return Boolean(row);
};

export const nextOutboxCommand = async (
  partition: ChatPartition,
): Promise<OutboxCommand | null> => {
  const database = await getChatDatabase();
  const row = await database.getFirstAsync<OutboxRow>(
    `SELECT id, kind, status, conversation_id, client_message_id, run_id, approval_id,
            intent_json, frozen_body_json, idempotency_key, attempts, next_attempt_at, created_at
       FROM outbox
      WHERE user_id = ? AND workspace_id = ? AND status = 'queued' AND next_attempt_at <= ?
      ORDER BY CASE kind WHEN 'stop' THEN 0 WHEN 'approval' THEN 1 ELSE 2 END, created_at ASC
      LIMIT 1`,
    ...values(partition),
    Date.now(),
  );
  if (!row) return null;
  const base = {
    id: row.id,
    status: row.status,
    conversationId: row.conversation_id,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
  };
  switch (row.kind) {
    case "message":
      return {
        ...base,
        kind: "message",
        clientMessageId: z.string().min(1).parse(row.client_message_id),
        idempotencyKey: z.string().min(1).parse(row.idempotency_key),
        intent: z
          .object({ content: z.string(), model: z.string(), isNewConversation: z.boolean() })
          .parse(JSON.parse(row.intent_json)),
        frozenBody:
          row.frozen_body_json === null
            ? null
            : CreateMessageBodySchema.parse(JSON.parse(row.frozen_body_json)),
      };
    case "stop":
      return { ...base, kind: "stop", runId: z.string().min(1).parse(row.run_id) };
    case "approval":
      return {
        ...base,
        kind: "approval",
        runId: z.string().min(1).parse(row.run_id),
        approvalId: z.string().min(1).parse(row.approval_id),
        body: ResolveApprovalBodySchema.parse(JSON.parse(row.frozen_body_json ?? row.intent_json)),
      };
  }
};

export const markCommandInFlight = async (
  partition: ChatPartition,
  commandId: string,
): Promise<void> => {
  return withChatTransaction(partition, async (database) => {
    await database.runAsync(
      "UPDATE outbox SET status = 'in_flight' WHERE user_id = ? AND workspace_id = ? AND id = ?",
      ...values(partition),
      commandId,
    );
    await database.runAsync(
      `UPDATE messages SET delivery = 'sending', updated_at = ?
        WHERE user_id = ? AND workspace_id = ? AND local_id =
          (SELECT client_message_id FROM outbox WHERE user_id = ? AND workspace_id = ? AND id = ?)`,
      Date.now(),
      ...values(partition),
      ...values(partition),
      commandId,
    );
  });
};

export const requeueCommand = async (
  partition: ChatPartition,
  commandId: string,
  nextAttemptAt: number,
  error: string,
): Promise<void> => {
  return withChatTransaction(partition, async (database) => {
    await database.runAsync(
      `UPDATE outbox SET status = 'queued', attempts = attempts + 1, next_attempt_at = ?,
       last_error = ? WHERE user_id = ? AND workspace_id = ? AND id = ?`,
      nextAttemptAt,
      error,
      ...values(partition),
      commandId,
    );
  });
};

export const commandAttachments = async (
  partition: ChatPartition,
  commandId: string,
): Promise<AttachmentRow[]> => {
  const database = await getChatDatabase();
  return database.getAllAsync<AttachmentRow>(
    `SELECT local_id, conversation_id, uri, kind, filename, media_type, size_bytes, width,
            height, upload_generation, server_attachment_id, expires_at
       FROM attachments
      WHERE user_id = ? AND workspace_id = ? AND owner_kind = 'command' AND owner_id = ?
      ORDER BY rowid ASC`,
    ...values(partition),
    commandId,
  );
};

export const saveUploadedAttachment = async (
  partition: ChatPartition,
  localId: string,
  serverId: string,
  expiresAt: string,
  generation: number,
): Promise<void> => {
  return withChatTransaction(partition, async (database) => {
    await database.runAsync(
      `UPDATE attachments SET server_attachment_id = ?, expires_at = ?, upload_generation = ?
      WHERE user_id = ? AND workspace_id = ? AND local_id = ?`,
      serverId,
      expiresAt,
      generation,
      ...values(partition),
      localId,
    );
  });
};

export const freezeMessageCommand = async (
  partition: ChatPartition,
  commandId: string,
  body: CreateMessageBody,
): Promise<void> => {
  return withChatTransaction(partition, async (database) => {
    await database.runAsync(
      "UPDATE outbox SET frozen_body_json = ? WHERE user_id = ? AND workspace_id = ? AND id = ? AND frozen_body_json IS NULL",
      JSON.stringify(body),
      ...values(partition),
      commandId,
    );
  });
};

export const acceptMessageCommand = async (
  partition: ChatPartition,
  command: MessageCommand,
  accepted: {
    conversationId: string;
    messageId: string;
    assistantMessageId: string;
    runId: string;
    model?: string;
  },
): Promise<void> => {
  return withChatTransaction(partition, async (database) => {
    if (
      accepted.conversationId !== command.conversationId ||
      accepted.messageId !== command.clientMessageId
    ) {
      throw new Error("The server returned unexpected chat identities.");
    }
    const now = Date.now();
    await database.runAsync(
      `UPDATE conversations SET provisional = 0, model = COALESCE(?, model),
         updated_at = ? WHERE user_id = ? AND workspace_id = ? AND local_id = ?`,
      accepted.model ?? null,
      new Date(now).toISOString(),
      ...values(partition),
      command.conversationId,
    );
    await database.runAsync(
      `UPDATE messages SET delivery = 'accepted', updated_at = ?
        WHERE user_id = ? AND workspace_id = ? AND local_id = ?`,
      now,
      ...values(partition),
      command.clientMessageId,
    );
    await database.runAsync(
      `INSERT INTO messages (
         user_id, workspace_id, local_id, conversation_id, role, content,
         parts_json, delivery, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'assistant', '', '[]', 'accepted', ?, ?)
       ON CONFLICT (user_id, workspace_id, local_id) DO NOTHING`,
      ...values(partition),
      accepted.assistantMessageId,
      command.conversationId,
      now + 1,
      now + 1,
    );
    await database.runAsync(
      `INSERT INTO run_checkpoints (
         user_id, workspace_id, run_id, conversation_id, assistant_message_id, status,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, 'queued', ?)
       ON CONFLICT (user_id, workspace_id, run_id) DO NOTHING`,
      ...values(partition),
      accepted.runId,
      command.conversationId,
      accepted.assistantMessageId,
      now,
    );
    await database.runAsync(
      "DELETE FROM outbox WHERE user_id = ? AND workspace_id = ? AND id = ?",
      ...values(partition),
      command.id,
    );
  });
};

export const failMessageCommand = async (
  partition: ChatPartition,
  command: MessageCommand,
): Promise<void> => {
  return withChatTransaction(partition, async (database) => {
    const currentDraft = await database.getFirstAsync<DraftRow>(
      "SELECT conversation_id, text, model_id FROM drafts WHERE user_id = ? AND workspace_id = ? AND conversation_id = ?",
      ...values(partition),
      command.conversationId,
    );
    const text = command.intent.content;
    const restoredText = [currentDraft?.text.trim(), text.trim()].filter(Boolean).join("\n\n");
    await database.runAsync(
      `INSERT INTO drafts (user_id, workspace_id, conversation_id, text, model_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, workspace_id, conversation_id) DO UPDATE SET
         text = excluded.text, model_id = drafts.model_id, updated_at = excluded.updated_at`,
      ...values(partition),
      command.conversationId,
      restoredText,
      currentDraft?.model_id ?? command.intent.model,
      Date.now(),
    );
    await database.runAsync(
      `UPDATE attachments SET owner_kind = 'draft', owner_id = ?, server_attachment_id = NULL,
         expires_at = NULL WHERE user_id = ? AND workspace_id = ? AND owner_kind = 'command' AND owner_id = ?`,
      command.conversationId,
      ...values(partition),
      command.id,
    );
    await database.runAsync(
      "DELETE FROM messages WHERE user_id = ? AND workspace_id = ? AND local_id = ?",
      ...values(partition),
      command.clientMessageId,
    );
    await database.runAsync(
      "DELETE FROM outbox WHERE user_id = ? AND workspace_id = ? AND id = ?",
      ...values(partition),
      command.id,
    );
  });
};

export const queueStopCommand = async (
  partition: ChatPartition,
  conversationId: string,
  runId: string,
): Promise<void> => {
  return withChatTransaction(partition, async (database) => {
    await database.runAsync(
      `INSERT OR IGNORE INTO outbox (
         user_id, workspace_id, id, kind, status, conversation_id, run_id, intent_json, created_at
       ) VALUES (?, ?, ?, 'stop', 'queued', ?, ?, '{}', ?)`,
      ...values(partition),
      `stop:${runId}`,
      conversationId,
      runId,
      Date.now(),
    );
  });
};

export const queueApprovalCommand = async (
  partition: ChatPartition,
  conversationId: string,
  runId: string,
  approvalId: string,
  body: ResolveApprovalBody,
): Promise<void> => {
  return withChatTransaction(partition, async (database) => {
    await database.runAsync(
      `INSERT OR REPLACE INTO outbox (
         user_id, workspace_id, id, kind, status, conversation_id, run_id, approval_id,
         intent_json, frozen_body_json, created_at
       ) VALUES (?, ?, ?, 'approval', 'queued', ?, ?, ?, ?, ?, ?)`,
      ...values(partition),
      `approval:${approvalId}`,
      conversationId,
      runId,
      approvalId,
      JSON.stringify(body),
      JSON.stringify(body),
      Date.now(),
    );
  });
};

export const completeCommand = async (
  partition: ChatPartition,
  commandId: string,
): Promise<void> => {
  return withChatTransaction(partition, async (database) => {
    await database.runAsync(
      "DELETE FROM outbox WHERE user_id = ? AND workspace_id = ? AND id = ?",
      ...values(partition),
      commandId,
    );
  });
};

export const recoverOutbox = async (partition: ChatPartition): Promise<void> => {
  return withChatTransaction(partition, async (database) => {
    await database.runAsync(
      "UPDATE outbox SET status = 'queued' WHERE user_id = ? AND workspace_id = ? AND status = 'in_flight'",
      ...values(partition),
    );
  });
};

export async function nextOutboxWakeAt(partition: ChatPartition): Promise<number | null> {
  const database = await getChatDatabase();
  const row = await database.getFirstAsync<{ wake_at: number | null }>(
    "SELECT MIN(next_attempt_at) AS wake_at FROM outbox WHERE user_id = ? AND workspace_id = ? AND status = 'queued'",
    ...values(partition),
  );
  return row?.wake_at ?? null;
}
