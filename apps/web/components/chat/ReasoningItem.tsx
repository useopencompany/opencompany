"use client";

import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { Markdown } from "@/components/Markdown";

export function ReasoningItem({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      data-testid="chat-reasoning-item"
      className="-ml-1 max-w-[92%] text-[11.5px] leading-5 text-ink-muted"
    >
      <div className="flex min-w-0 max-w-full items-center gap-1">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
          className="flex min-w-0 items-center gap-1.5 rounded-md px-1 py-px text-left transition-colors hover:bg-surface-hover/65 hover:text-ink/75 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        >
          <ChevronRight
            size={11}
            strokeWidth={1.9}
            className={`shrink-0 text-ink-subtle transition-transform ${expanded ? "rotate-90" : ""}`}
          />
          <span className="shrink-0 font-medium text-ink/65">Thought</span>
        </button>
      </div>
      {expanded ? (
        <div className="ml-6 mt-1 border-l border-border pl-3 text-[12px] leading-5 text-ink-muted">
          <Markdown content={text} />
        </div>
      ) : null}
    </div>
  );
}
