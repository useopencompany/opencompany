import {
  CHAT_ATTACHMENTS_PER_MESSAGE,
  validateChatAttachment,
} from "@opencompany/core/attachments";
import {
  type AttachmentDto,
  type CreateMessageBody,
  CreateMessageBodySchema,
  type CreateTaskCommentBody,
  CreateTaskCommentBodySchema,
  type MessageEngine,
  MessageEngineSchema,
  type MessageMention,
  MessageMentionSchema,
  type ResolveApprovalBody,
  ResolveApprovalBodySchema,
} from "@opencompany/protocol/schemas";
import { z } from "zod";
import type { ChatPart } from "../chat";
import type { ComposerAttachment } from "../chat-composer-context";
import {
  messageEngineForSelection,
  selectedModelId,
  selectionFromQueuedIntent,
} from "../composer-selection";
import { type ComposerMention, parseStoredMentions } from "../quick-actions/composer-segments";
import { getChatDatabase, values, withChatTransaction } from "./database";
import { attachmentFromRow } from "./drafts";
import { ACTIVE_RUN_ORDER } from "./runs";
import {
  type AttachmentRow,
  type ChatPartition,
  type DraftRow,
  type MessageCommand,
  NEW_CHAT_ID,
  type OutboxCommand,
  type OutboxRow,
  type OutgoingDraft,
} from "./types";

const provisionalTitle = (text: string, attachments: ComposerAttachment[]): string => {
  const normalized = text.trim().replace(/\s+/gu, " ");
  if (normalized) return normalized.slice(0, 60);
  return attachments[0]?.name ?? "New chat";
};

export interface QueuedMessageIdentity {
  conversationId: string;
  commandId: string;
  clientMessageId: string;
}

// The settings a conversation reports back as composerSettings, kept locally so reopening the
// conversation shows what was last sent before the next server snapshot arrives.
const composerSettingsForEngine = (engine: MessageEngine): string | null =>
  engine.type === "opencompany" ? null : JSON.stringify(engine.settings);

