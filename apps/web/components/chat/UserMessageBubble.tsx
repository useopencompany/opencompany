"use client";

import { GoatChatAttachmentCard } from "@/components/chat/ChatComposerAttachments";
import {
  type GoatChatUiAttachment,
  type GoatChatUiMessage,
  textFromGoatChatUiMessage,
} from "@/lib/chat-ui";

export function UserMessageBubble({
  message,
  attachmentSrc,
}: {
  message: GoatChatUiMessage;
  attachmentSrc?: (messageId: string, attachment: GoatChatUiAttachment) => string | undefined;
}) {
  const text = textFromGoatChatUiMessage(message);
  const attachments = message.metadata?.attachments ?? [];
  const scheduledWakeup = message.metadata?.scheduledWakeup;

  if (scheduledWakeup) {
    return (
      <div
        className="flex w-full items-center justify-center py-1 text-center text-[12px] font-medium leading-5 text-ink-muted"
        data-testid="scheduled-wakeup"
      >
        <span>⏱ Scheduled check-in · {scheduledWakeup.reason}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      {attachments.length > 0 ? (
        <div className="flex max-w-[80%] flex-wrap justify-end gap-2">
          {attachments.map((attachment) => (
            <GoatChatAttachmentCard
              key={attachment.id}
              kind={attachment.kind}
              filename={attachment.filename}
              src={
                attachmentSrc
                  ? attachmentSrc(message.id, attachment)
                  : attachmentThumbnailSrc(message.id, attachment)
              }
            />
          ))}
        </div>
      ) : null}
      {text ? (
        <div className="max-w-[80%] rounded-2xl px-3 py-2 text-[13px] leading-5 rounded-br-md bg-ink text-canvas">
          {text}
        </div>
      ) : null}
    </div>
  );
}

// Optimistic (not-yet-persisted) messages carry a local object URL preview;
// persisted rows are fetched through the auth-scoped serving route.
function attachmentThumbnailSrc(
  messageId: string,
  attachment: GoatChatUiAttachment,
): string | undefined {
  if (attachment.kind !== "image") return undefined;
  if (attachment.previewUrl) return attachment.previewUrl;
  return `/api/chat-attachments/${encodeURIComponent(messageId)}/${encodeURIComponent(attachment.id)}`;
}
