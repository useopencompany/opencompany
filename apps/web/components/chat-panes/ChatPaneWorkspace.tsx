"use client";

import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAppData } from "@/components/AppDataProvider";
import { conversationDragProps, type SidebarRowDragProps } from "@/components/SidebarProjects";
import { useHydrated } from "@/components/useHydrated";
import {
  applyChatDrop,
  applyRoutedChat,
  type ChatDropTarget,
  type ChatPaneLayout,
  closePane,
  countPanes,
  createChatPaneLayout,
  findPane,
  findPaneIdByChatId,
  focusPane,
  MAX_CHAT_PANES,
  openPaneChatIds,
  type PaneEdge,
  pruneClosedChats,
  replacePaneChatId,
  resizeSplit,
  restoreOntoMountedPane,
  setPaneChat,
  splitPane,
} from "@/lib/chat-pane-layout";
import { persistChatPaneLayout, readStoredChatPaneLayout } from "@/lib/chat-pane-storage";
import {
  acceptedOptimisticChatIds,
  useOptimisticChatSummaries,
} from "@/lib/optimistic-chat-summaries";

const FLASH_DURATION_MS = 600;

type ChatPaneWorkspaceValue = {
  layout: ChatPaneLayout;
  paneCount: number;
  /** False once the pane cap is reached, so open-beside affordances can disable. */
  canSplit: boolean;
  /** Chat ids currently shown in a pane, for sidebar open-markers. */
  openChatIds: ReadonlySet<string>;
  /** The chat being dragged out of the sidebar, or null when no drag is in flight. */
  draggingChatId: string | null;
  /** Bumped on every drag start so the canvas can discard a stale drop preview. */
  dragVersion: number;
  flashingPaneId: string | null;
  /**
   * Makes an element drag `chatId`: into a sidebar Project to file it, or onto
   * the canvas to open or move it. Announces the drag so the canvas can raise
   * its drop surface.
   */
  chatDragProps: (chatId: string) => SidebarRowDragProps;
  endChatDrag: () => void;
  /** Opens or moves `chatId` to `target`; see `applyChatDrop`. */
  dropChat: (target: ChatDropTarget, chatId: string) => void;
  /** Keyboard/menu equivalent of dragging a chat to the focused pane's edge. */
  openChatBeside: (chatId: string, edge: PaneEdge) => void;
  focusPaneById: (paneId: string) => void;
  closePaneById: (paneId: string) => void;
  setPaneChatId: (paneId: string, chatId: string | null) => void;
  resolvePaneChatId: (optimisticId: string, durableId: string) => void;
  resizeSplitBoundary: (splitId: string, index: number, deltaPercent: number) => void;
};

const ChatPaneWorkspaceContext = createContext<ChatPaneWorkspaceValue | null>(null);

export function useChatPaneWorkspace() {
  const value = useContext(ChatPaneWorkspaceContext);
  if (!value) throw new Error("useChatPaneWorkspace must be used within ChatPaneWorkspaceProvider");
  return value;
}

/** Null outside the provider, for chrome that renders on surfaces without panes. */
export function useOptionalChatPaneWorkspace() {
  return useContext(ChatPaneWorkspaceContext);
}

/** The routes the pane canvas is mounted on; elsewhere the layout is held but idle. */
function isChatCanvasPath(pathname: string) {
  return pathname === "/" || pathname.startsWith("/chat/");
}

