import { CreateMessageBodySchema } from "@opencompany/protocol/schemas";
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
  let body = command.frozenBody;
  // A lost response can hide an accepted message. Replay its exact request before doing any
  // attachment work, even when the original uploads have since expired.
  if (!body) {
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
    body = CreateMessageBodySchema.parse({
      ...(command.intent.isNewConversation
        ? { clientConversationId: command.conversationId }
        : { conversationId: command.conversationId }),
      clientMessageId: command.clientMessageId,
      content: command.intent.content,
      engine: { type: "opencompany", schemaVersion: 1 },
      model: command.intent.model,
      ...(attachmentIds.length ? { attachmentIds } : {}),
    });
    await freezeMessageCommand(partition, command.id, body);
  }
  throwIfAborted(signal);
  const accepted = await api.createMessage(body, command.idempotencyKey, signal);
  await acceptMessageCommand(partition, command, accepted.data);
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
