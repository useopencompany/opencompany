"use client";

import { ContextReferenceChip } from "@/components/ContextReference";
import { ChatAttachmentCard } from "@/components/chat/ChatComposerAttachments";
import {
  type ChatMention,
  type ChatUiAttachment,
  type ChatUiMessage,
  textFromChatUiMessage,
} from "@/lib/chat-ui";
import { contextReferenceRanges } from "@/lib/context-references";

export function UserMessageBubble({
  message,
  attachmentSrc,
}: {
  message: ChatUiMessage;
  attachmentSrc?: (messageId: string, attachment: ChatUiAttachment) => string | undefined;
}) {
  const text = textFromChatUiMessage(message);
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
            <ChatAttachmentCard
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
        <div className="whitespace-pre-wrap max-w-[80%] rounded-2xl px-3 py-2 text-[13px] leading-5 rounded-br-md bg-ink text-canvas">
          <UserMessageText text={text} mentions={message.metadata?.mentions ?? []} />
        </div>
      ) : null}
    </div>
  );
}

type UserMessageTextRange =
  | {
      kind: "reference";
      start: number;
      end: number;
      reference: ReturnType<typeof contextReferenceRanges>[number];
    }
  | { kind: "skill"; start: number; end: number };

function UserMessageText({ text, mentions }: { text: string; mentions: readonly ChatMention[] }) {
  const candidates: UserMessageTextRange[] = [
    ...contextReferenceRanges(text).map((reference) => ({
      kind: "reference" as const,
      start: reference.start,
      end: reference.end,
      reference,
    })),
    ...skillMentionRanges(text, mentions),
  ].toSorted(
    (left, right) =>
      left.start - right.start ||
      (left.kind === right.kind ? 0 : left.kind === "reference" ? -1 : 1) ||
      right.end - left.end,
  );
  const ranges: UserMessageTextRange[] = [];
  for (const candidate of candidates) {
    const previous = ranges.at(-1);
    if (previous && candidate.start < previous.end) continue;
    ranges.push(candidate);
  }

  const parts = ranges.flatMap((range, index) => {
    const before = text.slice(ranges[index - 1]?.end ?? 0, range.start);
    const highlighted =
      range.kind === "reference" ? (
        <ContextReferenceChip key={`reference:${range.start}`} reference={range.reference} />
      ) : (
        <span
          key={`skill:${range.start}`}
          className="rounded-sm bg-canvas/20 px-1 font-medium text-canvas"
          data-opencompany-chat-mention="skill"
        >
          {text.slice(range.start, range.end)}
        </span>
      );
    return [before, highlighted];
  });

  return (
    <>
      {parts}
      {text.slice(ranges.at(-1)?.end ?? 0)}
    </>
  );
}

function skillMentionRanges(text: string, mentions: readonly ChatMention[]) {
  return mentions
    .filter(
      (mention): mention is Extract<ChatMention, { kind: "skill" }> => mention.kind === "skill",
    )
    .flatMap((mention) => {
      const token = escapeRegExp(`/${mention.name ?? mention.id}`);
      const pattern = new RegExp(`(^|\\s)${token}(?=\\s|$)`, "gi");
      return [...text.matchAll(pattern)].flatMap((match) => {
        if (typeof match.index !== "number") return [];
        const leading = match[1] ?? "";
        const start = match.index + leading.length;
        return [{ kind: "skill" as const, start, end: start + match[0].length - leading.length }];
      });
    });
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Optimistic (not-yet-persisted) messages carry a local object URL preview;
// persisted rows are fetched through the auth-scoped serving route.
function attachmentThumbnailSrc(
  messageId: string,
  attachment: ChatUiAttachment,
): string | undefined {
  if (attachment.kind !== "image") return undefined;
  if (attachment.previewUrl) return attachment.previewUrl;
  return `/v1/chat-attachments/${encodeURIComponent(messageId)}/${encodeURIComponent(attachment.id)}`;
}
