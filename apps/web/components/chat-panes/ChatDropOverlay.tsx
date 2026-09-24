"use client";

import {
  ArrowLeftRight,
  type LucideIcon,
  PanelBottom,
  PanelLeft,
  PanelRight,
  PanelTop,
} from "lucide-react";
import { type DragEvent, useMemo, useState } from "react";
import { useAppData } from "@/components/AppDataProvider";
import { useChatPaneWorkspace } from "@/components/chat-panes/ChatPaneWorkspace";
import { draggedConversationId, isConversationDrag } from "@/components/SidebarProjects";
import {
  applyChatDrop,
  type ChatDropTarget,
  type ChatPaneLayout,
  chatDropTargetAt,
  chatPaneGeometry,
  findPane,
  findPaneIdByChatId,
  type PaneEdge,
  type PaneRect,
} from "@/lib/chat-pane-layout";

const EDGE_ICONS: Record<PaneEdge, LucideIcon> = {
  left: PanelLeft,
  right: PanelRight,
  top: PanelTop,
  bottom: PanelBottom,
};

const EDGE_WORDS: Record<PaneEdge, string> = {
  left: "left",
  right: "right",
  top: "above",
  bottom: "below",
};

/** A full-height column for the side edges, a full-width row for the others. */
const CANVAS_EDGE_SPAN: Record<PaneEdge, string> = {
  left: "full height",
  right: "full height",
  top: "full width",
  bottom: "full width",
};

function targetKey(target: ChatDropTarget | null) {
  if (!target) return "";
  return target.kind === "canvas" ? `canvas:${target.edge}` : `${target.paneId}:${target.zone}`;
}

function describeDrop(
  layout: ChatPaneLayout,
  target: ChatDropTarget,
  chatId: string,
): { label: string; Icon: LucideIcon | null } {
  const openPaneId = findPaneIdByChatId(layout.root, chatId);
  const verb = openPaneId ? "Move" : "Open";

  if (target.kind === "canvas") {
    return {
      label: `${verb} ${EDGE_WORDS[target.edge]}, ${CANVAS_EDGE_SPAN[target.edge]}`,
      Icon: EDGE_ICONS[target.edge],
    };
  }
  if (target.zone !== "center") {
    return { label: `${verb} ${EDGE_WORDS[target.zone]}`, Icon: EDGE_ICONS[target.zone] };
  }
  if (openPaneId === target.paneId) return { label: "Already open here", Icon: null };
  if (openPaneId) return { label: "Swap places", Icon: ArrowLeftRight };
  return findPane(layout.root, target.paneId)?.chatId
    ? { label: "Open here instead", Icon: null }
    : { label: "Open here", Icon: null };
}

/**
 * The drop surface for a chat being dragged onto the canvas.
 *
 * One surface over the whole canvas rather than one per pane, so a target can
 * be an outer edge of the workspace as well as a pane, and so the preview can
 * glide between targets instead of blinking from pane to pane.
 *
 * The preview is the layout the drop would produce, drawn in full as a map
 * over the canvas: the chat's new place is raised and labelled, and every
 * other pane is shown where it will end up. Releasing gives exactly what was
 * shown.
 */
