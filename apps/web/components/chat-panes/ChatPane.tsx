"use client";

import { X } from "lucide-react";
import { type DragEvent, useState } from "react";
import { useAppData } from "@/components/AppDataProvider";
import { useChatPaneWorkspace } from "@/components/chat-panes/ChatPaneWorkspace";
import { draggedConversationId, isConversationDrag } from "@/components/SidebarProjects";
import { Surface } from "@/components/Surface";
import type { ChatPaneNode, PaneEdge } from "@/lib/chat-pane-layout";
import type { ChatSessionView } from "@/lib/chat-ui";
import { DEFAULT_MODEL } from "@/lib/model-options";

/** Edges split the pane; `center` fills an empty pane without splitting it. */
type DropZone = PaneEdge | "center";

/**
 * The preview covers exactly the region the incoming chat will occupy, so what
 * the user sees before releasing is what they get after.
 */
const PREVIEW_CLASSES: Record<DropZone, string> = {
  left: "inset-y-0 left-0 w-1/2",
  right: "inset-y-0 right-0 w-1/2",
  top: "inset-x-0 top-0 h-1/2",
  bottom: "inset-x-0 bottom-0 h-1/2",
  center: "inset-0",
};

/**
 * Nearest-edge hit detection in pane-normalized coordinates, so the four drop
 * regions meet at the diagonals whatever the pane's aspect ratio. A tall narrow
 * pane and a short wide one both split where the user expects.
 */
function zoneFromPointer(event: DragEvent<HTMLElement>, splittable: boolean): DropZone {
  if (!splittable) return "center";
  const rect = event.currentTarget.getBoundingClientRect();
  const x = (event.clientX - rect.left) / Math.max(1, rect.width);
  const y = (event.clientY - rect.top) / Math.max(1, rect.height);
  const distances: [DropZone, number][] = [
    ["left", x],
    ["right", 1 - x],
    ["top", y],
    ["bottom", 1 - y],
  ];
  return distances.reduce((best, entry) => (entry[1] < best[1] ? entry : best))[0];
}

