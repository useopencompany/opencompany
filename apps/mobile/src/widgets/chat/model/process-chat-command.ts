import {
  CreateMessageBodySchema,
  CreateTaskCommentBodySchema,
} from "@opencompany/protocol/schemas";
import type { AuthenticatedApi } from "@/shared/api/opencompany-api";
import { throwIfAborted } from "@/shared/lib/abort";
import {
  acceptMessageCommand,
  type ChatPartition,
  commandAttachments,
  completeCommand,
  freezeMessageCommand,
  type MessageCommand,
  type OutboxCommand,
  saveUploadedAttachment,
} from "./chat-store";

async function processMessage(
  api: AuthenticatedApi,
  partition: ChatPartition,
  command: MessageCommand,
  signal: AbortSignal,
): Promise<void> {
  if (command.target === "task") return processTaskReply(api, partition, command, signal);
  let body = command.frozenBody;
  // A lost response can hide an accepted message. Replay its exact request before doing any
  // attachment work, even when the original uploads have since expired.
  if (!body) {
    const attachmentIds = await uploadCommandAttachments(api, partition, command, signal);
    body = CreateMessageBodySchema.parse({
      ...(command.intent.isNewConversation
        ? { clientConversationId: command.conversationId }
        : { conversationId: command.conversationId }),
      clientMessageId: command.clientMessageId,
      content: command.intent.content,
      // Intents queued before engines existed carry none and were always Chat.
      engine: command.intent.engine ?? { type: "opencompany", schemaVersion: 1 },
      model: command.intent.model,
      ...(attachmentIds.length ? { attachmentIds } : {}),
    });
    await freezeMessageCommand(partition, command.id, body);
  }
  throwIfAborted(signal);
  const accepted = await api.createMessage(body, command.idempotencyKey, signal);
  await acceptMessageCommand(partition, command, accepted.data);
}

// A Task reply is a comment: the server keeps the Task's engine and model and queues it behind a
// Run that is still working. The comment ID derives from the command, so a retry after a lost
// response replays the same comment instead of posting it twice.
async function processTaskReply(
  api: AuthenticatedApi,
  partition: ChatPartition,
  command: Extract<MessageCommand, { target: "task" }>,
  signal: AbortSignal,
): Promise<void> {
  let body = command.frozenBody;
  if (!body) {
    const attachmentIds = await uploadCommandAttachments(api, partition, command, signal);
    body = CreateTaskCommentBodySchema.parse({
      id: `mobile-comment:${command.id}`,
      body: command.intent.content,
      ...(attachmentIds.length ? { attachmentIds } : {}),
    });
    await freezeMessageCommand(partition, command.id, body);
  }
  throwIfAborted(signal);
  const accepted = await api.createTaskComment(command.intent.taskId, body, signal);
  await acceptMessageCommand(partition, command, {
    conversationId: accepted.data.task.conversationId,
    messageId: accepted.data.messageId,
    assistantMessageId: accepted.data.assistantMessageId,
    runId: accepted.data.runId,
  });
}

async function uploadCommandAttachments(
  api: AuthenticatedApi,
  partition: ChatPartition,
  command: MessageCommand,
  signal: AbortSignal,
): Promise<string[]> {
  const attachments = await commandAttachments(partition, command.id);
  const attachmentIds: string[] = [];
  for (const attachment of attachments) {
    throwIfAborted(signal);
    if (
      attachment.server_attachment_id &&
      attachment.expires_at &&
      Date.parse(attachment.expires_at) > Date.now()
    ) {
      attachmentIds.push(attachment.server_attachment_id);
      continue;
    }
    const generation = attachment.upload_generation + 1;
    const uploaded = await api.uploadAttachment(
      attachment.uri,
      `mobile-attachment:${attachment.local_id}:${generation}`,
      signal,
    );
    await saveUploadedAttachment(
      partition,
      attachment.local_id,
      uploaded.data.attachment.id,
      uploaded.data.expiresAt,
      generation,
    );
    attachmentIds.push(uploaded.data.attachment.id);
  }
  return attachmentIds;
}

export async function processChatCommand(
  api: AuthenticatedApi,
  partition: ChatPartition,
  command: OutboxCommand,
  signal: AbortSignal,
): Promise<void> {
  switch (command.kind) {
    case "message":
      return processMessage(api, partition, command, signal);
    case "stop":
      await api.cancelRun(command.runId, signal);
      break;
    case "approval":
      await api.resolveApproval(command.runId, command.approvalId, command.body, signal);
      break;
  }
  await completeCommand(partition, command.id);
}
