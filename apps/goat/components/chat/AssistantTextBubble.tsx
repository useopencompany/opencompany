"use client";

import { BookOpen, LinkIcon } from "lucide-react";
import Link from "next/link";
import { Markdown } from "@/components/Markdown";
import { isExternalHref } from "@/lib/brain-source-links";
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
  return (
    <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Brain sources">
      {citations.map((citation, index) => (
        <BrainCitationChip key={citation.key} citation={citation} index={index + 1} />
      ))}
    </div>
  );
}

function BrainCitationChip({ citation, index }: { citation: BrainCitation; index: number }) {
  const content = (
    <>
      <span className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded bg-ink/10 px-1 font-mono text-[10px] leading-none text-ink-muted">
        {index}
      </span>
      <BrainCitationIcon citation={citation} />
      <span className="min-w-0 truncate">{citation.label}</span>
    </>
  );
  const className =
    "inline-flex h-6 max-w-[min(260px,100%)] items-center gap-1 rounded-md border border-border bg-surface px-1.5 text-[10.5px] font-medium leading-none text-ink-muted transition-colors hover:border-border-strong hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20";
  const ariaLabel = `Source ${index}: ${citation.title}`;

  if (!citation.href) {
    return (
      <span title={citation.title} aria-label={ariaLabel} className={className}>
        {content}
      </span>
    );
  }

  if (citation.href.startsWith("/brain/") || citation.href === "/brain") {
    return (
      <Link
        href={citation.href}
        title={citation.title}
        aria-label={ariaLabel}
        className={className}
      >
        {content}
      </Link>
    );
  }

  return (
    <a
      href={citation.href}
      title={citation.title}
      aria-label={ariaLabel}
      target={isExternalHref(citation.href) ? "_blank" : undefined}
      rel={isExternalHref(citation.href) ? "noreferrer noopener" : undefined}
      className={className}
    >
      {content}
    </a>
  );
}

function BrainCitationIcon({ citation }: { citation: BrainCitation }) {
  const Icon = citation.icon === "brain" ? BookOpen : LinkIcon;
  return <Icon size={11} strokeWidth={1.9} className="shrink-0 text-ink-subtle" />;
}
