"use client";

import { isSettledTaskStatus } from "@opencompany/core/tasks";
import { Popover, PopoverContent, PopoverTrigger } from "@opencompany/ui/components/popover";
import { toast } from "@opencompany/ui/components/sonner";
import type { LucideIcon } from "lucide-react";
import {
  Archive,
  BookOpen,
  Bot,
  Check,
  ChevronsUpDown,
  Inbox,
  ListTodo,
  Loader2,
  LogOut,
  Navigation,
  PanelLeft,
  Pin,
  Plus,
  Puzzle,
  ScrollText,
  Settings,
  Sparkles,
  SplitSquareHorizontal,
  SplitSquareVertical,
  Workflow,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  type DragEvent,
  type FormEvent,
  type MouseEventHandler,
  useEffect,
  useId,
  useMemo,
  useState,
  useTransition,
} from "react";
import { useAppData } from "@/components/AppDataProvider";
import { SidebarBots } from "@/components/Bots";
import { ChatStateIndicator } from "@/components/ChatStateIndicator";
import { useOptionalChatPaneWorkspace } from "@/components/chat-panes/ChatPaneWorkspace";
import { IntentPrefetchLink } from "@/components/IntentPrefetchLink";
import { PullRequestBadge } from "@/components/PullRequestBadge";
import { SidebarFeedback } from "@/components/SidebarFeedback";
import {
  conversationDragProps,
  draggedConversationId,
  isConversationDrag,
  SidebarProjects,
  type SidebarRowDragProps,
  useSidebarProjects,
  useSidebarRowPadding,
} from "@/components/SidebarProjects";
import { SidebarSectionHeader, useCollapsedSidebarSection } from "@/components/SidebarSection";
import { SidebarWikis, useSidebarWikis } from "@/components/SidebarWikis";
import { HOME_NAVIGATION_EVENT, requestChatComposerFocus } from "@/lib/chat-navigation";
import { clearLocalChatState, useLocalChatStates } from "@/lib/chat-session-state";
import { type ChatSummaryView, chatSummaryState } from "@/lib/chat-ui";
import { preloadHeadlessChatMessages } from "@/lib/headless-chat-collections";
import { updateHeadlessChatConversation } from "@/lib/headless-chat-commands";
import { archiveHeadlessTask } from "@/lib/headless-task-commands";
import {
  archiveConversationOptimistically,
  restoreOptimisticArchive,
} from "@/lib/optimistic-archives";
import { useOptimisticChatSummaries } from "@/lib/optimistic-chat-summaries";
import type { SessionPullRequest } from "@/lib/session-pull-requests";
import {
  orderSidebarWorkItems,
  type SidebarTaskView,
  type SidebarWorkItem,
} from "@/lib/sidebar-items";
import { useSessionPullRequests } from "@/lib/use-session-pull-requests";
import { activeWikiSlugFromPathname } from "@/lib/wiki-routes";
import { createWorkspaceAction, switchWorkspaceAction } from "@/lib/workspace-actions";

function Icon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 100 100"
      fill="none"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M89.5 50C89.5 28.1848 71.8152 10.5 50 10.5C28.1848 10.5 10.5 28.1848 10.5 50C10.5 71.8152 28.1848 89.5 50 89.5C71.8152 89.5 89.5 71.8152 89.5 50ZM94.5 50C94.5 74.5767 74.5767 94.5 50 94.5C25.4233 94.5 5.5 74.5767 5.5 50C5.5 25.4233 25.4233 5.5 50 5.5C74.5767 5.5 94.5 25.4233 94.5 50Z"
        fill="currentColor"
      />
      <path
        d="M64.5 50C64.5 38.6418 62.6316 28.4743 59.7031 21.2393C58.2363 17.6154 56.5523 14.8494 54.8105 13.0293C53.0749 11.2156 51.4494 10.5 50 10.5C48.5506 10.5 46.9251 11.2156 45.1895 13.0293C43.4477 14.8494 41.7637 17.6154 40.2969 21.2393C37.3684 28.4743 35.5 38.6418 35.5 50C35.5 61.3582 37.3684 71.5257 40.2969 78.7607C41.7637 82.3846 43.4477 85.1506 45.1895 86.9707C46.9251 88.7844 48.5506 89.5 50 89.5C51.4494 89.5 53.0749 88.7844 54.8105 86.9707C56.5523 85.1506 58.2363 82.3846 59.7031 78.7607C62.6316 71.5257 64.5 61.3582 64.5 50ZM69.5 50C69.5 61.8377 67.5622 72.6708 64.3379 80.6367C62.7285 84.6129 60.7495 87.9973 58.4238 90.4277C56.0918 92.8646 53.245 94.5 50 94.5C46.755 94.5 43.9082 92.8646 41.5762 90.4277C39.2505 87.9973 37.2715 84.6129 35.6621 80.6367C32.4378 72.6708 30.5 61.8377 30.5 50C30.5 38.1623 32.4378 27.3292 35.6621 19.3633C37.2715 15.3871 39.2505 12.0027 41.5762 9.57227C43.9082 7.13535 46.755 5.5 50 5.5C53.245 5.5 56.0918 7.13535 58.4238 9.57227C60.7495 12.0027 62.7285 15.3871 64.3379 19.3633C67.5622 27.3292 69.5 38.1623 69.5 50Z"
        fill="currentColor"
      />
      <path
        d="M92 47.5C93.3807 47.5 94.5 48.6193 94.5 50C94.5 51.3807 93.3807 52.5 92 52.5H8C6.61929 52.5 5.5 51.3807 5.5 50C5.5 48.6193 6.61929 47.5 8 47.5H92Z"
        fill="currentColor"
      />
      <path
        d="M50 28C52 40.6667 59.3333 48 72 50C59.3333 52 52 59.3333 50 72C48 59.3333 40.6667 52 28 50C40.6667 48 48 40.6667 50 28Z"
        fill="currentColor"
      />
    </svg>
  );
}

