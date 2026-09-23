"use client";

import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { ChatPane } from "@/components/chat-panes/ChatPane";
import { useChatPaneWorkspace } from "@/components/chat-panes/ChatPaneWorkspace";
import {
  type ChatPaneTree,
  chatPaneGeometry,
  isPane,
  listPanes,
  MIN_PANE_PERCENT,
  type SeamRect,
} from "@/lib/chat-pane-layout";
import type { ChatSessionView } from "@/lib/chat-ui";

/** One arrow press moves a boundary by this much of the split's main axis. */
const KEYBOARD_RESIZE_STEP = 2;

/**
 * Below this the panes would be narrower than a readable chat column, so the
 * canvas shows the focused pane alone with a switcher instead. Four panes at
 * the 15% floor still need room to compose in, and touch has no drag-and-drop.
 */
const SPLIT_CAPABLE_QUERY = "(min-width: 1024px)";

function subscribeSplitCapable(onStoreChange: () => void) {
  const query = window.matchMedia(SPLIT_CAPABLE_QUERY);
  query.addEventListener("change", onStoreChange);
  return () => query.removeEventListener("change", onStoreChange);
}

function getSplitCapableSnapshot() {
  return window.matchMedia(SPLIT_CAPABLE_QUERY).matches;
}

function getSplitCapableServerSnapshot() {
  // The server cannot measure the viewport; assuming a single pane means the
  // first paint is the layout every width can render.
  return false;
}

export function ChatPaneCanvas({
  routeInitialChat = null,
  newChatProjectId = null,
  newChatProjectName = null,
}: {
  routeInitialChat?: ChatSessionView | null;
  newChatProjectId?: string | null;
  newChatProjectName?: string | null;
}) {
  const { layout, focusPaneById } = useChatPaneWorkspace();
  const canvasRef = useRef<HTMLDivElement>(null);
  const splitCapable = useSyncExternalStore(
    subscribeSplitCapable,
    getSplitCapableSnapshot,
    getSplitCapableServerSnapshot,
  );

  const panes = listPanes(layout.root);
  const geometry = useMemo(() => chatPaneGeometry(layout.root), [layout.root]);
  const focusedPaneId = panes.some((pane) => pane.id === layout.focusedPaneId)
    ? layout.focusedPaneId
    : panes[0]?.id;
  const split = panes.length > 1;
  // The arrangement is kept in state at every width; a narrow viewport just
  // shows the focused pane and reaches the others through the switcher.
  const narrow = !splitCapable && split;

  const paneProps = { routeInitialChat, newChatProjectId, newChatProjectName };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {narrow ? (
        <nav
          aria-label="Open chat panes"
          className="flex shrink-0 gap-1 overflow-x-auto border-border border-b px-2 py-1.5"
        >
          {panes.map((pane, index) => (
            <button
              key={pane.id}
              type="button"
              aria-current={pane.id === focusedPaneId ? "true" : undefined}
              onClick={() => focusPaneById(pane.id)}
              className={`shrink-0 rounded-md px-2.5 py-1 text-[12.5px] transition-colors duration-150 ${
                pane.id === focusedPaneId
                  ? "bg-surface-active text-ink"
                  : "text-ink/70 hover:bg-surface-hover hover:text-ink"
              }`}
            >
              {`Pane ${index + 1}`}
            </button>
          ))}
        </nav>
      ) : null}

      {/*
        Every pane is a sibling in one stably-keyed list, positioned from the
        computed geometry. Splitting inserts a sibling and moves the rest, so
        React never tears down a pane the reader is already using — which would
        take its transcript subscription and in-flight turn with it.
      */}
      <div ref={canvasRef} className="relative min-h-0 min-w-0 flex-1">
        {geometry.panes.map((rect) => {
          const pane = panes.find((candidate) => candidate.id === rect.paneId);
          if (!pane) return null;
          const focused = pane.id === focusedPaneId;
          return (
            <div
              key={pane.id}
              // A hidden narrow-screen pane stays mounted and streaming;
              // unmounting it would make the switcher reload the chat each time.
              style={
                narrow
                  ? focused
                    ? { position: "absolute", inset: 0 }
                    : { display: "none" }
                  : {
                      position: "absolute",
                      left: `${rect.left}%`,
                      top: `${rect.top}%`,
                      width: `${rect.width}%`,
                      height: `${rect.height}%`,
                    }
              }
              className="flex"
            >
              <ChatPane pane={pane} focused={focused} showHeader={split} {...paneProps} />
            </div>
          );
        })}

        {narrow
          ? null
          : geometry.seams.map((seam) => (
              <ChatPaneResizer
                key={`${seam.splitId}:${seam.index}`}
                seam={seam}
                canvasRef={canvasRef}
              />
            ))}
      </div>
    </div>
  );
}

