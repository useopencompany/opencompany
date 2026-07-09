"use client";

import { Markdown } from "@/components/Markdown";

export function AssistantTextBubble({ text, error }: { text: string; error?: string | undefined }) {
  return (
    <div className="flex justify-start">
      <div
        className={`max-w-[80%] text-[13px] leading-5 ${
          error ? "rounded-2xl rounded-bl-md bg-danger-bg px-3 py-2 text-danger" : "text-ink"
        }`}
      >
        <Markdown content={text} />
      </div>
    </div>
  );
}