function SidebarNavRow({
  href,
  icon: Icon,
  iconClassName,
  label,
  active,
  // A row highlights for its whole subtree, but only one element on a page can be the current
  // one. The Tasks row hands that claim to the task it lists when the reader is inside a task.
  current = active,
  count,
  onClick,
}: {
  href: string;
  icon: LucideIcon;
  iconClassName?: string;
  label: string;
  active: boolean;
  current?: boolean;
  count?: number;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
}) {
  return (
    <IntentPrefetchLink
      href={href}
      {...(onClick ? { onClick } : {})}
      aria-current={current ? "page" : undefined}
      className={`group flex w-full items-center gap-2.5 rounded-md px-2 py-[5px] text-left text-[13px] transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
        active ? "bg-surface-active text-ink" : "text-ink/90 hover:bg-surface-hover hover:text-ink"
      }`}
    >
      <Icon
        size={14}
        strokeWidth={1.75}
        className={`shrink-0 ${active ? "text-ink" : "text-ink/60 group-hover:text-ink/80"}${
          iconClassName ? ` ${iconClassName}` : ""
        }`}
      />
      <span className="truncate tracking-[-0.005em]">{label}</span>
      {count ? (
        <span className="ml-auto shrink-0 text-[12px] tabular-nums leading-none text-ink-subtle">
          {count}
        </span>
      ) : null}
    </IntentPrefetchLink>
  );
}

export function Sidebar({
  collapsed,
  onToggleCollapsed,
  showCollapseButton = true,
}: {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  showCollapseButton?: boolean;
}) {
  const { featureFlags, reviewCount, sidebarTasks, user } = useAppData();
  const wikis = useSidebarWikis();
  const pathname = usePathname();
  const homeActive = pathname === "/";
  const reviewActive = pathname === "/review";
  const tasksActive = pathname === "/tasks" || pathname.startsWith("/tasks/");
  // The Tasks row hands the current-page claim to the Task's own row, but only when the list
  // actually holds one: an older or archived Task has no row, and the page still has to say where
  // the reader is.
  const openTaskHasRow = sidebarTasks.some((task) =>
    isTaskRouteActive(pathname, taskHref(task.displayId)),
  );
  const workflowsActive = pathname === "/workflows" || pathname.startsWith("/workflows/");
  const agentsActive = pathname === "/agents" || pathname.startsWith("/agents/");
  // `/wiki/sources` and `/wiki/import` are static routes under /wiki, not wikis, so neither marks
  // a row as current. Bare `/wiki` redirects, so it is only ever in flight.
  const activeWikiSlug = activeWikiSlugFromPathname(pathname);
  const pluginsActive = pathname === "/plugins" || pathname.startsWith("/plugins/");
  const skillsActive = pathname === "/skills" || pathname.startsWith("/skills/");

  return (
    <aside
      className={`relative h-full shrink-0 overflow-hidden bg-sidebar transition-[width] duration-200 ease-out ${
        collapsed ? "w-0" : "w-[256px]"
      }`}
      aria-hidden={collapsed}
    >
      <div className="flex h-full w-[256px] flex-col">
        {/* Header controls */}
        <div className="flex items-center gap-1 px-2 pb-2 pt-3">
          {showCollapseButton ? (
            <button
              type="button"
              aria-label="Collapse sidebar"
              aria-expanded={!collapsed}
              onClick={onToggleCollapsed}
              className="shrink-0 rounded-md p-1.5 text-ink/60 transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
            >
              <PanelLeft size={15} strokeWidth={1.75} />
            </button>
          ) : null}
          <div className="min-w-0 flex-1">
            <WorkspaceSwitcher />
          </div>
        </div>

        {/* Primary nav */}
        <nav aria-label="opencompany primary" className="flex flex-col gap-px px-2 pt-2">
          <SidebarNavRow
            href="/"
            icon={Navigation}
            // The only clean paper-plane outline in the set; turned so it points down at the
            // composer this row opens.
            iconClassName="rotate-[25deg]"
            label="New Chat"
            active={homeActive}
            onClick={(event) => {
              if (
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              ) {
                return;
              }
              window.dispatchEvent(new Event(HOME_NAVIGATION_EVENT));
            }}
          />
          {featureFlags.reviewInbox ? (
            <SidebarNavRow
              href="/review"
              icon={Inbox}
              label="For review"
              active={reviewActive}
              count={reviewCount}
            />
          ) : null}
          <SidebarNavRow
            href="/tasks"
            icon={ListTodo}
            label="Tasks"
            active={tasksActive}
            current={tasksActive && !openTaskHasRow}
          />
          <SidebarNavRow
            href="/workflows"
            icon={Workflow}
            label="Workflows"
            active={workflowsActive}
          />
          {featureFlags.companyAgents ? (
            <SidebarNavRow href="/agents" icon={Bot} label="Company Agents" active={agentsActive} />
          ) : null}
        </nav>

        {/* Wiki: knowledge before agents */}
        <div className="pt-4">
          <SidebarWikis
            state={wikis}
            activeWikiSlug={activeWikiSlug}
            currentUserWorkosId={user.workosUserId}
          />
        </div>

        <SidebarBots />

        {/* Recents */}
        <SidebarWorkList />

        {/* Account / settings footer */}
        <div className="px-2 pb-3 pt-2">
          <SidebarNavRow href="/plugins" icon={Puzzle} label="Plugins" active={pluginsActive} />
          <SidebarNavRow href="/skills" icon={Sparkles} label="Skills" active={skillsActive} />
          <SidebarFeedback />
          <SidebarAccountMenu />
        </div>
      </div>
    </aside>
  );
}

