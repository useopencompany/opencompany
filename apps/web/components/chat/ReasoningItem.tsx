"use client";

import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { Markdown } from "@/components/Markdown";
import {
  type HistoricalPresentationDetailController,
  HistoricalPresentationDetailStatus,
  useHistoricalPresentationDetail,
} from "./HistoricalPresentationDetail";

export function ReasoningItem({
  text,
  detail,
}: {
  text: string;
  detail?: HistoricalPresentationDetailController;
}) {
  const [expanded, setExpanded] = useState(false);
  useHistoricalPresentationDetail(expanded, detail);
  const compactText = text.replace(/\s+/g, " ").trim();
  const preview =
    compactText.length > 160 ? `${compactText.slice(0, 157).trimEnd()}...` : compactText;
  return (
    <div
      data-testid="chat-reasoning-item"
      className="-ml-1 max-w-[92%] text-[11.5px] leading-5 text-ink-muted"
    >
      <div className="flex min-w-0 max-w-full items-center gap-1">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => {
            const next = !expanded;
            setExpanded(next);
            if (next && detail?.state !== "loaded") void detail?.load();
          }}
          className="flex min-w-0 items-center gap-1.5 rounded-md px-1 py-px text-left transition-colors hover:bg-surface-hover/65 hover:text-ink/75 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        >
          <ChevronRight
            size={11}
            strokeWidth={1.9}
            className={`shrink-0 text-ink-subtle transition-transform ${expanded ? "rotate-90" : ""}`}
          />
          <span className="shrink-0 font-medium text-ink/65">Thinking</span>
          <span title={preview} className="min-w-0 truncate text-ink/45">
            {preview}
          </span>
        </button>
      </div>
      {expanded ? (
        <div className="ml-6 mt-1 border-l border-border pl-3 text-[12px] leading-5 text-ink-muted">
          {detail && detail.state !== "loaded" ? (
            <>
              <Markdown content={text} />
              <HistoricalPresentationDetailStatus detail={detail} />
            </>
          ) : (
            <Markdown content={text} />
          )}
        </div>
      ) : null}
    </div>
  );
}
