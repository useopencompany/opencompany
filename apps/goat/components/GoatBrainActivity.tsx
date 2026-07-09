"use client";

import type { GoatBrainIngestTrace } from "@opencompany/db/goat-brain-ingest-trace";
import { Popover, PopoverContent, PopoverTrigger } from "@opencompany/ui/components/popover";
import { useLiveQuery } from "@tanstack/react-db";
import {
  Activity,
  CircleAlert,
  CircleCheck,
  Inbox,
  Loader2,
  RotateCw,
  TerminalSquare,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { BrainIngestTraceDialog } from "@/components/BrainIngestTraceView";
import { buildGoatBrainActivityEvents, type GoatBrainActivityKind } from "@/lib/brain-activity";
import {
  createGoatCollections,
  type GoatBrainIngestJobRow,
  type GoatBrainSourceItemRow,
} from "@/lib/task-collections";

type SelectedBrainIngestTrace = {
  trace: GoatBrainIngestTrace;
  sourceTitle: string;
};

export function GoatBrainActivity({ brainRef }: { brainRef: string }) {
  const [open, setOpen] = useState(false);
  const [selectedTrace, setSelectedTrace] = useState<SelectedBrainIngestTrace | null>(null);

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          aria-label="Brain activity"
          title="Activity"
          className="flex h-7 w-7 items-center justify-center rounded-md text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 data-[popup-open]:bg-surface-active data-[popup-open]:text-ink"
        >
          <Activity size={15} strokeWidth={1.8} />
        </PopoverTrigger>
        <PopoverContent align="start" sideOffset={4} className="w-[340px] p-0">
          <GoatBrainActivityFeed brainRef={brainRef} onOpenTrace={setSelectedTrace} />
        </PopoverContent>
      </Popover>
      <BrainIngestTraceDialog
        trace={selectedTrace?.trace ?? null}
        sourceTitle={selectedTrace?.sourceTitle ?? ""}
        open={Boolean(selectedTrace)}
        onOpenChange={(dialogOpen) => {
          if (!dialogOpen) setSelectedTrace(null);
        }}
      />
    </>
  );
}

