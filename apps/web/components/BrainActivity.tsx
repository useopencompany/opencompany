"use client";

import type { BrainIngestTrace } from "@opencompany/brain/ingest-trace";
import type { BrainIngestJobReadModel, BrainSourceItemDto } from "@opencompany/protocol";
import { Popover, PopoverContent, PopoverTrigger } from "@opencompany/ui/components/popover";
import { useLiveQuery } from "@tanstack/react-db";
import {
  Activity,
  CircleAlert,
  CircleCheck,
  CircleMinus,
  CirclePause,
  Inbox,
  Loader2,
  RotateCw,
  TerminalSquare,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { BrainIngestTraceDialog } from "@/components/BrainIngestTraceView";
import { type BrainActivityKind, buildBrainActivityEvents } from "@/lib/brain-activity";
import { getHeadlessBrainCollections } from "@/lib/headless-knowledge-collections";
import { listHeadlessBrainSourceItems } from "@/lib/headless-knowledge-commands";

type SelectedBrainIngestTrace = {
  trace: BrainIngestTrace;
  traceId: string;
  sourceTitle: string;
  durationMs: number | null;
};

const MAX_ACTIVITY_SOURCE_ITEM_FETCH_IDS = 100;

export function BrainActivity({ brainRef }: { brainRef: string }) {
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
          <BrainActivityFeed brainRef={brainRef} onOpenTrace={setSelectedTrace} />
        </PopoverContent>
      </Popover>
      <BrainIngestTraceDialog
        trace={selectedTrace?.trace ?? null}
        traceId={selectedTrace?.traceId ?? ""}
        sourceTitle={selectedTrace?.sourceTitle ?? ""}
        durationMs={selectedTrace?.durationMs ?? null}
        open={Boolean(selectedTrace)}
        onOpenChange={(dialogOpen) => {
          if (!dialogOpen) setSelectedTrace(null);
        }}
      />
    </>
  );
}

export function BrainRecentActivity({
  brainRef,
  limit = 6,
  filter = "filed",
}: {
  brainRef: string;
  limit?: number;
  filter?: BrainActivityFilter;
}) {
  return (
    <BrainActivityFeed
      brainRef={brainRef}
      limit={limit}
      variant="overview"
      activityFilter={filter}
    />
  );
}

export type BrainActivityFilter = "filed" | "received" | "skipped" | "all";

