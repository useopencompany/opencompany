"use client";

import { type GoatChatUiMessage, textFromGoatChatUiMessage } from "@/lib/chat-ui";

export function UserMessageBubble({ message }: { message: GoatChatUiMessage }) {
  const text = textFromGoatChatUiMessage(message);

  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-2xl px-3 py-2 text-[13px] leading-5 rounded-br-md bg-ink text-canvas">
        {text}
      </div>
    </div>
  );
}