// Only mounted while the popover is open, so the ingest-job and source-item
// shapes start syncing on first use instead of on page load.
function GoatBrainActivityFeed({
  brainRef,
  onOpenTrace,
}: {
  brainRef: string;
  onOpenTrace: (trace: SelectedBrainIngestTrace) => void;
}) {
  const collections = useMemo(() => createGoatCollections(), []);
  const brainCollections = useMemo(
    () => collections.brainCollections(brainRef),
    [brainRef, collections],
  );
  const { data: jobRows, isLoading: jobsLoading } = useLiveQuery(
    (q) => q.from({ job: brainCollections.ingestJobs }),
    [brainCollections],
  );
  const { data: itemRows, isLoading: itemsLoading } = useLiveQuery(
    (q) => q.from({ item: collections.brainSourceItems }),
    [collections],
  );
  const events = useMemo(
    () =>
      buildGoatBrainActivityEvents(
        (jobRows ?? []) as GoatBrainIngestJobRow[],
        (itemRows ?? []) as GoatBrainSourceItemRow[],
      ),
    [itemRows, jobRows],
  );
  const loading = (jobsLoading || itemsLoading) && events.length === 0;

  return (
    <div className="flex flex-col">
      <div className="border-b border-border-subtle px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
        Activity
      </div>
      <div className="max-h-[360px] overflow-y-auto p-1">
        {loading ? (
          <div className="px-2 py-3 text-[12px] text-ink-subtle">Loading activity…</div>
        ) : events.length === 0 ? (
          <div className="px-2 py-3 text-[12px] text-ink-subtle">
            No activity yet. Chat captures and meeting ingestions show up here as they are filed
            into this brain.
          </div>
        ) : (
          events.map((event) => {
            const icon = ACTIVITY_ICONS[event.kind];
            const Icon = icon.component;
            const trace = event.trace;
            return (
              <div key={event.id} className="flex items-start gap-2.5 rounded-[5px] px-2 py-1.5">
                <Icon size={14} strokeWidth={1.9} className={`mt-0.5 shrink-0 ${icon.className}`} />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[12.5px] font-medium text-ink">{event.title}</span>
                    <span className="shrink-0 text-[11px] text-ink-subtle">
                      {formatRelativeTime(event.at)}
                    </span>
                  </div>
                  <span className="truncate text-[12px] text-ink-muted" title={event.sourceTitle}>
                    {event.sourceTitle}
                  </span>
                  {event.detail ? (
                    <span className="text-[11.5px] leading-snug text-ink-subtle">
                      {event.detail}
                    </span>
                  ) : null}
                  {event.kind === "filed" && event.pages.length > 0 ? (
                    <ActivityPageLinks brainRef={brainRef} pages={event.pages} />
                  ) : null}
                  {trace ? (
                    <button
                      type="button"
                      onClick={() => onOpenTrace({ trace, sourceTitle: event.sourceTitle })}
                      className="mt-1 inline-flex w-fit items-center gap-1 rounded-[4px] border border-border-subtle bg-surface px-1.5 py-0.5 text-[11px] leading-4 text-ink-muted transition-colors duration-150 hover:border-border hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
                    >
                      <TerminalSquare size={11} strokeWidth={1.8} />
                      Trace
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

const MAX_VISIBLE_ACTIVITY_PAGE_LINKS = 4;

function ActivityPageLinks({
  brainRef,
  pages,
}: {
  brainRef: string;
  pages: Array<{ brainId: string; folderPath: string; title: string }>;
}) {
  const visiblePages = pages.slice(0, MAX_VISIBLE_ACTIVITY_PAGE_LINKS);
  const hiddenCount = pages.length - visiblePages.length;

  return (
    <div className="mt-1 flex min-w-0 flex-wrap gap-1">
      {visiblePages.map((page) => (
        <Link
          key={`${page.folderPath}/${page.brainId}`}
          href={activityPageHref(brainRef, page.folderPath, page.brainId)}
          className="inline-flex max-w-[180px] truncate rounded-[4px] border border-border-subtle bg-surface px-1.5 py-0.5 text-[11px] leading-4 text-ink-muted transition-colors duration-150 hover:border-border hover:bg-surface-hover hover:text-ink"
          title={page.title || page.brainId}
        >
          {page.title || page.brainId}
        </Link>
      ))}
      {hiddenCount > 0 ? (
        <span className="rounded-[4px] border border-transparent px-1.5 py-0.5 text-[11px] leading-4 text-ink-subtle">
          +{hiddenCount} more
        </span>
      ) : null}
    </div>
  );
}

const ACTIVITY_ICONS: Record<
  GoatBrainActivityKind,
  { component: typeof Activity; className: string }
> = {
  captured: { component: Inbox, className: "text-ink-muted" },
  filing: { component: Loader2, className: "animate-spin text-ink-muted" },
  filed: { component: CircleCheck, className: "text-emerald-600" },
  retrying: { component: RotateCw, className: "text-amber-600" },
  failed: { component: CircleAlert, className: "text-danger" },
};

function formatRelativeTime(value: string) {
  const timestamp = new Date(value).getTime();
  const elapsedMs = Date.now() - timestamp;
  if (!Number.isFinite(timestamp) || elapsedMs < 30_000) return "just now";

  const elapsedMinutes = Math.floor(elapsedMs / 60_000);
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h ago`;

  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 7) return `${elapsedDays}d ago`;

  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
  }).format(timestamp);
}

function activityPageHref(brainRef: string, folderPath: string, brainId: string) {
  const segments = [brainRef, ...folderPath.split("/").filter(Boolean), brainId];
  return `/brain/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
}