// Mounted eagerly by the Overview page and lazily by the activity popover; the
// ingest-job and source-item shapes start syncing as soon as either consumer mounts.
function BrainActivityFeed({
  brainRef,
  onOpenTrace,
  limit,
  variant = "popover",
  activityFilter = "all",
}: {
  brainRef: string;
  onOpenTrace?: (trace: SelectedBrainIngestTrace) => void;
  limit?: number;
  variant?: "popover" | "overview";
  activityFilter?: BrainActivityFilter;
}) {
  const brainCollections = useMemo(() => getHeadlessBrainCollections(brainRef), [brainRef]);
  const { data: jobRows, isLoading: jobsLoading } = useLiveQuery(
    (q) => q.from({ job: brainCollections.ingestJobs }),
    [brainCollections],
  );
  const [sourceItems, setSourceItems] = useState<BrainSourceItemDto[]>([]);
  const missingSourceItemIds = useMemo(() => {
    const known = new Set(sourceItems.map((item) => item.id));
    return Array.from(
      new Set(
        ((jobRows ?? []) as BrainIngestJobReadModel[])
          .map((job) => job.sourceItemId)
          .filter((id) => id && !known.has(id)),
      ),
    ).slice(0, MAX_ACTIVITY_SOURCE_ITEM_FETCH_IDS);
  }, [jobRows, sourceItems]);
  const missingSourceItemIdsKey = missingSourceItemIds.join(",");
  useEffect(() => {
    if (!missingSourceItemIdsKey) return;
    let canceled = false;
    void listHeadlessBrainSourceItems(brainRef, missingSourceItemIds).then(
      (items) => {
        if (canceled || items.length === 0) return;
        setSourceItems((current) => mergeSourceItemRows(current, items));
      },
      (error) => {
        if (canceled) return;
        console.warn("[opencompany-brain-activity] failed to load source metadata", {
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );

    return () => {
      canceled = true;
    };
  }, [brainRef, missingSourceItemIds, missingSourceItemIdsKey]);
  const filteredKind = activityKindForFilter(activityFilter);
  const events = useMemo(
    () =>
      buildBrainActivityEvents(
        (jobRows ?? []) as BrainIngestJobReadModel[],
        sourceItems,
        filteredKind ? { kinds: [filteredKind] } : undefined,
      ),
    [filteredKind, jobRows, sourceItems],
  );
  const visibleEvents = limit ? events.slice(0, limit) : events;
  const hasJobs = (jobRows?.length ?? 0) > 0;
  const loading = jobsLoading && !hasJobs;
  const overview = variant === "overview";

  return (
    <div className="flex flex-col">
      {!overview ? (
        <div className="border-b border-border-subtle px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
          Activity
        </div>
      ) : null}
      <div
        className={overview ? "divide-y divide-border-subtle" : "max-h-[360px] overflow-y-auto p-1"}
      >
        {loading ? (
          <div
            className={
              overview
                ? "py-5 text-[12.5px] text-ink-subtle"
                : "px-2 py-3 text-[12px] text-ink-subtle"
            }
          >
            Loading activity…
          </div>
        ) : !hasJobs ? (
          <div
            className={
              overview
                ? "py-5 text-[12.5px] leading-5 text-ink-subtle"
                : "px-2 py-3 text-[12px] text-ink-subtle"
            }
          >
            No activity yet. Chat captures and meeting ingestions show up here as they are filed
            into this brain.
          </div>
        ) : events.length === 0 ? (
          <div
            className={
              overview
                ? "py-5 text-[12.5px] leading-5 text-ink-subtle"
                : "px-2 py-3 text-[12px] text-ink-subtle"
            }
          >
            {emptyActivityFilterMessage(activityFilter)}
          </div>
        ) : (
          visibleEvents.map((event) => {
            const icon = ACTIVITY_ICONS[event.kind];
            const Icon = icon.component;
            const trace = event.trace;
            return (
              <div
                key={event.id}
                className={
                  overview
                    ? "flex items-start gap-3 py-3.5 first:pt-0 last:pb-0"
                    : "flex items-start gap-2.5 rounded-[5px] px-2 py-1.5"
                }
              >
                {overview ? (
                  <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-muted">
                    <Icon size={14} strokeWidth={1.9} className={`shrink-0 ${icon.className}`} />
                  </span>
                ) : (
                  <Icon
                    size={14}
                    strokeWidth={1.9}
                    className={`mt-0.5 shrink-0 ${icon.className}`}
                  />
                )}
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span
                      className={
                        overview
                          ? "text-[13px] font-medium text-ink"
                          : "text-[12.5px] font-medium text-ink"
                      }
                    >
                      {event.title}
                    </span>
                    <span
                      className={
                        overview
                          ? "shrink-0 text-[11.5px] text-ink-subtle"
                          : "shrink-0 text-[11px] text-ink-subtle"
                      }
                    >
                      {formatRelativeTime(event.at)}
                    </span>
                  </div>
                  <span
                    className={
                      overview
                        ? "truncate text-[12.5px] text-ink-muted"
                        : "truncate text-[12px] text-ink-muted"
                    }
                    title={event.sourceTitle}
                  >
                    {event.sourceTitle}
                  </span>
                  {event.detail && !overview ? (
                    <span className="text-[11.5px] leading-snug text-ink-subtle">
                      {event.detail}
                    </span>
                  ) : null}
                  {!overview ? <TraceIdLine traceId={event.traceId} /> : null}
                  {event.kind === "filed" && event.pages.length > 0 ? (
                    <ActivityPageLinks brainRef={brainRef} pages={event.pages} />
                  ) : null}
                  {trace && onOpenTrace && !overview ? (
                    <button
                      type="button"
                      onClick={() =>
                        onOpenTrace({
                          trace,
                          traceId: event.traceId,
                          sourceTitle: event.sourceTitle,
                          durationMs: event.durationMs,
                        })
                      }
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

function activityKindForFilter(filter: BrainActivityFilter): BrainActivityKind | null {
  if (filter === "all") return null;
  if (filter === "received") return "captured";
  return filter;
}

function emptyActivityFilterMessage(filter: BrainActivityFilter): string {
  if (filter === "filed") return "No successful filings yet.";
  if (filter === "received") return "No received items yet.";
  if (filter === "skipped") return "No skipped filings yet.";
  return "No matching activity yet.";
}

function TraceIdLine({ traceId }: { traceId: string }) {
  return (
    <div className="mt-0.5 flex min-w-0 items-baseline gap-1.5 text-[10.5px] leading-4 text-ink-subtle">
      <span className="shrink-0 font-medium">Trace ID</span>
      <code
        className="min-w-0 break-all rounded bg-ink/5 px-1 py-px font-mono text-[10px] text-ink-muted"
        title={traceId}
      >
        {traceId}
      </code>
    </div>
  );
}

function mergeSourceItemRows(...sources: readonly (readonly BrainSourceItemDto[])[]) {
  const rowsById = new Map<string, BrainSourceItemDto>();
  for (const source of sources) {
    for (const row of source) rowsById.set(row.id, row);
  }
  return Array.from(rowsById.values());
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

const ACTIVITY_ICONS: Record<BrainActivityKind, { component: typeof Activity; className: string }> =
  {
    captured: { component: Inbox, className: "text-ink-muted" },
    filing: { component: Loader2, className: "animate-spin text-ink-muted" },
    filed: { component: CircleCheck, className: "text-emerald-600" },
    skipped: { component: CircleMinus, className: "text-ink-subtle" },
    paused: { component: CirclePause, className: "text-amber-600" },
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
