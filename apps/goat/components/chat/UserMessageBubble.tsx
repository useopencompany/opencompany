"use client";

import { GoatChatAttachmentCard } from "@/components/chat/ChatComposerAttachments";
import {
  type GoatChatUiAttachment,
  type GoatChatUiMessage,
  textFromGoatChatUiMessage,
} from "@/lib/chat-ui";

export function UserMessageBubble({ message }: { message: GoatChatUiMessage }) {
  const text = textFromGoatChatUiMessage(message);
  const attachments = message.metadata?.attachments ?? [];

  return (
    <div className="flex flex-col items-end gap-1.5">
      {attachments.length > 0 ? (
        <div className="flex max-w-[80%] flex-wrap justify-end gap-2">
          {attachments.map((attachment) => (
            <GoatChatAttachmentCard
              key={attachment.id}
              kind={attachment.kind}
              filename={attachment.filename}
              src={attachmentThumbnailSrc(message.id, attachment)}
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