export const queueMessageFromDraft = async (
  partition: ChatPartition,
  draft: OutgoingDraft,
  result: QueuedMessageIdentity,
): Promise<QueuedMessageIdentity> => {
  const sourceConversationId = draft.conversationId;
  return withChatTransaction(partition, async (database) => {
    const existingConversation = await database.getFirstAsync<{
      provisional: number;
      task_id: string | null;
      engine: MessageEngine["type"];
      model: string;
    }>(
      "SELECT provisional, task_id, engine, model FROM conversations WHERE user_id = ? AND workspace_id = ? AND local_id = ?",
      ...values(partition),
      sourceConversationId,
    );
    const isNewConversation =
      sourceConversationId === NEW_CHAT_ID || Boolean(existingConversation?.provisional);
    // A Task takes replies while it works: each becomes a Run queued behind the active one.
    const taskId = existingConversation?.task_id ?? null;
    // Freeze the engine, model, and settings now: later picker changes edit the draft, never this
    // request. A Task reply goes through its comment endpoint and carries none of them.
    const selected = taskId ? null : messageEngineForSelection(draft.selection);
    if (selected && !selected.ok) throw new Error(selected.error);
    const engine = selected?.engine ?? null;
    // An accepted conversation keeps the engine and model it started with, as on the web.
    if (
      engine &&
      !isNewConversation &&
      existingConversation &&
      existingConversation.engine !== engine.type
    )
      throw new Error("This conversation uses a different engine.");
    const model =
      isNewConversation || !existingConversation
        ? selectedModelId(draft.selection)
        : existingConversation.model;
    const pending = taskId
      ? null
      : await database.getFirstAsync<{ blocked: number }>(
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
    const text = draft.text.trim();
    if (!text && attachments.length === 0) throw new Error("A message or attachment is required.");
    // Only skills travel as message mentions. Workflow and Task tags start a Task instead, and a
    // Task reply goes through its comment endpoint, which takes no mentions.
    const mentions: MessageMention[] = taskId
      ? []
      : draft.mentions.flatMap((mention) =>
          mention.kind === "skill" ? [{ kind: "skill", id: mention.id, name: mention.name }] : [],
        );
    const now = Date.now();
    const timestamp = new Date(now).toISOString();
    // A provisional conversation was never accepted, so a resend may still change its engine.
    await database.runAsync(
      `INSERT INTO conversations (
         user_id, workspace_id, local_id, title, engine, model, composer_settings_json,
         runtime_json, updated_at, last_viewed_at, provisional
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
       ON CONFLICT (user_id, workspace_id, local_id) DO UPDATE SET
         updated_at = excluded.updated_at,
         engine = CASE WHEN conversations.provisional THEN excluded.engine ELSE conversations.engine END,
         model = CASE WHEN conversations.provisional THEN excluded.model ELSE conversations.model END,
         composer_settings_json = CASE WHEN conversations.task_id IS NULL
           THEN excluded.composer_settings_json ELSE conversations.composer_settings_json END`,
      ...values(partition),
      result.conversationId,
      provisionalTitle(text, attachments.map(attachmentFromRow)),
      engine?.type ?? existingConversation?.engine ?? "opencompany",
      model,
      engine ? composerSettingsForEngine(engine) : null,
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
      ...(text
        ? ([{ id: `text:${result.clientMessageId}:0`, type: "text", text }] satisfies ChatPart[])
        : []),
      ...localAttachments.map(
        (attachment, index): ChatPart => ({
          id: `attachment:${attachment.id}`,
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
      JSON.stringify(
        taskId
          ? { content: text, taskId }
          : {
              content: text,
              model,
              isNewConversation,
              engine,
              ...(mentions.length > 0 ? { mentions } : {}),
            },
      ),
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
    // The next new chat opens on the same engine and model, so its draft keeps the selection. An
    // existing conversation reads its settings back from the conversation row instead.
    await database.runAsync(
      sourceConversationId === NEW_CHAT_ID
        ? "UPDATE drafts SET text = '', mentions_json = NULL WHERE user_id = ? AND workspace_id = ? AND conversation_id = ?"
        : "DELETE FROM drafts WHERE user_id = ? AND workspace_id = ? AND conversation_id = ?",
      ...values(partition),
      sourceConversationId,
    );
    return result;
  });
};

export interface PendingMessageCommand {
  clientMessageId: string;
  isStopping: boolean;
}

export const getPendingMessageCommand = async (
  partition: ChatPartition,
  conversationId: string,
): Promise<PendingMessageCommand | null> => {
  const database = await getChatDatabase();
  const row = await database.getFirstAsync<{ client_message_id: string; is_stopping: number }>(
    `SELECT m.client_message_id, EXISTS (
       SELECT 1 FROM outbox s WHERE s.user_id = m.user_id AND s.workspace_id = m.workspace_id
         AND s.kind = 'stop' AND s.client_message_id = m.client_message_id
     ) AS is_stopping FROM outbox m
      WHERE m.user_id = ? AND m.workspace_id = ? AND m.conversation_id = ? AND m.kind = 'message'
      LIMIT 1`,
    ...values(partition),
    conversationId,
  );
  return row
    ? { clientMessageId: row.client_message_id, isStopping: Boolean(row.is_stopping) }
    : null;
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
        AND (kind != 'stop' OR run_id IS NOT NULL)
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
      return parseMessageCommand(row, base);
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

const TaskIntentSchema = z.object({ content: z.string(), taskId: z.string().min(1) });
const ChatIntentSchema = z.object({
  content: z.string(),
  model: z.string(),
  isNewConversation: z.boolean(),
  engine: MessageEngineSchema.optional(),
  mentions: z.array(MessageMentionSchema).optional(),
});

const parseMessageCommand = (
  row: OutboxRow,
  base: Omit<
    MessageCommand,
    "kind" | "clientMessageId" | "idempotencyKey" | "target" | "intent" | "frozenBody"
  >,
): MessageCommand => {
  const identity = {
    ...base,
    kind: "message" as const,
    clientMessageId: z.string().min(1).parse(row.client_message_id),
    idempotencyKey: z.string().min(1).parse(row.idempotency_key),
  };
  const intent: unknown = JSON.parse(row.intent_json);
  const frozen: unknown = row.frozen_body_json === null ? null : JSON.parse(row.frozen_body_json);
  const task = TaskIntentSchema.safeParse(intent);
  if (task.success) {
    return {
      ...identity,
      target: "task",
      intent: task.data,
      frozenBody: frozen === null ? null : CreateTaskCommentBodySchema.parse(frozen),
    };
  }
  return {
    ...identity,
    target: "chat",
    intent: ChatIntentSchema.parse(intent),
    frozenBody: frozen === null ? null : CreateMessageBodySchema.parse(frozen),
  };
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
  body: CreateMessageBody | CreateTaskCommentBody,
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
      (command.target === "chat" && accepted.messageId !== command.clientMessageId)
    ) {
      throw new Error("The server returned unexpected chat identities.");
    }
    const now = Date.now();
    // The Task comment endpoint allocates the Message ID itself. Adopt it so the transcript
    // snapshot that follows updates this bubble instead of adding a second copy.
    if (accepted.messageId !== command.clientMessageId) {
      await database.runAsync(
        `UPDATE messages SET local_id = ? WHERE user_id = ? AND workspace_id = ? AND local_id = ?`,
        accepted.messageId,
        ...values(partition),
        command.clientMessageId,
      );
    }
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
      accepted.messageId,
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
      `UPDATE outbox SET run_id = ? WHERE user_id = ? AND workspace_id = ?
        AND kind = 'stop' AND client_message_id = ?`,
      accepted.runId,
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

/** Keeps every mention once, so a restored draft brings back the tags of both texts it joins. */
export const mergeMentions = (
  current: ComposerMention[],
  restored: ComposerMention[],
): ComposerMention[] => [
  ...current,
  ...restored.filter(
    (mention) =>
      !current.some((existing) => existing.kind === mention.kind && existing.id === mention.id),
  ),
];

export const failMessageCommand = async (
  partition: ChatPartition,
  command: MessageCommand,
): Promise<void> => {
  return withChatTransaction(partition, async (database) => {
    const currentDraft = await database.getFirstAsync<DraftRow>(
      "SELECT conversation_id, text, model_id, selection_json, mentions_json FROM drafts WHERE user_id = ? AND workspace_id = ? AND conversation_id = ?",
      ...values(partition),
      command.conversationId,
    );
    const text = command.intent.content;
    const restoredText = [currentDraft?.text.trim(), text.trim()].filter(Boolean).join("\n\n");
    const restoredMentions = mergeMentions(
      parseStoredMentions(currentDraft?.mentions_json ?? null),
      command.target === "chat"
        ? (command.intent.mentions ?? []).map((mention) => ({
            kind: "skill" as const,
            id: mention.id,
            name: mention.name ?? mention.id,
          }))
        : [],
    );
    // Restore the rejected request's engine and settings unless the user has chosen again since.
    // A Task reply carries none, so its draft keeps whatever it had.
    const restoredSelection =
      currentDraft?.selection_json ??
      (command.target === "chat"
        ? selectionFromQueuedIntent(
            command.intent.engine ?? { type: "opencompany", schemaVersion: 1 },
            command.intent.model,
          )
        : null);
    await database.runAsync(
      `INSERT INTO drafts (
         user_id, workspace_id, conversation_id, text, model_id, selection_json, mentions_json,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, workspace_id, conversation_id) DO UPDATE SET
         text = excluded.text, model_id = drafts.model_id,
         selection_json = drafts.selection_json, mentions_json = excluded.mentions_json,
         updated_at = excluded.updated_at`,
      ...values(partition),
      command.conversationId,
      restoredText,
      currentDraft?.model_id ?? (command.target === "chat" ? command.intent.model : ""),
      restoredSelection,
      restoredMentions.length > 0 ? JSON.stringify(restoredMentions) : null,
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
      "DELETE FROM outbox WHERE user_id = ? AND workspace_id = ? AND kind = 'stop' AND client_message_id = ?",
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
): Promise<void> => {
  return withChatTransaction(partition, async (database) => {
    // Keep a stop durable even before createMessage returns the server's run ID.
    // Acceptance resolves it in the same transaction that removes the message command.
    // Stop always means the Run that is working now. A Task reply queued behind it is left alone.
    const activeRun = await database.getFirstAsync<{ run_id: string }>(
      `SELECT run_id FROM run_checkpoints
        WHERE user_id = ? AND workspace_id = ? AND conversation_id = ?
          AND status IN ('queued', 'running', 'paused')
        ORDER BY ${ACTIVE_RUN_ORDER} LIMIT 1`,
      ...values(partition),
      conversationId,
    );
    const pending = activeRun
      ? null
      : await database.getFirstAsync<{ client_message_id: string }>(
          "SELECT client_message_id FROM outbox WHERE user_id = ? AND workspace_id = ? AND conversation_id = ? AND kind = 'message' ORDER BY created_at ASC LIMIT 1",
          ...values(partition),
          conversationId,
        );
    const run = activeRun;
    if (!pending && !run) return;
    await database.runAsync(
      `INSERT OR IGNORE INTO outbox (
         user_id, workspace_id, id, kind, status, conversation_id, run_id, client_message_id, intent_json, created_at
       ) VALUES (?, ?, ?, 'stop', 'queued', ?, ?, ?, '{}', ?)`,
      ...values(partition),
      pending ? `stop-message:${pending.client_message_id}` : `stop:${run!.run_id}`,
      conversationId,
      run?.run_id ?? null,
      pending?.client_message_id ?? null,
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
    "SELECT MIN(next_attempt_at) AS wake_at FROM outbox WHERE user_id = ? AND workspace_id = ? AND status = 'queued' AND (kind != 'stop' OR run_id IS NOT NULL)",
    ...values(partition),
  );
  return row?.wake_at ?? null;
}