export function ChatDropOverlay({
  chatId,
  narrow,
  focusedPaneId,
}: {
  chatId: string;
  /** A narrow canvas shows one pane, so a drop simply opens the chat in it. */
  narrow: boolean;
  focusedPaneId: string | undefined;
}) {
  const data = useAppData();
  const { layout, dropChat, endChatDrag } = useChatPaneWorkspace();
  const [target, setTarget] = useState<ChatDropTarget | null>(null);
  const geometry = useMemo(() => chatPaneGeometry(layout.root), [layout.root]);

  const targetAt = (event: DragEvent<HTMLElement>): ChatDropTarget | null => {
    if (narrow) {
      return focusedPaneId ? { kind: "pane", paneId: focusedPaneId, zone: "center" } : null;
    }
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return null;
    return chatDropTargetAt(
      layout,
      geometry,
      {
        x: ((event.clientX - box.left) / box.width) * 100,
        y: ((event.clientY - box.top) / box.height) * 100,
      },
      { width: box.width, height: box.height },
      chatId,
    );
  };

  const preview = useMemo(() => {
    if (!target) return null;
    const next = applyChatDrop(layout, target, chatId);
    const landingPaneId = findPaneIdByChatId(next.root, chatId);
    if (!landingPaneId) return null;
    const rects: PaneRect[] = narrow
      ? [{ paneId: landingPaneId, left: 0, top: 0, width: 100, height: 100 }]
      : chatPaneGeometry(next.root).panes;
    return {
      rects,
      landingPaneId,
      chatIdOf: (paneId: string) => findPane(next.root, paneId)?.chatId ?? null,
      ...describeDrop(layout, target, chatId),
    };
  }, [chatId, layout, narrow, target]);

  const titleOf = (id: string | null) => {
    if (!id) return "New chat";
    return (
      data.recentChats.find((chat) => chat.id === id)?.title ??
      data.openChats.find((chat) => chat.id === id)?.title ??
      "Chat"
    );
  };

  return (
    // Above the panes' own sticky chrome (which reaches z-40) so a drag can
    // always reach it. The caller only mounts it while a chat is being dragged,
    // so it never intercepts ordinary clicks.
    <div
      data-chat-drop-overlay=""
      onDragOver={(event) => {
        if (!isConversationDrag(event)) return;
        // preventDefault is what marks this surface as a valid drop target.
        event.preventDefault();
        const next = targetAt(event);
        // The browser's cursor badge matches what the drop does: a chat already
        // on screen moves, anything else opens another view of it.
        event.dataTransfer.dropEffect = findPaneIdByChatId(layout.root, chatId) ? "move" : "copy";
        setTarget((current) => (targetKey(current) === targetKey(next) ? current : next));
      }}
      onDragLeave={(event) => {
        // Leaving for one of the overlay's own children is not leaving.
        if (
          event.relatedTarget instanceof Node &&
          event.currentTarget.contains(event.relatedTarget)
        )
          return;
        setTarget(null);
      }}
      onDrop={(event) => {
        event.preventDefault();
        const dropTarget = targetAt(event);
        const droppedChatId = draggedConversationId(event);
        setTarget(null);
        endChatDrag();
        if (dropTarget && droppedChatId) dropChat(dropTarget, droppedChatId);
      }}
      // A drag whose source row unmounted mid-gesture (say, a chat that moved
      // into a Project) never gets its dragend. Browsers suppress pointer
      // events for the length of a real drag, so a press here means no drag is
      // in flight and the surface must stop covering the panes.
      onPointerDown={endChatDrag}
      className="absolute inset-0 z-50"
    >
      <div
        aria-hidden="true"
        className={`pointer-events-none absolute inset-0 bg-canvas transition-opacity duration-150 ${
          preview ? "opacity-100" : "opacity-0"
        }`}
      />
      {preview
        ? preview.rects.map((rect) => {
            const landing = rect.paneId === preview.landingPaneId;
            return (
              <div
                key={rect.paneId}
                aria-hidden="true"
                style={{
                  left: `${rect.left}%`,
                  top: `${rect.top}%`,
                  width: `${rect.width}%`,
                  height: `${rect.height}%`,
                }}
                className="pointer-events-none absolute p-1.5 transition-[left,top,width,height] duration-200 ease-out motion-reduce:transition-none"
              >
                {landing ? (
                  <div className="flex h-full w-full items-center justify-center rounded-lg bg-surface shadow-sm ring-2 ring-ink/25">
                    <div className="flex max-w-[85%] flex-col items-center gap-1.5 text-center">
                      {preview.Icon ? (
                        <preview.Icon size={18} strokeWidth={1.6} className="text-ink/60" />
                      ) : null}
                      <span className="text-[13px] font-medium text-ink">{preview.label}</span>
                      <span className="max-w-full truncate text-[12px] text-ink-subtle">
                        {titleOf(chatId)}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="flex h-full w-full items-center justify-center rounded-lg border border-ink/10 bg-surface-muted px-4">
                    <span className="max-w-full truncate text-[12px] text-ink-subtle">
                      {titleOf(preview.chatIdOf(rect.paneId))}
                    </span>
                  </div>
                )}
              </div>
            );
          })
        : null}
      <p role="status" className="sr-only">
        {preview ? `${preview.label}: ${titleOf(chatId)}` : ""}
      </p>
    </div>
  );
}
