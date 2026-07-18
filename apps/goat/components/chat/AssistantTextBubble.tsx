"use client";

import { Popover, PopoverContent, PopoverTrigger } from "@opencompany/ui/components/popover";
import { cn } from "@opencompany/ui/lib/utils";
import { BookOpen, ExternalLink } from "lucide-react";
import Link from "next/link";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Markdown } from "@/components/Markdown";
import type { BrainCitation } from "./assistant-items";

export function AssistantTextBubble({
  text,
  citations = [],
  error,
}: {
  text: string;
  citations?: BrainCitation[];
  error?: string | undefined;
}) {
  return (
    <div className="flex justify-start">
      <div
        className={`max-w-[80%] text-[13px] leading-5 ${
          error ? "rounded-2xl rounded-bl-md bg-danger-bg px-3 py-2 text-danger" : "text-ink"
        }`}
      >
        <Markdown content={text} />
        {citations.length > 0 ? <BrainCitationChips citations={citations} /> : null}
      </div>
    </div>
  );
}

function BrainCitationChips({ citations }: { citations: BrainCitation[] }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);
  const [visibleCount, setVisibleCount] = useState(citations.length);
  const citationLayoutKey = citations
    .map((citation) => `${citation.key}\u0000${citation.label}`)
    .join("\u0001");

  const updateVisibleCount = useCallback(() => {
    const container = containerRef.current;
    const measure = measureRef.current;
    if (!container || !measure) return;

    const availableWidth = container.getBoundingClientRect().width;
    if (availableWidth <= 0) return;

    const chipWidths = Array.from(
      measure.querySelectorAll<HTMLElement>("[data-citation-measure='chip']"),
      (node) => node.getBoundingClientRect().width,
    );
    const overflowWidths: Record<number, number> = {};
    for (const node of measure.querySelectorAll<HTMLElement>("[data-overflow-count]")) {
      const count = Number(node.dataset.overflowCount);
      if (Number.isFinite(count)) overflowWidths[count] = node.getBoundingClientRect().width;
    }
    const styles = window.getComputedStyle(measure);
    const gap = Number.parseFloat(styles.columnGap || styles.gap || "0") || 0;
    const nextVisibleCount = getVisibleBrainCitationCount({
      availableWidth,
      chipWidths,
      overflowWidths,
      gap,
    });

    setVisibleCount((current) => (current === nextVisibleCount ? current : nextVisibleCount));
  }, []);

  useLayoutEffect(() => {
    const animationFrame = window.requestAnimationFrame(updateVisibleCount);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [citationLayoutKey, updateVisibleCount]);

  useLayoutEffect(() => {
    let animationFrame = window.requestAnimationFrame(updateVisibleCount);
    const scheduleUpdate = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(updateVisibleCount);
    };

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", scheduleUpdate);
      return () => {
        window.cancelAnimationFrame(animationFrame);
        window.removeEventListener("resize", scheduleUpdate);
      };
    }

    const observer = new ResizeObserver(scheduleUpdate);
    if (containerRef.current) observer.observe(containerRef.current);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      observer.disconnect();
    };
  }, [updateVisibleCount]);

  const clampedVisibleCount = Math.min(Math.max(visibleCount, 1), citations.length);
  const visibleCitations = citations.slice(0, clampedVisibleCount);
  const hiddenCitations = citations.slice(clampedVisibleCount);

  return (
    <div className="relative mt-2 max-w-full" aria-label="Brain sources">
      <div ref={containerRef} className="max-w-full">
        <div className="flex max-w-full items-center gap-1 overflow-hidden whitespace-nowrap">
          {visibleCitations.map((citation, index) => (
            <BrainCitationChip key={citation.key} citation={citation} index={index + 1} />
          ))}
          {hiddenCitations.length > 0 ? (
            <BrainCitationOverflow
              citations={hiddenCitations}
              startIndex={clampedVisibleCount + 1}
            />
          ) : null}
        </div>
      </div>
      <BrainCitationMeasureRow measureRef={measureRef} citations={citations} />
    </div>
  );
}

export function getVisibleBrainCitationCount({
  availableWidth,
  chipWidths,
  overflowWidths,
  gap,
}: {
  availableWidth: number;
  chipWidths: number[];
  overflowWidths: Record<number, number>;
  gap: number;
}) {
  const total = chipWidths.length;
  if (total <= 1 || availableWidth <= 0) return total;

  for (let visibleCount = total; visibleCount >= 1; visibleCount -= 1) {
    const hiddenCount = total - visibleCount;
    const visibleWidth = chipWidths.slice(0, visibleCount).reduce((sum, width) => sum + width, 0);
    const overflowWidth = hiddenCount > 0 ? (overflowWidths[hiddenCount] ?? 0) : 0;
    const itemCount = visibleCount + (hiddenCount > 0 ? 1 : 0);
    const totalWidth = visibleWidth + overflowWidth + Math.max(itemCount - 1, 0) * gap;

    if (totalWidth <= availableWidth || visibleCount === 1) return visibleCount;
  }

  return total;
}

