"use client";

import { Markdown } from "@/components/Markdown";

export function AssistantTextBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[80%] text-[13px] leading-5 text-ink">
        <Markdown content={text} />
      </div>
    </div>
  );
}