function AccountAvatar({
  avatarUrl,
  initials,
  className,
}: {
  avatarUrl: string | null;
  initials: string;
  className?: string;
}) {
  if (avatarUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={avatarUrl}
        alt=""
        className={`shrink-0 rounded-full bg-surface-muted object-cover ${className ?? ""}`}
      />
    );
  }
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-full bg-surface-muted font-semibold text-ink ${className ?? ""}`}
    >
      {initials}
    </span>
  );
}

function SidebarAccountMenu() {
  const { user, plan } = useAppData();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  const displayName = name || user.email;
  const initials = getInitials(user.firstName, user.lastName, user.email);
  const planLabel = plan === "pro" ? "Pro plan" : "Hobby plan";
  const settingsActive = pathname === "/settings" || pathname.startsWith("/settings/");
  const changelogActive = pathname === "/changelog";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        type="button"
        aria-label={`Account menu for ${displayName}`}
        className="group flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors duration-150 hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 data-[popup-open]:bg-surface-active"
      >
        <AccountAvatar
          avatarUrl={user.avatarUrl}
          initials={initials}
          className="h-6 w-6 text-[10.5px]"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-medium leading-tight text-ink">
            {displayName}
          </span>
          <span className="block truncate text-[11px] leading-tight text-ink-subtle">
            {planLabel}
          </span>
        </span>
        <ChevronsUpDown
          size={13}
          strokeWidth={1.75}
          className="shrink-0 text-ink/45 transition-colors duration-150 group-hover:text-ink/70"
        />
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        className="w-[240px] bg-surface p-1 text-ink"
      >
        <div className="flex items-center gap-2.5 px-2 py-2">
          <AccountAvatar
            avatarUrl={user.avatarUrl}
            initials={initials}
            className="h-8 w-8 text-[12px]"
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium leading-tight text-ink">
              {displayName}
            </span>
            {displayName !== user.email ? (
              <span className="mt-0.5 block truncate text-[11.5px] leading-tight text-ink-subtle">
                {user.email}
              </span>
            ) : null}
            <span className="mt-0.5 block truncate text-[11.5px] leading-tight text-ink-subtle">
              {planLabel}
            </span>
          </span>
        </div>
        <div className="my-1 h-px bg-border" />
        <Link
          href="/settings"
          prefetch
          onClick={() => setOpen(false)}
          aria-current={settingsActive ? "page" : undefined}
          className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] text-ink/90 transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        >
          <Settings size={14} strokeWidth={1.75} className="shrink-0 text-ink/60" />
          <span className="truncate tracking-[-0.005em]">Settings</span>
        </Link>
        <Link
          href="/changelog"
          prefetch
          onClick={() => setOpen(false)}
          aria-current={changelogActive ? "page" : undefined}
          className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] text-ink/90 transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        >
          <ScrollText size={14} strokeWidth={1.75} className="shrink-0 text-ink/60" />
          <span className="truncate tracking-[-0.005em]">Changelog</span>
        </Link>
        <a
          href="https://docs.opencompany.cloud"
          target="_blank"
          rel="noreferrer noopener"
          onClick={() => setOpen(false)}
          className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] text-ink/90 transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        >
          <BookOpen size={14} strokeWidth={1.75} className="shrink-0 text-ink/60" />
          <span className="truncate tracking-[-0.005em]">Docs</span>
        </a>
        <a
          href="/auth/sign-out"
          onClick={() => setOpen(false)}
          className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] text-ink/90 transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        >
          <LogOut size={14} strokeWidth={1.75} className="shrink-0 text-ink/60" />
          <span className="truncate tracking-[-0.005em]">Sign out</span>
        </a>
      </PopoverContent>
    </Popover>
  );
}

const RECENTS_LIST_ID = "sidebar-recents";
// Predates the shared section store, so the key keeps its original name and the reader's
// remembered choice survives.
const RECENTS_COLLAPSED_STORAGE_KEY = "goat-sidebar-recents-collapsed";

function SidebarWorkList() {
  const panes = useOptionalChatPaneWorkspace();
  const { featureFlags, openChats, openSidebarTasks, recentChats, sidebarTasks, workspace } =
    useAppData();
  const { collapsed: recentsCollapsed, toggle: toggleRecents } = useCollapsedSidebarSection(
    RECENTS_COLLAPSED_STORAGE_KEY,
  );
  const projects = useSidebarProjects(featureFlags.sidebarProjects);
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [, startTransition] = useTransition();
  const localChatStates = useLocalChatStates();
  const pullRequests = useSessionPullRequests();
  const optimisticChats = useOptimisticChatSummaries();
  const optimisticChatIds = useMemo(
    () =>
      new Set(
        optimisticChats
          .filter((entry) => entry.workspaceId === workspace.id)
          .map((entry) => entry.chat.id),
      ),
    [optimisticChats, workspace.id],
  );
  const [pinningIds, setPinningIds] = useState<Set<string>>(() => new Set());
  const [pinOverrides, setPinOverrides] = useState<Map<string, boolean>>(() => new Map());
  const [previousRecentChats, setPreviousRecentChats] = useState(recentChats);

  useEffect(() => {
    for (const chat of recentChats) {
      // The optimistic state only bridges the gap until the durable projection reports a live run.
      // `awaiting_input` is one of those reports, so it hands off the same way `working` does —
      // otherwise a chat that parks on an approval mid-stream never drops its local spinner.
      if (localChatStates.get(chat.id) !== "working") continue;
      const state = chatSummaryState(chat);
      if (state === "working" || state === "awaiting_input") {
        clearLocalChatState(chat.id, "working");
      }
    }
  }, [localChatStates, recentChats]);

  if (previousRecentChats !== recentChats) {
    setPreviousRecentChats(recentChats);
    setPinOverrides((current) => reconcilePinOverrides(current, recentChats));
  }

  const isPinned = (chat: ChatSummaryView) => pinOverrides.get(chat.id) ?? Boolean(chat.pinnedAt);
  // A conversation lives in exactly one place in the sidebar. Once it is filed under a Project,
  // that folder is its home and it leaves Pinned and Recents, so the reader never has to work out
  // which of two copies of a row is the real one.
  const filedInProject = (conversationId: string) => projects.membership.has(conversationId);
  const pinnedChats = recentChats.filter((chat) => isPinned(chat) && !filedInProject(chat.id));
  const workItems = orderSidebarWorkItems({
    chats: recentChats.filter((chat) => !isPinned(chat) && !filedInProject(chat.id)),
    tasks: sidebarTasks.filter((task) => !filedInProject(task.conversationId)),
  });

  // The row goes on the click. The write and the projection behind it take about a second, and
  // holding a chat the user has already dismissed for that long reads as lag; a failed write puts
  // the row back and says so.
  const archiveChat = (chatId: string, chatTitle: string, href: string) => {
    if (!archiveConversationOptimistically(chatId)) return;
    // If we archived the chat we're currently viewing, drop back to home.
    if (pathname === href) {
      router.push("/");
    }
    startTransition(async () => {
      try {
        await updateHeadlessChatConversation(chatId, { archived: true });
      } catch {
        restoreOptimisticArchive(chatId);
        toast.error(`Could not archive "${chatTitle}".`);
      }
    });
  };

  // Same deal for a Task, hidden by its conversation because that is the key the archive store
  // and the review queue share: one click empties the row from both lists.
  const archiveTask = (task: SidebarTaskView, href: string) => {
    if (!archiveConversationOptimistically(task.conversationId)) return;
    // If we archived the task we're currently viewing, fall back to the board.
    if (isTaskRouteActive(pathname, href)) {
      router.push("/tasks");
    }
    startTransition(async () => {
      try {
        await archiveHeadlessTask(task.id, { scopeKey: workspace.id });
      } catch {
        restoreOptimisticArchive(task.conversationId);
        toast.error(`Could not archive "${task.name}".`);
      }
    });
  };

  const togglePin = (chatId: string, chatTitle: string, currentlyPinned: boolean) => {
    if (pinningIds.has(chatId)) return;
    const desiredPinned = !currentlyPinned;
    setPinOverrides((current) => new Map(current).set(chatId, desiredPinned));
    setPinningIds((current) => new Set(current).add(chatId));
    startTransition(async () => {
      try {
        await updateHeadlessChatConversation(chatId, { pinned: desiredPinned });
      } catch {
        setPinOverrides((current) => {
          const next = new Map(current);
          next.delete(chatId);
          return next;
        });
        toast.error(
          currentlyPinned ? `Could not unpin "${chatTitle}".` : `Could not pin "${chatTitle}".`,
        );
      } finally {
        setPinningIds((current) => {
          const next = new Set(current);
          next.delete(chatId);
          return next;
        });
      }
    });
  };

  // A chat row drags into a Project to file it, or onto the chat canvas to open
  // it in a pane. The pane workspace is told about the drag so every pane can
  // raise its drop surface, and the state flip is deferred a tick because a
  // synchronous re-render during dragstart cancels the drag in some browsers
  // before the drag image is captured.
  const chatRowDragProps = (conversationId: string): SidebarRowDragProps =>
    conversationDragProps(conversationId, {
      onDragStart: () => {
        if (!panes) return;
        setTimeout(() => panes.beginChatDrag(conversationId), 0);
      },
      onDragEnd: () => panes?.endChatDrag(),
    });

  // A Task row only files into a Project. The chat canvas renders conversations
  // the chat surface owns, so a Task drag never announces itself to the panes
  // and no pane offers itself as a drop target. Nothing to drag into while
  // Projects are off, and a draggable row changes native text selection, so the
  // handlers only exist when the section does.
  const taskRowDragProps = (conversationId: string): SidebarRowDragProps =>
    projects.enabled ? conversationDragProps(conversationId) : {};

  const renderChatRow = (chat: ChatSummaryView) => {
    const href = chatHref(chat.id);
    const pinned = isPinned(chat);
    const optimistic = optimisticChatIds.has(chat.id);
    const prefetchChat = () => {
      void preloadHeadlessChatMessages(chat.id).catch((error: unknown) => {
        console.warn("Could not preload a sidebar chat transcript.", {
          conversationId: chat.id,
          error,
        });
      });
    };
    return (
      <SidebarChatRow
        key={chat.id}
        chat={chat}
        href={href}
        active={pathname === href}
        openInPane={panes?.openChatIds.has(chat.id) ?? false}
        canSplit={panes?.canSplit ?? false}
        onOpenBeside={panes ? (edge) => panes.openChatBeside(chat.id, edge) : null}
        optimistic={optimistic}
        localState={localChatStates.get(chat.id) ?? null}
        pullRequest={pullRequests.get(chat.id) ?? null}
        pinned={pinned}
        pinning={pinningIds.has(chat.id)}
        dragProps={optimistic ? {} : chatRowDragProps(chat.id)}
        onPrefetch={prefetchChat}
        onRequestComposerFocus={() => requestChatComposerFocus(chat.id)}
        onTogglePin={() => togglePin(chat.id, chat.title, pinned)}
        onArchive={() => archiveChat(chat.id, chat.title, href)}
      />
    );
  };

  const renderRow = (item: SidebarWorkItem) => {
    if (item.kind === "chat") return renderChatRow(item.chat);
    const href = taskHref(item.task.displayId);
    return (
      <SidebarTaskRow
        key={item.task.id}
        task={item.task}
        state={item.state}
        href={href}
        pullRequest={pullRequests.get(item.task.conversationId) ?? null}
        active={isTaskRouteActive(pathname, href)}
        dragProps={taskRowDragProps(item.task.conversationId)}
        onArchive={() => archiveTask(item.task, href)}
      />
    );
  };

  // A Project keeps what the reader filed there however old it is, so its rows resolve from the
  // full open set rather than the recency-bounded Recents selections. Recents rows take
  // precedence: they carry the optimistic summary of a chat whose first turn is still in flight.
  const chatsById = projects.enabled
    ? new Map([...openChats, ...recentChats].map((chat) => [chat.id, chat] as const))
    : new Map<string, ChatSummaryView>();
  const tasksByConversation = projects.enabled
    ? new Map([...openSidebarTasks, ...sidebarTasks].map((task) => [task.conversationId, task]))
    : new Map<string, SidebarTaskView>();
  const projectItems = (project: { conversationIds: string[] }) => {
    const chats: ChatSummaryView[] = [];
    const tasks: SidebarTaskView[] = [];
    for (const conversationId of project.conversationIds) {
      const task = tasksByConversation.get(conversationId);
      if (task) {
        tasks.push(task);
        continue;
      }
      const chat = chatsById.get(conversationId);
      if (chat) chats.push(chat);
    }
    return orderSidebarWorkItems({ chats, tasks });
  };

  const unfileDroppedConversation = (event: DragEvent<HTMLElement>) => {
    const conversationId = draggedConversationId(event);
    if (!conversationId) return;
    event.preventDefault();
    const projectId = projects.membership.get(conversationId);
    if (projectId) void projects.unfile(projectId, conversationId);
  };

  const pendingProjectId = pathname === "/" ? searchParams.get("project") : null;
  const hasRecents = pinnedChats.length > 0 || workItems.length > 0;
  // The Recents header is the drop target that takes a row back out of a folder, so it has to
  // stay on screen while any folder holds something -- otherwise filing the last loose chat
  // leaves no way to unfile it.
  const showRecents =
    workItems.length > 0 || projects.projects.some((project) => project.conversationIds.length > 0);

  // Keep the footer pinned to the bottom when there is nothing to show.
  if (!projects.enabled && !hasRecents) {
    return <div className="min-h-0 flex-1" />;
  }

  return (
    <div className="mt-4 flex min-h-0 flex-1 flex-col overflow-y-auto">
      <SidebarProjects
        state={projects}
        itemsFor={projectItems}
        renderItem={renderRow}
        activeProjectId={pendingProjectId}
      />
      {pinnedChats.length > 0 ? (
        <div className="pb-2">
          <div className="flex items-center gap-1 px-4 pb-1">
            <Pin size={9} strokeWidth={2} fill="currentColor" className="text-ink-subtle" />
            <span className="text-[11px] font-medium tracking-wide text-ink-subtle">Pinned</span>
          </div>
          <nav aria-label="Pinned chats" className="flex flex-col gap-px px-2">
            {pinnedChats.map(renderChatRow)}
          </nav>
        </div>
      ) : null}
      {showRecents ? (
        <div>
          <SidebarSectionHeader
            label="Recents"
            collapsed={recentsCollapsed}
            onToggle={toggleRecents}
            listId={RECENTS_LIST_ID}
            // Dropping a project row here files it back out: Recents is where an unfiled
            // conversation lives, so it is the drag target that means "take it out of the folder".
            onDragOver={(event) => {
              if (!isConversationDrag(event)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
            }}
            onDrop={unfileDroppedConversation}
          />
          {recentsCollapsed ? null : (
            <nav id={RECENTS_LIST_ID} aria-label="Recents" className="flex flex-col gap-px px-2">
              {workItems.length === 0 ? (
                // Everything loose has been filed. The header is still the target for dragging a
                // row back out, so say what it is for rather than leaving it looking broken.
                <p className="px-2 py-[5px] text-[12.5px] leading-4 text-ink-faint">
                  Drag a chat here to take it out of a project.
                </p>
              ) : (
                workItems.map(renderRow)
              )}
            </nav>
          )}
        </div>
      ) : null}
    </div>
  );
}

function reconcilePinOverrides(
  current: ReadonlyMap<string, boolean>,
  recentChats: readonly ChatSummaryView[],
) {
  const next = new Map(current);
  for (const [chatId, desiredPinned] of current) {
    const chat = recentChats.find((item) => item.id === chatId);
    if (!chat || Boolean(chat.pinnedAt) === desiredPinned) {
      next.delete(chatId);
    }
  }
  return next;
}

function SidebarChatRow({
  chat,
  href,
  active,
  openInPane,
  canSplit,
  onOpenBeside,
  optimistic,
  localState,
  pullRequest,
  pinned,
  pinning,
  dragProps,
  onPrefetch,
  onRequestComposerFocus,
  onTogglePin,
  onArchive,
}: {
  chat: ChatSummaryView;
  href: string;
  active: boolean;
  // Open in a pane that is not the focused one. The focused chat is already
  // marked by `active`, so this is the quieter "also on screen" state.
  openInPane: boolean;
  // False at the pane cap, which disables opening this chat beside another.
  canSplit: boolean;
  // Null when no pane workspace is mounted, which hides the menu entirely.
  onOpenBeside: ((edge: "right" | "bottom") => void) | null;
  optimistic: boolean;
  localState: ReturnType<typeof chatSummaryState> | null;
  /** The PR this chat's coding agent opened, when it opened one. */
  pullRequest: SessionPullRequest | null;
  pinned: boolean;
  pinning: boolean;
  // Lets the row be dragged into a sidebar Project. Empty when Projects are off, and for a chat
  // whose first turn has not landed yet: there is no conversation to file.
  dragProps: SidebarRowDragProps;
  onPrefetch: () => void;
  onRequestComposerFocus: () => void;
  onTogglePin: () => void;
  onArchive: () => void;
}) {
  const state = resolveSidebarChatState({ chat, localState });
  const contentPadding = useSidebarRowPadding();
  const runStateDescriptionId = useRunStateDescription(state);
  const marked = hasSessionMarker({ state, pullRequest });
  const [openBesideOpen, setOpenBesideOpen] = useState(false);
  const content = <span className="truncate tracking-[-0.005em]">{chat.title}</span>;
  return (
    <div
      {...dragProps}
      className={`group flex items-center rounded-md text-[13px] transition-colors duration-150 ${
        active
          ? "bg-surface-active text-ink"
          : openInPane
            ? "bg-surface-active/40 text-ink hover:bg-surface-active"
            : "text-ink/90 hover:bg-surface-hover hover:text-ink"
      }`}
    >
      {marked ? (
        <SidebarSessionStatus
          state={state}
          runStateDescriptionId={runStateDescriptionId}
          pullRequest={pullRequest}
          className={contentPadding}
        />
      ) : null}
      {optimistic ? (
        <button
          type="button"
          aria-describedby={runStateDescriptionId}
          onClick={onRequestComposerFocus}
          className={`flex min-w-0 flex-1 items-center rounded-md py-[5px] pr-1 text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
            marked ? SIDEBAR_ROW_LINK_PADDING : contentPadding
          }`}
        >
          {content}
        </button>
      ) : (
        <IntentPrefetchLink
          href={href}
          onIntent={onPrefetch}
          onClick={(event) => {
            if (
              event.button !== 0 ||
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey
            ) {
              return;
            }
            onRequestComposerFocus();
          }}
          aria-current={active ? "page" : undefined}
          aria-describedby={runStateDescriptionId}
          className={`flex min-w-0 flex-1 items-center rounded-l-md py-[5px] text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
            marked ? SIDEBAR_ROW_LINK_PADDING : contentPadding
          }`}
        >
          {content}
        </IntentPrefetchLink>
      )}
      {optimistic ? null : (
        <>
          {onOpenBeside && !openInPane ? (
            <Popover open={openBesideOpen} onOpenChange={setOpenBesideOpen}>
              <PopoverTrigger
                type="button"
                title={canSplit ? "Open beside" : "Four panes is the limit"}
                aria-label={`Open ${chat.title} beside the current chat`}
                disabled={!canSplit}
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink/50 transition-opacity duration-150 hover:bg-surface-active hover:text-ink focus:opacity-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:opacity-40 ${
                  openBesideOpen
                    ? "opacity-100"
                    : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                }`}
              >
                <SplitSquareHorizontal size={12.5} strokeWidth={1.8} />
              </PopoverTrigger>
              <PopoverContent align="start" sideOffset={4} className="w-[168px] bg-surface p-1">
                <button
                  type="button"
                  onClick={() => {
                    setOpenBesideOpen(false);
                    onOpenBeside("right");
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-ink/90 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
                >
                  <SplitSquareHorizontal
                    size={13}
                    strokeWidth={1.75}
                    className="shrink-0 text-ink/60"
                  />
                  Open right
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setOpenBesideOpen(false);
                    onOpenBeside("bottom");
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-ink/90 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
                >
                  <SplitSquareVertical
                    size={13}
                    strokeWidth={1.75}
                    className="shrink-0 text-ink/60"
                  />
                  Open below
                </button>
                <p className="px-2 pt-1 pb-1 text-[11px] leading-4 text-ink-faint">
                  Or drag the chat onto a pane edge.
                </p>
              </PopoverContent>
            </Popover>
          ) : null}
          <button
            type="button"
            title={pinned ? "Unpin chat" : "Pin chat"}
            aria-label={pinned ? `Unpin ${chat.title}` : `Pin ${chat.title}`}
            aria-pressed={pinned}
            disabled={pinning}
            onClick={onTogglePin}
            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink/50 transition-opacity duration-150 hover:bg-surface-active hover:text-ink focus:opacity-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-not-allowed ${
              pinned || pinning
                ? "opacity-100"
                : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
            }`}
          >
            {/* The row has already moved to its new section, so the icon shows the state the user
                asked for rather than a spinner over the one they just left. */}
            <Pin size={11.5} strokeWidth={1.8} fill={pinned ? "currentColor" : "none"} />
          </button>
          <button
            type="button"
            title="Archive chat"
            aria-label={`Archive ${chat.title}`}
            onClick={onArchive}
            className="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink/50 opacity-0 transition-opacity duration-150 hover:bg-surface-active hover:text-ink focus:opacity-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 group-hover:opacity-100 group-focus-within:opacity-100"
          >
            <Archive size={13} strokeWidth={1.75} />
          </button>
        </>
      )}
    </div>
  );
}

/**
 * Whether a session has anything to show in its marker slot: a run that is live, waiting, or
 * finished unseen, or — once the result is seen — the pull request it opened.
 *
 * A settled, seen session with no pull request has nothing to say, and the row renders no slot at
 * all rather than an empty one. Most rows in a real Recents list are in exactly that state, so a
 * reserved slot left the majority of the list indented behind a column of blank space.
 */
function hasSessionMarker(input: {
  state: ReturnType<typeof chatSummaryState>;
  pullRequest: SessionPullRequest | null;
}) {
  return input.state !== "done_seen" || Boolean(input.pullRequest);
}

/**
 * The marker at a session row's left edge follows the session lifecycle: a live run owns that
 * position, then an unread result, then its pull request after the result is seen.
 *
 * It leads the row rather than trailing it because the state of the work an agent left behind is
 * something the reader scans a column for, the way they scan the row's own title — not a control
 * they reach for. Trailing, it also had to share the pin's column and disappear on hover.
 *
 * It sits beside the row's link rather than inside it: the badge is itself a link, to the PR on
 * GitHub, and an anchor inside an anchor is invalid HTML. The marker carries the row's left
 * padding, and the link beside it drops to `SIDEBAR_ROW_LINK_PADDING`, the gap between them. A row
 * with nothing to mark skips the slot and gives that padding to its link instead, so its title
 * starts at the list's own left edge — see `hasSessionMarker`.
 *
 * The slot is a fixed 18px whatever it holds, so a session moving between differently sized status
 * glyphs never shifts its own title.
 */
function SidebarSessionStatus({
  state,
  runStateDescriptionId,
  pullRequest,
  className,
}: {
  state: ReturnType<typeof chatSummaryState>;
  /** Set by `useRunStateDescription` when the row's link describes itself with this marker. */
  runStateDescriptionId: string | undefined;
  pullRequest: SessionPullRequest | null;
  className?: string;
}) {
  return (
    <span className={`flex shrink-0 items-center ${className ?? ""}`}>
      {state === "done_seen" && pullRequest ? (
        <PullRequestBadge pullRequest={pullRequest} />
      ) : (
        <span className="flex size-[18px] shrink-0 items-center justify-center">
          <ChatStateIndicator state={state} surface="sidebar" id={runStateDescriptionId} />
        </span>
      )}
    </span>
  );
}

/**
 * The gap between a marker slot and the title beside it. Only a row that renders a marker uses it:
 * the slot carries the row's own padding, so the link after it needs nothing more. A row with no
 * marker takes that padding itself.
 */
const SIDEBAR_ROW_LINK_PADDING = "pl-1.5";

/**
 * Ties a row's link to its run-state slot for screen readers.
 *
 * `awaiting_input` is the one state `ChatStateIndicator` gives an accessible name, because it is
 * the difference between a run that is progressing and one that is stuck on the reader. The slot
 * sits beside the link rather than inside it, so that name no longer falls into the link's own —
 * a reader moving link by link would hear the session's title and nothing about it waiting. The
 * link points back at the indicator instead, which puts the state in its description.
 */
function useRunStateDescription(state: ReturnType<typeof chatSummaryState>) {
  const id = useId();
  return state === "awaiting_input" ? id : undefined;
}

function resolveSidebarChatState(input: {
  chat: ChatSummaryView;
  localState: ReturnType<typeof chatSummaryState> | null;
}) {
  const state = chatSummaryState(input.chat);
  // A parked run outranks the optimistic spinner, on the render before the handoff effect below
  // clears it as well as after. The local state is this tab guessing that a run it just started is
  // live; `awaiting_input` is the server saying that run is stuck on the reader.
  if (state === "awaiting_input") return state;
  if (input.localState === "working") return "working";
  return input.localState ?? state;
}

/**
 * A Task in the sidebar's work list.
 *
 * It reuses the chat row's state indicator on purpose: the dot means the same thing on both kinds
 * of row, so it has one implementation. Tasks do not pin, so the row has no pin control, and its
 * display id doubles as the marker that this row opens a Task rather than a chat.
 */
function SidebarTaskRow({
  task,
  state,
  href,
  active,
  pullRequest,
  dragProps,
  onArchive,
}: {
  task: SidebarTaskView;
  state: ReturnType<typeof chatSummaryState>;
  href: string;
  active: boolean;
  /** The PR this Task's coding agent opened, when it opened one. */
  pullRequest: SessionPullRequest | null;
  // Keyed by the conversation behind the Task, the same key a Project stores for a chat.
  dragProps: SidebarRowDragProps;
  onArchive: () => void;
}) {
  const archivable = isSettledTaskStatus(task.status);
  const contentPadding = useSidebarRowPadding();
  const runStateDescriptionId = useRunStateDescription(state);
  const marked = hasSessionMarker({ state, pullRequest });
  return (
    <div
      {...dragProps}
      className={`group flex items-center rounded-md text-[13px] transition-colors duration-150 ${
        active ? "bg-surface-active text-ink" : "text-ink/90 hover:bg-surface-hover hover:text-ink"
      }`}
    >
      {marked ? (
        <SidebarSessionStatus
          state={state}
          runStateDescriptionId={runStateDescriptionId}
          pullRequest={pullRequest}
          // A Task row is two lines tall. Centred across both, the column would sit at a different
          // height from the row's own text and from every one-line chat row above it.
          className={`mt-[6px] self-start ${contentPadding}`}
        />
      ) : null}
      <Link
        href={href}
        prefetch
        aria-current={active ? "page" : undefined}
        aria-describedby={runStateDescriptionId}
        className={`flex min-w-0 flex-1 items-center rounded-l-md py-[5px] text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
          marked ? SIDEBAR_ROW_LINK_PADDING : contentPadding
        }`}
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate tracking-[-0.005em]">{task.name}</span>
          <span className="truncate text-[11px] leading-none text-ink-faint">{task.displayId}</span>
        </span>
      </Link>
      {/* Stand-in for the chat row's pin control, so the archive icon lands in the same column on
          every row the reader hovers down the list. A Task row is two lines tall, so both this
          slot and the archive beside it are pulled up against the title: centred across both lines
          they would sit at a different height from the row's own text and read as misaligned. */}
      <span aria-hidden="true" className="h-6 w-6 shrink-0" />
      <span className="mr-1 mt-[1.5px] flex h-6 w-6 shrink-0 items-center justify-center self-start">
        {archivable ? (
          <button
            type="button"
            title="Archive task"
            aria-label={`Archive ${task.name}`}
            onClick={onArchive}
            className="flex h-6 w-6 items-center justify-center rounded-md text-ink/50 opacity-0 transition-opacity duration-150 hover:bg-surface-active hover:text-ink focus:opacity-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 group-hover:opacity-100 group-focus-within:opacity-100"
          >
            <Archive size={13} strokeWidth={1.75} />
          </button>
        ) : null}
      </span>
    </div>
  );
}

function chatHref(sessionId: string) {
  return `/chat/${encodeURIComponent(sessionId)}`;
}

function taskHref(displayId: string) {
  return `/tasks/${encodeURIComponent(displayId)}`;
}

// The Task route resolves its display id case-insensitively and has a /run child, so the row stays
// current for both rather than only for the exact link it renders.
function isTaskRouteActive(pathname: string, href: string) {
  const current = pathname.toLowerCase();
  const target = href.toLowerCase();
  return current === target || current.startsWith(`${target}/`);
}

function WorkspaceSwitcher() {
  const { workspace, workspaces } = useAppData();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const closePicker = () => {
    setOpen(false);
    setCreateOpen(false);
    setName("");
    setError(null);
  };

  const switchWorkspace = (workspaceId: string) => {
    if (workspaceId === workspace.id) {
      closePicker();
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await switchWorkspaceAction(workspaceId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      closePicker();
      router.push("/");
      router.refresh();
    });
  };

  const createWorkspace = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await createWorkspaceAction(name);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      closePicker();
      router.push("/");
      router.refresh();
    });
  };

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          setOpen(true);
          return;
        }
        closePicker();
      }}
    >
      <PopoverTrigger
        type="button"
        aria-label={`Switch organization. Current organization: ${workspace.name}`}
        disabled={isPending}
        className="group flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] text-ink/90 transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:opacity-60 data-[popup-open]:bg-surface-active data-[popup-open]:text-ink"
      >
        <Icon className="h-3.5 w-3.5 shrink-0 text-ink/60" />
        <span className="min-w-0 flex-1 truncate font-medium leading-tight">{workspace.name}</span>
        {isPending ? (
          <Loader2 size={13} strokeWidth={1.75} className="shrink-0 animate-spin text-ink/45" />
        ) : (
          <ChevronsUpDown size={13} strokeWidth={1.75} className="shrink-0 text-ink/45" />
        )}
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-[232px] bg-surface p-1 text-ink">
        <div className="max-h-[280px] overflow-y-auto">
          {workspaces.map((entry) => {
            const active = entry.id === workspace.id;
            return (
              <button
                type="button"
                key={entry.id}
                aria-current={active ? "true" : undefined}
                disabled={isPending}
                onClick={() => switchWorkspace(entry.id)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-ink transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Check
                  size={13}
                  strokeWidth={2}
                  className={`shrink-0 text-ink ${active ? "opacity-100" : "opacity-0"}`}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium leading-4">{entry.name}</span>
                  <span className="block truncate text-[11px] leading-4 text-ink-subtle">
                    {entry.role}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        <div className="my-1 h-px bg-border" />
        {createOpen ? (
          <form onSubmit={createWorkspace} className="space-y-2 p-1">
            <label className="sr-only" htmlFor="new-opencompany-organization-name">
              Organization name
            </label>
            <input
              id="new-opencompany-organization-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
              maxLength={80}
              placeholder="Organization name"
              disabled={isPending}
              className="h-8 w-full rounded-md border border-border bg-canvas px-2 text-[13px] text-ink outline-none placeholder:text-ink-subtle focus:border-border-strong focus:ring-2 focus:ring-ink/[0.04] disabled:opacity-60"
            />
            <div className="flex items-center gap-1.5">
              <button
                type="submit"
                disabled={isPending}
                className="inline-flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md bg-ink px-2 text-[12px] font-medium text-canvas transition-opacity disabled:opacity-60"
              >
                {isPending ? <Loader2 size={12} className="animate-spin" /> : null}
                Create
              </button>
              <button
                type="button"
                disabled={isPending}
                onClick={() => {
                  setCreateOpen(false);
                  setError(null);
                }}
                className="h-7 rounded-md px-2 text-[12px] font-medium text-ink-muted hover:bg-surface-hover hover:text-ink disabled:opacity-60"
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => {
              setCreateOpen(true);
              setError(null);
            }}
            className="flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-[12.5px] font-medium tracking-[-0.005em] text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            <Plus size={13} strokeWidth={2} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">Create organization...</span>
          </button>
        )}
        {error ? (
          <p role="alert" className="px-2 pb-1 pt-1 text-[11.5px] leading-4 text-danger">
            {error}
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function getInitials(firstName: string | null, lastName: string | null, email: string) {
  const initials = [firstName, lastName]
    .map((part) => part?.trim().at(0))
    .filter(Boolean)
    .join("")
    .toUpperCase();

  return initials || email.trim().at(0)?.toUpperCase() || "?";
}
