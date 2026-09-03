"use client";

import {
  CLOUD_CODING_ENGINE_CONFIG,
  isCloudCodingEngine,
  type PublishedChatArtifact,
} from "@opencompany/agent-runtime";
import { Link2 } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { buildChatTaskLookup } from "@/components/chat/assistant-items";
import { MessageBubble } from "@/components/chat/MessageBubble";
import type { PublicChatView } from "@/lib/chat-sharing";
import type { ChatUiAttachment } from "@/lib/chat-ui";

export function SharedChatView({ chat }: { chat: PublicChatView }) {
  const shareSubject = sharedChatSubject(chat);
  const taskLookup = useMemo(
    () => buildChatTaskLookup({ messages: chat.messages, tasks: [], liveTasks: null }),
    [chat.messages],
  );

  const attachmentSrc = (messageId: string, attachment: ChatUiAttachment) =>
    attachment.kind === "image"
      ? `/share/${encodeURIComponent(chat.shareId)}/attachments/${encodeURIComponent(
          messageId,
        )}/${encodeURIComponent(attachment.id)}`
      : undefined;
  const artifactHref = (artifact: PublishedChatArtifact) =>
    `/share/${encodeURIComponent(chat.shareId)}/artifacts/${encodeURIComponent(
      artifact.artifactId,
    )}/versions/${encodeURIComponent(artifact.artifactVersionId)}`;

  return (
    <main className="h-dvh w-full overflow-y-auto bg-canvas text-ink">
      <header className="border-b border-border bg-canvas/95 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-[768px] items-center justify-between gap-4 px-6">
          <Link
            href="/"
            className="text-[13px] font-semibold tracking-[-0.01em] text-ink transition-opacity hover:opacity-70 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            opencompany
          </Link>
          <div className="flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-[11.5px] font-medium text-ink-muted shadow-[0_1px_2px_rgba(15,15,15,0.03)]">
            <Link2 size={12} strokeWidth={1.9} aria-hidden="true" />
            <span>Shared {shareSubject} · Read only</span>
          </div>
        </div>
      </header>

      <article className="mx-auto w-full max-w-[768px] px-6 pb-20 pt-10">
        <h1 className="mb-10 text-balance text-[22px] font-semibold leading-8 tracking-[-0.02em] text-ink">
          {chat.title}
        </h1>
        <div className="flex flex-col gap-3">
          {chat.messages.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              taskLookup={taskLookup}
              readOnly
              isTaskSession={chat.kind === "task"}
              compactTrace={isCloudCodingEngine(chat.engine)}
              attachmentSrc={attachmentSrc}
              artifactHref={artifactHref}
            />
          ))}
        </div>
      </article>
    </main>
  );
}

function sharedChatSubject(chat: { kind: string; engine?: string | null | undefined }) {
  if (chat.kind === "task") return "task run";
  if (isCloudCodingEngine(chat.engine))
    return `${CLOUD_CODING_ENGINE_CONFIG[chat.engine].label} chat`;
  return "chat";
}