function ChatPaneResizer({
  seam,
  canvasRef,
}: {
  seam: SeamRect;
  canvasRef: RefObject<HTMLDivElement | null>;
}) {
  const { layout, resizeSplitBoundary } = useChatPaneWorkspace();
  const horizontal = seam.direction === "row";

  const sizes = useMemo(
    () => splitChildSizes(layout.root, seam.splitId),
    [layout.root, seam.splitId],
  );
  const beforeSize = sizes[seam.index] ?? 0;
  const pairTotal = beforeSize + (sizes[seam.index + 1] ?? 0);

  const dragRef = useRef<{
    origin: number;
    splitPx: number;
    start: number;
    applied: number;
  } | null>(null);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      // Only a primary-button drag resizes. A right-click would otherwise arm
      // the drag and never see a matching pointerup, leaving plain hovering to
      // drag the seam around.
      if (event.button !== 0) return;
      const canvas = canvasRef.current?.getBoundingClientRect();
      if (!canvas) return;
      // The split occupies a known fraction of the canvas, so its own pixel
      // extent converts pointer movement straight into this split's percentages.
      const splitPx = ((horizontal ? canvas.width : canvas.height) * seam.splitExtent) / 100;
      if (splitPx <= 0) return;

      dragRef.current = {
        origin: horizontal ? event.clientX : event.clientY,
        splitPx,
        start: beforeSize,
        applied: beforeSize,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    },
    [beforeSize, canvasRef, horizontal, seam.splitExtent],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      const moved = (horizontal ? event.clientX : event.clientY) - drag.origin;
      const rawTarget = drag.start + (moved / drag.splitPx) * 100;
      const target = Math.max(MIN_PANE_PERCENT, Math.min(pairTotal - MIN_PANE_PERCENT, rawTarget));
      const delta = target - drag.applied;
      if (delta === 0) return;
      drag.applied = target;
      // Pointer moves are continuous events and React may batch several before
      // rendering. Accumulating from the last applied target keeps queued
      // updates additive instead of applying each move against stale props.
      resizeSplitBoundary(seam.splitId, seam.index, delta);
    },
    [horizontal, pairTotal, resizeSplitBoundary, seam.index, seam.splitId],
  );

  const endDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation={horizontal ? "vertical" : "horizontal"}
      aria-label={horizontal ? "Resize panes horizontally" : "Resize panes vertically"}
      aria-valuemin={Math.round(MIN_PANE_PERCENT)}
      aria-valuemax={Math.round(pairTotal - MIN_PANE_PERCENT)}
      aria-valuenow={Math.round(beforeSize)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={(event) => {
        const decrease = horizontal ? "ArrowLeft" : "ArrowUp";
        const increase = horizontal ? "ArrowRight" : "ArrowDown";
        if (event.key !== decrease && event.key !== increase) return;
        event.preventDefault();
        resizeSplitBoundary(
          seam.splitId,
          seam.index,
          event.key === increase ? KEYBOARD_RESIZE_STEP : -KEYBOARD_RESIZE_STEP,
        );
      }}
      style={{
        left: `${seam.left}%`,
        top: `${seam.top}%`,
        ...(horizontal ? { height: `${seam.height}%` } : { width: `${seam.width}%` }),
      }}
      // Straddles the seam so the grab target is comfortable while the line
      // itself stays hairline thin.
      className={`group absolute z-20 focus:outline-none ${
        horizontal
          ? "-translate-x-1/2 w-[9px] cursor-col-resize"
          : "-translate-y-1/2 h-[9px] cursor-row-resize"
      }`}
    >
      <span
        aria-hidden="true"
        className={`absolute bg-border transition-colors duration-150 group-hover:bg-ink/40 group-focus-visible:bg-ink/40 ${
          horizontal
            ? "inset-y-0 left-1/2 w-px -translate-x-1/2"
            : "inset-x-0 top-1/2 h-px -translate-y-1/2"
        }`}
      />
    </div>
  );
}

/** Live child sizes of a split, which the resize math reads on every move. */
function splitChildSizes(node: ChatPaneTree, splitId: string): number[] {
  if (isPane(node)) return [];
  if (node.id === splitId) return node.children.map((child) => child.size);
  for (const child of node.children) {
    const found = splitChildSizes(child.node, splitId);
    if (found.length > 0) return found;
  }
  return [];
}