function BrainCitationChip({ citation, index }: { citation: BrainCitation; index: number }) {
  const ariaLabel = `Source ${index}: ${citation.title}`;

  return (
    <CitationLink citation={citation} ariaLabel={ariaLabel} className={citationChipClassName}>
      <BrainCitationChipContent citation={citation} index={index} />
    </CitationLink>
  );
}

// External citations (capability entities: Slack messages, Linear issues, …)
// point at provider URLs and open in a new tab; internal ones are Brain routes.
function CitationLink({
  citation,
  ariaLabel,
  className,
  children,
}: {
  citation: BrainCitation;
  ariaLabel: string;
  className: string;
  children: React.ReactNode;
}) {
  if (citation.external) {
    return (
      <a
        href={citation.href}
        target="_blank"
        rel="noopener noreferrer"
        title={citation.title}
        aria-label={ariaLabel}
        className={className}
      >
        {children}
      </a>
    );
  }
  return (
    <Link href={citation.href} title={citation.title} aria-label={ariaLabel} className={className}>
      {children}
    </Link>
  );
}

function BrainCitationOverflow({
  citations,
  startIndex,
}: {
  citations: BrainCitation[];
  startIndex: number;
}) {
  const hiddenCount = citations.length;
  return (
    <Popover>
      <PopoverTrigger
        type="button"
        aria-label={`Show ${hiddenCount} more brain ${pluralizeSource(hiddenCount)}`}
        className={cn(
          citationChipClassName,
          "shrink-0 text-ink-subtle hover:text-ink data-[popup-open]:border-border-strong data-[popup-open]:text-ink",
        )}
      >
        {overflowLabel(hiddenCount)}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        className="w-[300px] max-w-[calc(100vw-1.5rem)] border-border bg-surface p-1 text-ink shadow-[0_12px_32px_rgba(15,15,15,0.14)]"
      >
        <div className="px-2 py-1 text-[11px] font-medium leading-4 text-ink-subtle">
          Other sources
        </div>
        <div className="max-h-[260px] overflow-y-auto">
          {citations.map((citation, index) => (
            <CitationLink
              key={citation.key}
              citation={citation}
              ariaLabel={`Source ${startIndex + index}: ${citation.title}`}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] font-medium text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
            >
              <BrainCitationIndex index={startIndex + index} />
              <CitationIcon citation={citation} size={11} />
              <span className="min-w-0 truncate">{citation.label}</span>
            </CitationLink>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function BrainCitationMeasureRow({
  citations,
  measureRef,
}: {
  citations: BrainCitation[];
  measureRef: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <div
      ref={measureRef}
      aria-hidden="true"
      className="invisible pointer-events-none absolute left-0 top-0 flex h-0 max-w-none items-center gap-1 overflow-hidden whitespace-nowrap"
    >
      {citations.map((citation, index) => (
        <span key={citation.key} data-citation-measure="chip" className={citationChipClassName}>
          <BrainCitationChipContent citation={citation} index={index + 1} />
        </span>
      ))}
      {citations.slice(1).map((_, index) => {
        const count = index + 1;
        return (
          <span key={count} data-overflow-count={count} className={citationChipClassName}>
            {overflowLabel(count)}
          </span>
        );
      })}
    </div>
  );
}

function BrainCitationChipContent({ citation, index }: { citation: BrainCitation; index: number }) {
  return (
    <>
      <BrainCitationIndex index={index} />
      <CitationIcon citation={citation} size={10} />
      <span className="min-w-0 truncate">{citation.label}</span>
    </>
  );
}

function CitationIcon({ citation, size }: { citation: BrainCitation; size: number }) {
  const Icon = citation.external ? ExternalLink : BookOpen;
  return <Icon size={size} strokeWidth={1.9} className="shrink-0 text-ink-subtle" />;
}

function BrainCitationIndex({ index }: { index: number }) {
  return (
    <span className="inline-flex h-3.5 min-w-3.5 shrink-0 items-center justify-center rounded bg-ink/10 px-0.5 font-mono text-[9px] leading-none text-ink-muted">
      {index}
    </span>
  );
}

function overflowLabel(count: number) {
  return `+ ${count} other ${pluralizeSource(count)}`;
}

function pluralizeSource(count: number) {
  return count === 1 ? "source" : "sources";
}

const citationChipClassName =
  "inline-flex h-5 max-w-[min(220px,100%)] items-center gap-1 rounded-[5px] border border-border bg-surface px-1.5 text-[10px] font-medium leading-none text-ink-muted transition-colors hover:border-border-strong hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20";