export function ChatPane({
  pane,
  focused,
  showHeader,
  routeInitialChat,
  newChatProjectId,
  newChatProjectName,
}: {
  pane: ChatPaneNode;
  focused: boolean;
  /** Pane chrome only appears in split mode; a lone pane looks like plain chat. */
  showHeader: boolean;
  routeInitialChat: ChatSessionView | null;
  newChatProjectId: string | null;
  newChatProjectName: string | null;
}) {
  const data = useAppData();
  const {
    canSplit,
    draggingChatId,
    dragVersion,
    endChatDrag,
    flashingPaneId,
    focusPaneById,
    closePaneById,
    dropChatIntoPane,
    resolvePaneChatId,
    setPaneChatId,
  } = useChatPaneWorkspace();

  const [hover, setHover] = useState<{ dragVersion: number; zone: DropZone } | null>(null);
  const hoverZone = draggingChatId && hover?.dragVersion === dragVersion ? hover.zone : null;

  const chatSummary = pane.chatId
    ? (data.recentChats.find((chat) => chat.id === pane.chatId) ??
      data.openChats.find((chat) => chat.id === pane.chatId) ??
      null)
    : null;

  // The routed chat can be newer than the sidebar's list, so the server-loaded
  // record wins for that pane.
  const initialChat: ChatSessionView | null =
    pane.chatId && routeInitialChat?.id === pane.chatId
      ? routeInitialChat
      : chatSummary?.engine
        ? {
            id: chatSummary.id,
            title: chatSummary.title,
            model: chatSummary.model,
            engine: chatSummary.engine,
            codexComposerSettings: chatSummary.codexComposerSettings ?? null,
            // Sidebar summaries can bridge navigation metadata, but detail controls
            // wait for the conversation-scoped REST/Electric record.
            runtime: null,
            ...(chatSummary.activityState ? { activityState: chatSummary.activityState } : {}),
            ...(chatSummary.hasUnseen !== undefined ? { hasUnseen: chatSummary.hasUnseen } : {}),
            updatedAt: chatSummary.updatedAt,
            messages: [],
          }
        : null;

  // A pane holding a chat splits; an empty one is filled in place. At the pane
  // cap an occupied pane can still be taken over, which keeps every pane a
  // valid drop target instead of dead-ending the drag.
  const splittable = Boolean(pane.chatId) && canSplit;

  const handleDragOver = (event: DragEvent<HTMLElement>) => {
    if (!isConversationDrag(event)) return;
    // preventDefault is what marks this surface as a valid drop target.
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    const zone = zoneFromPointer(event, splittable);
    setHover((current) =>
      current?.dragVersion === dragVersion && current.zone === zone
        ? current
        : { dragVersion, zone },
    );
  };

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    const zone = zoneFromPointer(event, splittable);
    setHover(null);
    endChatDrag();
    const chatId = draggedConversationId(event);
    if (chatId) dropChatIntoPane(pane.id, zone, chatId);
  };

  const title = initialChat?.title ?? chatSummary?.title ?? null;

  return (
    <section
      aria-label={title ? `Chat pane: ${title}` : "Empty chat pane"}
      data-chat-pane={pane.id}
      data-focused={focused ? "true" : undefined}
      onPointerDownCapture={() => focusPaneById(pane.id)}
      onFocusCapture={() => focusPaneById(pane.id)}
      className={`relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-canvas ${
        flashingPaneId === pane.id
          ? "ring-2 ring-ink/40 ring-inset"
          : showHeader && focused
            ? "ring-1 ring-ink/15 ring-inset"
            : ""
      }`}
    >
      {showHeader ? (
        // Which pane is focused decides where Cmd/Ctrl+K, Escape and the URL
        // go, so the unfocused ones recede rather than the focused one shouting.
        <header
          className={`flex h-9 shrink-0 items-center justify-between gap-2 border-border border-b px-3 ${
            focused ? "bg-canvas" : "bg-surface-subtle"
          }`}
        >
          <span
            className={`min-w-0 truncate text-[12.5px] ${
              focused ? "font-medium text-ink" : "text-ink-subtle"
            }`}
          >
            {title ?? <span className="font-normal text-ink-subtle">New chat</span>}
          </span>
          <button
            type="button"
            title="Close pane"
            aria-label={title ? `Close pane: ${title}` : "Close empty pane"}
            onClick={() => closePaneById(pane.id)}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink/50 transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            <X size={13} strokeWidth={1.8} />
          </button>
        </header>
      ) : null}

      <Surface
        tasks={data.tasks}
        allTasks={data.allTasks}
        defaultModel={DEFAULT_MODEL}
        initialChat={initialChat}
        newChatProjectId={focused ? newChatProjectId : null}
        newChatProjectName={focused ? newChatProjectName : null}
        userFirstName={data.user.firstName}
        recentChats={data.recentChats}
        archivedChats={data.archivedChats}
        codexConnected={data.codexConnected}
        claudeCodeConnected={data.claudeCodeConnected}
        sharedModelAccessEnabled={data.sharedModelAccessEnabled}
        autoModelRoutingEnabled={data.featureFlags.autoModelRouting}
        workspaceId={data.workspace.id}
        userWorkosId={data.user.workosUserId}
        isActivePane={focused}
        onActivate={() => focusPaneById(pane.id)}
        onOpenChat={(chat) => setPaneChatId(pane.id, chat?.id ?? null)}
        // Only a split workspace detaches instead of closing. A lone pane keeps
        // Surface's own Escape behaviour, where closing the chat also stops the
        // turn it is running — there is no other view of that turn to keep.
        {...(showHeader ? { onClosePane: () => closePaneById(pane.id) } : {})}
        onConversationResolved={({ optimisticId, durableId }) =>
          resolvePaneChatId(optimisticId, durableId)
        }
      />

      {draggingChatId ? (
        // Above the pane's own sticky chrome (which reaches z-40) so a drag can
        // always reach the drop surface, and only mounted while dragging so it
        // never intercepts ordinary clicks.
        <div className="pointer-events-none absolute inset-0 z-50">
          {hoverZone ? (
            <div
              className={`absolute rounded-sm bg-ink/10 ring-2 ring-ink/35 ring-inset ${PREVIEW_CLASSES[hoverZone]}`}
            />
          ) : null}
          <div
            data-chat-pane-dropzone={pane.id}
            onDragOver={handleDragOver}
            onDragLeave={() => setHover(null)}
            onDrop={handleDrop}
            className="pointer-events-auto absolute inset-0"
          />
        </div>
      ) : null}
    </section>
  );
}