function routedChatIdOf(pathname: string): string | null {
  if (!pathname.startsWith("/chat/")) return null;
  const raw = pathname.slice("/chat/".length).split("/")[0];
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function chatPath(chatId: string | null) {
  return chatId ? `/chat/${encodeURIComponent(chatId)}` : "/";
}

/**
 * Owns the split-pane arrangement for one workspace.
 *
 * Mounted in the persistent app chrome rather than in the chat route, so the
 * arrangement survives a trip to Settings and so the sidebar — which is the
 * drag source — can read the same state the canvas renders.
 */
export function ChatPaneWorkspaceProvider({ children }: { children: ReactNode }) {
  const { workspace, openChats, recentChats, chatsReady } = useAppData();
  const workspaceId = workspace.id;
  const router = useRouter();
  const pathname = usePathname();
  const onCanvas = isChatCanvasPath(pathname);
  const routedChatId = routedChatIdOf(pathname);

  // The first render must match the server's, which cannot read localStorage:
  // a single pane holding the routed chat. The stored arrangement joins it on
  // the client's first commit.
  const [storedLayout, setStoredLayout] = useState<ChatPaneLayout>(() =>
    createChatPaneLayout(routedChatId),
  );
  const hydrated = useHydrated();

  // Restoring the stored arrangement, and resetting it on a workspace switch,
  // are the same move: adopt the layout this workspace should be showing. Doing
  // it during render (rather than in an effect) means the reader never sees a
  // frame of the wrong workspace's panes.
  const [restoredWorkspaceId, setRestoredWorkspaceId] = useState<string | null>(null);
  if (hydrated && restoredWorkspaceId !== workspaceId) {
    setRestoredWorkspaceId(workspaceId);
    const stored = readStoredChatPaneLayout(workspaceId);
    setStoredLayout((current) =>
      stored
        ? restoreOntoMountedPane(stored, routedChatId, current.focusedPaneId)
        : createChatPaneLayout(routedChatId),
    );
  }

  // Route -> layout, for deep links, back/forward and sidebar link clicks. The
  // previous value is state rather than a ref so the adjustment happens during
  // render, and `applyRoutedChat` is idempotent, so a route change this provider
  // caused itself settles instead of bouncing.
  const [syncedChatId, setSyncedChatId] = useState<string | null>(routedChatId);
  if (onCanvas && syncedChatId !== routedChatId) {
    setSyncedChatId(routedChatId);
    setStoredLayout((current) => applyRoutedChat(current, routedChatId));
  }

  const knownChatIds = useMemo(() => {
    // Once chatsReady is true, openChats is the authoritative set of every
    // conversation the reader can open. Recent chats also carries optimistic
    // rows that have not reached the live projection yet.
    const ids = new Set<string>();
    for (const chat of openChats) ids.add(chat.id);
    for (const chat of recentChats) ids.add(chat.id);
    return ids;
  }, [openChats, recentChats]);

  // Panes for chats the reader can no longer open are dropped as live chat data
  // arrives. Derived rather than written back, so a chat that reappears (an
  // unarchive, a slow first sync) brings its pane back with it.
  const layout = useMemo(
    () => pruneClosedChats(storedLayout, chatsReady ? knownChatIds : null, routedChatId),
    [chatsReady, knownChatIds, routedChatId, storedLayout],
  );

  useEffect(() => {
    // Before the stored layout is adopted, writing would overwrite it with the
    // single pane the first paint showed.
    if (restoredWorkspaceId !== workspaceId) return;
    persistChatPaneLayout(workspaceId, layout);
  }, [layout, restoredWorkspaceId, workspaceId]);

  /**
   * Applies a change to the layout the reader can actually see.
   *
   * Pruning is derived, so the state behind it can still hold panes that are no
   * longer rendered. Every action pins the pruned layout first, so pane counts,
   * the split cap and resize-boundary indices all mean the same thing to the
   * canvas and to the reducer.
   */
  const update = useCallback(
    (change: (layout: ChatPaneLayout) => ChatPaneLayout) => {
      setStoredLayout((current) =>
        change(pruneClosedChats(current, chatsReady ? knownChatIds : null, routedChatId)),
      );
    },
    [chatsReady, knownChatIds, routedChatId],
  );

  const focusedChatId = findPane(layout.root, layout.focusedPaneId)?.chatId ?? null;

  // A chat whose first message the API has not accepted yet exists only in this
  // tab. The chat route is server-rendered and redirects home for an id the API
  // cannot see, so putting the optimistic id in the URL races the send: when
  // the page fetch wins, the redirect empties the very pane that is sending and
  // the reader is bounced back to Home mid-turn. The same holds for a new chat
  // whose send failed, so routability is opt-in: a durable row, or acceptance.
  const optimisticChats = useOptimisticChatSummaries();
  const focusedChatRoutable =
    focusedChatId === null ||
    openChats.some((chat) => chat.id === focusedChatId) ||
    acceptedOptimisticChatIds(optimisticChats, workspaceId).has(focusedChatId);

  // Layout -> route. The focused pane owns the URL. `replace` keeps focusing a
  // pane the reader can already see out of the back stack; the history entries
  // that matter come from the sidebar's own link navigations.
  //
  // The URL only ever names a Conversation the server can render: a new chat
  // reaches it on the render after the API accepts its first message. Keyed on
  // the boolean rather than the optimistic set so the row reconciling later,
  // while that navigation is still in flight, does not request it a second time.
  useEffect(() => {
    if (!onCanvas || !focusedChatRoutable || focusedChatId === routedChatId) return;
    router.replace(chatPath(focusedChatId), { scroll: false });
  }, [focusedChatId, focusedChatRoutable, onCanvas, routedChatId, router]);

  const [draggingChatId, setDraggingChatId] = useState<string | null>(null);
  const [dragVersion, setDragVersion] = useState(0);
  const [flashingPaneId, setFlashingPaneId] = useState<string | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    },
    [],
  );

  const flashPane = useCallback((paneId: string) => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    setFlashingPaneId(paneId);
    flashTimerRef.current = setTimeout(() => {
      flashTimerRef.current = null;
      setFlashingPaneId(null);
    }, FLASH_DURATION_MS);
  }, []);

  const endChatDrag = useCallback(() => setDraggingChatId(null), []);

  // The state flip is deferred a tick because a synchronous re-render during
  // dragstart cancels the drag in some browsers before the drag image is
  // captured.
  const chatDragProps = useCallback(
    (chatId: string) =>
      conversationDragProps(chatId, {
        onDragStart: () => {
          setTimeout(() => {
            setDraggingChatId(chatId);
            setDragVersion((version) => version + 1);
          }, 0);
        },
        onDragEnd: endChatDrag,
      }),
    [endChatDrag],
  );

  const dropChat = useCallback(
    (target: ChatDropTarget, chatId: string) => {
      // A drop payload is user input. Only conversations the chat surface owns
      // can render in a pane, so anything else (a Task row, a stale drag) is
      // ignored rather than opening a pane that could never load.
      if (!knownChatIds.has(chatId)) return;
      update((current) => {
        const next = applyChatDrop(current, target, chatId);
        // Dropping a chat back where it already is changes nothing, so point
        // at it instead of leaving the drop looking ignored.
        const openPaneId = findPaneIdByChatId(current.root, chatId);
        if (openPaneId && next.root === current.root) flashPane(openPaneId);
        return next;
      });
    },
    [flashPane, knownChatIds, update],
  );

  const openChatBeside = useCallback(
    (chatId: string, edge: PaneEdge) => {
      update((current) => {
        const existingPaneId = findPaneIdByChatId(current.root, chatId);
        if (existingPaneId) {
          flashPane(existingPaneId);
          return focusPane(current, existingPaneId);
        }
        return splitPane(current, current.focusedPaneId, edge, chatId);
      });
      // The provider also lives on Settings and other non-chat routes so the
      // arrangement survives navigation. Opening beside from there should
      // reveal the canvas after the layout update has committed.
      if (!onCanvas) {
        setTimeout(() => router.push(chatPath(chatId), { scroll: false }), 0);
      }
    },
    [flashPane, onCanvas, router, update],
  );

  const focusPaneById = useCallback(
    (paneId: string) => update((current) => focusPane(current, paneId)),
    [update],
  );

  const closePaneById = useCallback(
    (paneId: string) => update((current) => closePane(current, paneId)),
    [update],
  );

  const setPaneChatId = useCallback(
    (paneId: string, chatId: string | null) =>
      update((current) => setPaneChat(current, paneId, chatId)),
    [update],
  );

  const resolvePaneChatId = useCallback(
    (optimisticId: string, durableId: string) =>
      update((current) => replacePaneChatId(current, optimisticId, durableId)),
    [update],
  );

  const resizeSplitBoundary = useCallback(
    (splitId: string, index: number, deltaPercent: number) =>
      update((current) => resizeSplit(current, splitId, index, deltaPercent)),
    [update],
  );

  const paneCount = countPanes(layout.root);
  const openChatIds = useMemo(() => new Set(openPaneChatIds(layout.root)), [layout.root]);

  const value = useMemo<ChatPaneWorkspaceValue>(
    () => ({
      layout,
      paneCount,
      canSplit: paneCount < MAX_CHAT_PANES,
      openChatIds,
      draggingChatId,
      dragVersion,
      flashingPaneId,
      chatDragProps,
      endChatDrag,
      dropChat,
      openChatBeside,
      focusPaneById,
      closePaneById,
      setPaneChatId,
      resolvePaneChatId,
      resizeSplitBoundary,
    }),
    [
      layout,
      paneCount,
      openChatIds,
      draggingChatId,
      dragVersion,
      flashingPaneId,
      chatDragProps,
      endChatDrag,
      dropChat,
      openChatBeside,
      focusPaneById,
      closePaneById,
      setPaneChatId,
      resolvePaneChatId,
      resizeSplitBoundary,
    ],
  );

  return (
    <ChatPaneWorkspaceContext.Provider value={value}>{children}</ChatPaneWorkspaceContext.Provider>
  );
}
