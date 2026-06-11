"use client";

import { X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Fragment, useCallback, useState, useSyncExternalStore } from "react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@opencompany/ui/components/resizable";
import SessionView from "@/components/SessionView";
import {
  buildSplitViewHref,
  MAX_PANES,
  parseSplitParam,
} from "@/lib/agent-sessions/split-panes";

// Below a pane's minimum width chat transcripts become unusable; v4 of
// react-resizable-panels accepts pixel min sizes directly.
const MIN_PANE_WIDTH = "360px";

// Split panes only make sense with room for at least two usable columns; below this the
// container renders the primary chat alone (matches the lg breakpoint).
const WIDE_VIEWPORT_MIN_WIDTH_PX = 1024;

// Hydration-safe min-width media query. The server snapshot assumes a wide viewport so
// the dominant desktop case doesn't flash a collapsed layout during SSR/hydration; the
// client snapshot takes over right after and tracks viewport changes.
function useMinWidth(px: number): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const mql = window.matchMedia(`(min-width: ${px}px)`);
      mql.addEventListener("change", onStoreChange);
      return () => mql.removeEventListener("change", onStoreChange);
    },
    [px],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(`(min-width: ${px}px)`).matches,
    () => true,
  );
}

// Container for one or more side-by-side SessionView panes. The layout lives in the URL:
// the route segment is the primary (leftmost) pane and `?split=id2,id3` carries the
// secondary panes, so adding/closing panes is a router.push and Back undoes layout
// changes. A pane in "picker" state (choose which session to open) is local React state
// only — it never hits the URL.
export default function SessionSplitView({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const secondaryIds = parseSplitParam(searchParams.get("split"), sessionId);
  // At most one pending picker pane at a time; it renders as the last column.
  const [pickerOpen, setPickerOpen] = useState(false);
  const isWide = useMinWidth(WIDE_VIEWPORT_MIN_WIDTH_PX);

  const navigate = useCallback(
    (primaryId: string, nextSecondaryIds: string[]) => {
      router.push(buildSplitViewHref(pathname, primaryId, nextSecondaryIds));
    },
    [router, pathname],
  );

  const handleRequestSplit = useCallback(() => setPickerOpen(true), []);
  const handleCancelPick = useCallback(() => setPickerOpen(false), []);

  const handlePick = useCallback(
    (pickedId: string) => {
      setPickerOpen(false);
      // Already-open sessions are deduped by parseSplitParam anyway; skip the no-op push.
      if (pickedId === sessionId || secondaryIds.includes(pickedId)) return;
      navigate(sessionId, [...secondaryIds, pickedId]);
    },
    [navigate, sessionId, secondaryIds],
  );

  const handleClosePane = useCallback(
    (paneId: string) => {
      if (paneId === sessionId) {
        // Closing the primary promotes the first secondary into the route segment.
        const [nextPrimary, ...rest] = secondaryIds;
        // Invariant guard (also narrows the type): session panes only get a Close
        // button when a secondary exists, so a successor is always available here.
        if (!nextPrimary) return;
        navigate(nextPrimary, rest);
        return;
      }
      navigate(
        sessionId,
        secondaryIds.filter((id) => id !== paneId),
      );
    },
    [navigate, sessionId, secondaryIds],
  );

  // Narrow viewports get the primary chat only, with no split affordances. The URL is
  // left untouched so widening the window restores the split layout. Returning early
  // here (instead of hiding with CSS) keeps the secondary SessionViews unmounted — each
  // mount opens its own SSE stream.
  if (!isWide) return <SessionView sessionId={sessionId} isPrimary />;

  const paneIds = [sessionId, ...secondaryIds];
  const totalPanes = paneIds.length + (pickerOpen ? 1 : 0);
  const splitDisabled = totalPanes >= MAX_PANES;

  // Single pane and nothing pending: skip the resizable group entirely so the common
  // standalone-chat case carries zero split-view overhead. No Close button either —
  // the only pane can't be closed.
  if (paneIds.length === 1 && !pickerOpen) {
    return (
      <SessionView
        sessionId={sessionId}
        isPrimary
        onRequestSplit={handleRequestSplit}
        splitDisabled={splitDisabled}
      />
    );
  }

  return (
    <ResizablePanelGroup orientation="horizontal" className="h-full min-w-0 flex-1">
      {paneIds.map((paneId, index) => (
        // Keyed by session id so a pane's React state survives siblings being added,
        // closed, or the primary being promoted.
        <Fragment key={paneId}>
          {index > 0 ? <ResizableHandle /> : null}
          <ResizablePanel
            minSize={MIN_PANE_WIDTH}
            className="flex h-full min-w-0 flex-col"
            // The lib's inner panel div defaults to inline `overflow: auto`, which a
            // className can't override; the chat manages its own scrolling.
            style={{ overflow: "hidden" }}
          >
            <SessionView
              sessionId={paneId}
              isPrimary={index === 0}
              inspectorDefaultCollapsed
              onRequestSplit={handleRequestSplit}
              splitDisabled={splitDisabled}
              // Closing only means something with another session pane to fall back
              // to: with a lone session pane + the pending picker, no Close button
              // renders — the picker column has its own Cancel.
              {...(secondaryIds.length > 0
                ? { onClosePane: () => handleClosePane(paneId) }
                : {})}
            />
          </ResizablePanel>
        </Fragment>
      ))}
      {pickerOpen ? (
        <Fragment key="picker">
          <ResizableHandle />
          <ResizablePanel
            minSize={MIN_PANE_WIDTH}
            className="flex h-full min-w-0 flex-col"
            style={{ overflow: "hidden" }}
          >
            <SessionPickerPane onPick={handlePick} onCancel={handleCancelPick} />
          </ResizablePanel>
        </Fragment>
      ) : null}
    </ResizablePanelGroup>
  );
}

type SessionPickerPaneProps = {
  // Contract for the real picker (see below): called with the chosen session id.
  onPick: (sessionId: string) => void;
  onCancel: () => void;
};

// Placeholder pane shown while the user chooses which session to open in a new split.
// Task 4 replaces the body with a cmdk session picker; the props contract — onPick(id),
// onCancel() — stays as-is. Until then it only offers Cancel (button or Escape).
function SessionPickerPane({ onCancel }: SessionPickerPaneProps) {
  return (
    <section
      aria-label="Choose a session"
      className="flex h-full flex-col bg-surface/45"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        onCancel();
      }}
    >
      <header className="flex items-center justify-end py-2 pr-6 pl-6">
        <button
          type="button"
          aria-label="Cancel choosing a session"
          // Focused on mount so Escape cancels without an extra click.
          autoFocus
          onClick={onCancel}
          className="shrink-0 rounded-md p-1.5 text-ink/55 transition-colors hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        >
          <X size={15} strokeWidth={1.75} />
        </button>
      </header>
      <div className="flex flex-1 items-center justify-center px-6">
        <div className="max-w-sm rounded-lg border border-dashed border-border bg-surface/45 px-5 py-6 text-center">
          <p className="text-[13.5px] font-medium text-ink">Choose a session</p>
          <p className="mt-1 text-[12.5px] leading-5 text-ink-muted">
            The session picker lands here next.
          </p>
        </div>
      </div>
    </section>
  );
}
