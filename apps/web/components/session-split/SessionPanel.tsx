"use client";

import { X } from "lucide-react";
import { type CSSProperties, type DragEvent, useState } from "react";
import {
  type LayoutAction,
  type PanelNode,
  type SplitTarget,
  TabPanel,
  useLayout,
} from "react-splitkit";
import {
  countPanes,
  findPanelIdBySessionId,
  isSessionDrag,
  panelSession,
  readSessionDragPayload,
  type SessionTabMeta,
  sessionTab,
} from "@/types/session-layout";
import { useSessionDrag } from "./SessionDragContext";

/** Edge zones split the pane; `center` assigns to an empty leaf. */
type DropZone = SplitTarget | "center";

/**
 * Drop preview: exactly the half the new pane will occupy after the split
 * (full pane when assigning to an empty leaf). Decoupled from hit detection
 * so the highlight matches the drop outcome.
 */
const PREVIEW_CLASSES: Record<DropZone, string> = {
  left: "inset-y-0 left-0 w-1/2",
  right: "inset-y-0 right-0 w-1/2",
  top: "inset-x-0 top-0 h-1/2",
  bottom: "inset-x-0 bottom-0 h-1/2",
  center: "inset-0",
};

export function SessionPanel({
  panel,
  style,
  showHeaderWhenSingle = true,
}: {
  panel: PanelNode;
  style: CSSProperties;
  /**
   * When false, the pane header only appears in split mode — so a single pane
   * looks exactly like the non-split app (the content brings its own chrome).
   */
  showHeaderWhenSingle?: boolean;
}) {
  const { layout, dispatch } = useLayout();
  const { dragging, dragVersion, endDrag, flashPanelId, flashPanel } = useSessionDrag();
  const [hoverPreview, setHoverPreview] = useState<{
    dragVersion: number;
    zone: DropZone;
  } | null>(null);

  const session = panelSession(panel);
  const isLastPane = countPanes(layout) === 1;
  const flashing = flashPanelId === panel.id;
  const hoverZone =
    dragging && hoverPreview?.dragVersion === dragVersion ? hoverPreview.zone : null;

  // Nearest-edge detection from the pointer position (VS Code style): the whole
  // pane is one drop surface, split toward whichever edge the cursor is closest
  // to (in pane-normalized coordinates, so the four regions are fair triangles).
  // An empty leaf is always `center` (assign, no split).
  const zoneFromPointer = (event: DragEvent<HTMLDivElement>): DropZone => {
    if (!session) return "center";
    const rect = event.currentTarget.getBoundingClientRect();
    const rx = (event.clientX - rect.left) / Math.max(1, rect.width);
    const ry = (event.clientY - rect.top) / Math.max(1, rect.height);
    let zone: DropZone = "left";
    let best = rx;
    if (1 - rx < best) {
      zone = "right";
      best = 1 - rx;
    }
    if (ry < best) {
      zone = "top";
      best = ry;
    }
    if (1 - ry < best) {
      zone = "bottom";
    }
    return zone;
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!isSessionDrag(event.dataTransfer)) return;
    // preventDefault marks the surface as a valid drop target.
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    const zone = zoneFromPointer(event);
    setHoverPreview((current) =>
      current?.dragVersion === dragVersion && current.zone === zone
        ? current
        : { dragVersion, zone },
    );
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setHoverPreview(null);
    endDrag();

    const payload = readSessionDragPayload(event.dataTransfer);
    if (!payload) return;

    // Already open in some pane → flash it instead of opening a duplicate.
    const existingPanelId = findPanelIdBySessionId(layout, payload.sessionId);
    if (existingPanelId) {
      flashPanel(existingPanelId);
      return;
    }

    dispatch(dropAction(panel, session, zoneFromPointer(event), payload));
  };

  return (
    <div
      // `style` carries react-splitkit's flex sizing for this pane (library
      // contract — the only inline styles in the layer). Everything else is
      // Tailwind.
      style={style}
      className={`relative bg-canvas transition-shadow duration-150 ${
        flashing ? "ring-2 ring-accent ring-inset" : ""
      }`}
    >
      {showHeaderWhenSingle || !isLastPane ? (
        <PanelHeader
          title={session?.sessionName ?? null}
          closable={!isLastPane}
          onClose={() => dispatch({ type: "REMOVE_PANEL", panelId: panel.id })}
        />
      ) : null}

      {session ? (
        <TabPanel panelId={panel.id} className="flex flex-col" />
      ) : (
        <div className="flex flex-1 items-center justify-center p-6 text-[13px] text-ink-subtle">
          Drop a session here
        </div>
      )}

      {dragging ? (
        // z-50: above everything inside the pane (SessionView's sticky chrome
        // goes up to z-40), so drags always reach the drop surface.
        <div className="pointer-events-none absolute inset-0 z-50">
          {hoverZone ? (
            <div
              className={`absolute bg-accent/10 ring-1 ring-accent/40 ring-inset ${PREVIEW_CLASSES[hoverZone]}`}
            />
          ) : null}
          <div
            onDragOver={handleDragOver}
            onDragLeave={() => setHoverPreview(null)}
            onDrop={handleDrop}
            className="pointer-events-auto absolute inset-0"
          />
        </div>
      ) : null}
    </div>
  );
}

function dropAction(
  panel: PanelNode,
  session: SessionTabMeta | null,
  zone: DropZone,
  payload: SessionTabMeta,
): LayoutAction {
  const tab = sessionTab({ id: payload.sessionId, name: payload.sessionName });
  if (!session) {
    // Empty leaf: assign the session in place, no split.
    return { type: "ADD_TAB", panelId: panel.id, tab, activate: true };
  }
  // Occupied pane: split toward the nearest edge, 50/50 (reducer default).
  // `center` only occurs for empty leaves, so the fallback is unreachable.
  const target = zone === "center" ? "right" : zone;
  return { type: "SPLIT_PANEL", panelId: panel.id, target, newTabs: [tab] };
}

function PanelHeader({
  title,
  closable,
  onClose,
}: {
  title: string | null;
  closable: boolean;
  onClose: () => void;
}) {
  return (
    <div className="flex h-10 shrink-0 items-center justify-between border-border border-b px-3">
      <span className="min-w-0 truncate font-medium text-[13px] text-ink">
        {title ?? <span className="font-normal text-ink-subtle">Empty pane</span>}
      </span>
      {closable ? (
        <button
          type="button"
          title="Close pane"
          aria-label={title ? `Close ${title}` : "Close pane"}
          onClick={onClose}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        >
          <X size={13} strokeWidth={1.8} />
        </button>
      ) : null}
    </div>
  );
}
