import { useRef, useState } from "react";
import { until } from "until-async";
import { throwIfAborted } from "@/shared/lib/abort";
import { analytics, captureError } from "@/shared/lib/analytics";
import { queryClient } from "@/shared/lib/query-client";
import { useToast } from "@/shared/ui/toast";
import type { ChatMessage } from "./chat";
import { chatQueryKeys } from "./chat-queries";
import {
  type ChatPartition,
  NEW_CHAT_ID,
  type PendingMessageCommand,
  type QueuedMessageIdentity,
  queueMessageFromDraft,
  type StoredDraft,
  saveStoredDraft,
} from "./chat-store";

export interface PendingDraftSend {
  message: ChatMessage;
  conversationId: string;
  persisted: Promise<QueuedMessageIdentity>;
}

export function useDraftSend(partition: ChatPartition | null, onQueued: () => void) {
  const { showErrorToast } = useToast();
  const pendingRef = useRef(new Map<string, PendingDraftSend>());
  const [pendingSends, setPendingSends] = useState<Record<string, PendingDraftSend>>({});

  const sendDraft = async (
    draft: StoredDraft,
    onPublished?: () => Promise<void>,
  ): Promise<QueuedMessageIdentity> => {
    if (!partition) throw new Error("Choose a workspace before sending a message.");
    throwIfAborted(partition.signal);
    const sourceId = draft.conversationId;
    if (pendingRef.current.has(sourceId)) throw new Error("This message is already being sent.");
    const identity = {
      conversationId: sourceId === NEW_CHAT_ID ? globalThis.crypto.randomUUID() : sourceId,
      commandId: globalThis.crypto.randomUUID(),
      clientMessageId: globalThis.crypto.randomUUID(),
    };
    const text = draft.text.trim();
    if (!text && !draft.attachments.length) throw new Error("A message or attachment is required.");
    const message: ChatMessage = {
      id: identity.clientMessageId,
      role: "user",
      content: text,
      createdAt: Date.now(),
      delivery: "queued",
      parts: [
        ...(text
          ? [{ id: `text:${identity.clientMessageId}:0`, type: "text" as const, text }]
          : []),
        ...draft.attachments.map((attachment) => ({
          id: `attachment:${attachment.id}`,
          type: "attachment" as const,
          attachment: {
            id: attachment.id,
            filename: attachment.name,
            mediaType: attachment.mimeType ?? "",
            sizeBytes: attachment.size ?? 0,
            kind: attachment.kind === "image" ? ("image" as const) : ("document" as const),
          },
          localUri: attachment.uri,
        })),
      ],
    };
    const draftKey = chatQueryKeys.draft(partition, sourceId);
    void queryClient.cancelQueries({ queryKey: draftKey, exact: true });
    queryClient.setQueryData<StoredDraft>(draftKey, (current) => ({
      ...current,
      ...draft,
      text: "",
      attachments: [],
    }));

    // Publish before waiting for SQLite, keyboard dismissal, or the server. The
    // same IDs enter the durable outbox so acceptance cannot duplicate the bubble.
    const persisted = queueMessageFromDraft(partition, draft, identity);
    const pending = { message, conversationId: identity.conversationId, persisted };
    pendingRef.current.set(sourceId, pending);
    setPendingSends((current) => ({ ...current, [sourceId]: pending }));
    // LegendList queues its scroll for the next data commit. Start it immediately
    // after publishing, in the same send event, rather than from a layout callback.
    const transition = onPublished?.();
    const [error, queued] = await until(() => persisted);

    if (!partition.signal?.aborted) {
      if (error) {
        const currentDraft = queryClient.getQueryData<StoredDraft>(draftKey);
        const restored = {
          ...currentDraft,
          ...draft,
          text: [draft.text, currentDraft?.text].filter(Boolean).join("\n\n"),
          attachments: [...draft.attachments, ...(currentDraft?.attachments ?? [])],
        };
        queryClient.setQueryData(draftKey, restored);
        const [restoreError] = await until(() =>
          saveStoredDraft(partition, sourceId, restored.text, restored.modelId),
        );
        if (restoreError)
          showErrorToast("Your draft could not be saved.", restoreError, "chat.draft.restore");
        captureError("message_send_failed", error, { is_new_chat: sourceId === NEW_CHAT_ID });
      } else {
        const messagesKey = chatQueryKeys.messages(partition, identity.conversationId);
        void queryClient.cancelQueries({ queryKey: messagesKey });
        queryClient.setQueryData<ChatMessage[]>(messagesKey, (current = []) =>
          current.some((item) => item.id === message.id) ? current : [...current, message],
        );
        queryClient.setQueryData<PendingMessageCommand>(
          chatQueryKeys.pendingMessage(partition, identity.conversationId),
          {
            clientMessageId: message.id,
            isStopping: false,
          },
        );
        analytics.capture("message_sent", { is_new_chat: sourceId === NEW_CHAT_ID });
        onQueued();
        // Keep the optimistic bubble mounted until its send animation finishes.
        // Network delivery starts above and does not wait for presentation.
        await transition;
      }
    }
    pendingRef.current.delete(sourceId);
    setPendingSends((current) => {
      const { [sourceId]: _finished, ...remaining } = current;
      return remaining;
    });
    if (error) throw error;
    throwIfAborted(partition.signal);
    return queued;
  };

  return { pendingSends, pendingRef, sendDraft };
}
