"use client";

import { X } from "lucide-react";
import { useAppData } from "@/components/AppDataProvider";
import { useChatPaneWorkspace } from "@/components/chat-panes/ChatPaneWorkspace";
import { Surface } from "@/components/Surface";
import type { ChatPaneNode } from "@/lib/chat-pane-layout";
import type { ChatSessionView } from "@/lib/chat-ui";
import { DEFAULT_MODEL } from "@/lib/model-options";

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
    chatDragProps,
    draggingChatId,
    flashingPaneId,
    focusPaneById,
    closePaneById,
    resolvePaneChatId,
    setPaneChatId,
  } = useChatPaneWorkspace();

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

  const title = initialChat?.title ?? chatSummary?.title ?? null;
  // A chat whose first turn has not landed has no conversation to file or
  // move yet, the same rule the sidebar applies to its optimistic rows.
  const draggableChatId =
    pane.chatId && data.openChats.some((chat) => chat.id === pane.chatId) ? pane.chatId : null;

  return (
    <section
      aria-label={title ? `Chat pane: ${title}` : "Empty chat pane"}
      data-chat-pane={pane.id}
      data-focused={focused ? "true" : undefined}
      onPointerDownCapture={() => focusPaneById(pane.id)}
      onFocusCapture={() => focusPaneById(pane.id)}
      className={`relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-canvas transition-opacity duration-150 ${
        // A chat already on screen recedes while it is dragged, so it reads as
        // about to move rather than about to open a second time.
        pane.chatId && draggingChatId === pane.chatId ? "opacity-50" : ""
      } ${
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
          {/* The title is the handle for rearranging panes: it drags the same
              chat payload as a sidebar row, so it can also be filed into a
              Project from here. */}
          <span
            {...(draggableChatId ? chatDragProps(draggableChatId) : {})}
            title={draggableChatId ? "Drag to move this pane" : undefined}
            className={`min-w-0 truncate text-[12.5px] ${draggableChatId ? "cursor-grab active:cursor-grabbing" : ""} ${
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
    </section>
  );
}
