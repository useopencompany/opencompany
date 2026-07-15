"use client";

import { Popover, PopoverContent, PopoverTrigger } from "@opencompany/ui/components/popover";
import { toast } from "@opencompany/ui/components/sonner";
import type { LucideIcon } from "lucide-react";
import {
  Archive,
  Check,
  ChevronsUpDown,
  House,
  Loader2,
  PanelLeft,
  Pin,
  PlugZap,
  Settings,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useGoatAppData } from "@/components/GoatAppDataProvider";
import { GoatBrainSwitcher } from "@/components/GoatBrainSwitcher";
import { closeGoatChatSessionAction, setGoatChatPinnedAction } from "@/lib/chat-actions";
import type { GoatChatSummaryView } from "@/lib/chat-ui";
import { switchGoatWorkspaceAction } from "@/lib/workspace-actions";

function GoatIcon({ className }: { className?: string }) {
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
  label,
  active,
  incomplete = false,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  active: boolean;
  incomplete?: boolean;
}) {
  return (
    <Link
      href={href}
      prefetch
      aria-current={active ? "page" : undefined}
      className={`group flex w-full items-center gap-2.5 rounded-md px-2 py-[5px] text-left text-[13px] transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
        active ? "bg-surface-active text-ink" : "text-ink/90 hover:bg-surface-hover hover:text-ink"
      }`}
    >
      <Icon
        size={14}
        strokeWidth={1.75}
        className={`shrink-0 ${active ? "text-ink" : "text-ink/60 group-hover:text-ink/80"}`}
      />
      <span className="truncate tracking-[-0.005em]">{label}</span>
      {incomplete ? (
        <span aria-hidden="true" className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />
      ) : null}
    </Link>
  );
}

export function GoatSidebar({
  collapsed,
  onToggleCollapsed,
}: {
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const { mcpSetup, user } = useGoatAppData();
  const pathname = usePathname();
  const settingsActive = pathname === "/settings" || pathname.startsWith("/settings/");
  const homeActive = pathname === "/";
  const mcpSetupActive = pathname === "/settings/mcp";

  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  const displayName = name || user.email;
  const initials = getInitials(user.firstName, user.lastName, user.email);

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
          <button
            type="button"
            aria-label="Collapse sidebar"
            aria-expanded={!collapsed}
            onClick={onToggleCollapsed}
            className="shrink-0 rounded-md p-1.5 text-ink/60 transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            <PanelLeft size={15} strokeWidth={1.75} />
          </button>
          <div className="min-w-0 flex-1">
            <GoatWorkspaceSwitcher />
          </div>
        </div>

        {/* Primary nav */}
        <nav aria-label="Goat primary" className="flex flex-col gap-px px-2 pt-2">
          <SidebarNavRow href="/" icon={House} label="Home" active={homeActive} />
          {!mcpSetup.completedAt ? (
            <SidebarNavRow
              href="/settings/mcp"
              icon={PlugZap}
              label="Connect your brain"
              active={mcpSetupActive}
              incomplete
            />
          ) : null}
        </nav>

        {/* Brains */}
        <div className="px-2 pt-4">
          <GoatBrainSwitcher />
        </div>

        {/* Recent chats */}
        <GoatSidebarRecentChats />

        {/* Account / settings footer */}
        <div className="px-2 pb-3 pt-2">
          <Link
            href="/settings"
            prefetch
            aria-current={settingsActive ? "page" : undefined}
            className={`group flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
              settingsActive
                ? "bg-surface-active text-ink"
                : "text-ink/90 hover:bg-surface-hover hover:text-ink"
            }`}
          >
            {user.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={user.avatarUrl}
                alt=""
                className="h-6 w-6 shrink-0 rounded-full bg-surface-muted object-cover"
              />
            ) : (
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-muted text-[10.5px] font-semibold text-ink">
                {initials}
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] font-medium leading-tight text-ink">
                {displayName}
              </span>
              <span className="block truncate text-[11px] leading-tight text-ink-subtle">
                Settings
              </span>
            </span>
            <Settings
              size={14}
              strokeWidth={1.75}
              className="shrink-0 text-ink/50 transition-colors duration-150 group-hover:text-ink/80"
            />
          </Link>
        </div>
      </div>
    </aside>
  );
}

function GoatSidebarRecentChats() {
  const { recentChats } = useGoatAppData();
  const pathname = usePathname();
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [pinningIds, setPinningIds] = useState<Set<string>>(() => new Set());
  const [pinOverrides, setPinOverrides] = useState<Map<string, boolean>>(() => new Map());
  const [previousRecentChats, setPreviousRecentChats] = useState(recentChats);

  if (previousRecentChats !== recentChats) {
    setPreviousRecentChats(recentChats);
    setPinOverrides((current) => reconcilePinOverrides(current, recentChats));
  }

  // Keep the footer pinned to the bottom when there is nothing to show.
  if (recentChats.length === 0) {
    return <div className="min-h-0 flex-1" />;
  }

  const isPinned = (chat: GoatChatSummaryView) =>
    pinOverrides.get(chat.id) ?? Boolean(chat.pinnedAt);
  const pinnedChats = recentChats.filter(isPinned);
  const unpinnedChats = recentChats.filter((chat) => !isPinned(chat));

  const archiveChat = (chatId: string, chatTitle: string, href: string) => {
    setArchivingId(chatId);
    startTransition(async () => {
      const result = await closeGoatChatSessionAction(chatId);
      setArchivingId((current) => (current === chatId ? null : current));
      if (!result.ok) {
        toast.error(result.error ?? `Could not archive "${chatTitle}".`);
        return;
      }
      // If we archived the chat we're currently viewing, drop back to home.
      if (pathname === href) {
        router.push("/");
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
        const result = await setGoatChatPinnedAction(chatId, desiredPinned);
        if (result.ok) return;

        setPinOverrides((current) => {
          const next = new Map(current);
          next.delete(chatId);
          return next;
        });
        toast.error(
          result.error ??
            (currentlyPinned ? `Could not unpin "${chatTitle}".` : `Could not pin "${chatTitle}".`),
        );
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

  const renderRow = (chat: GoatChatSummaryView) => {
    const href = chatHref(chat.id);
    const pinned = isPinned(chat);
    return (
      <GoatSidebarChatRow
        key={chat.id}
        chat={chat}
        href={href}
        active={pathname === href}
        pinned={pinned}
        archiving={archivingId === chat.id}
        pinning={pinningIds.has(chat.id)}
        onPrefetch={() => router.prefetch(href)}
        onTogglePin={() => togglePin(chat.id, chat.title, pinned)}
        onArchive={() => archiveChat(chat.id, chat.title, href)}
      />
    );
  };

  return (
    <div className="mt-4 flex min-h-0 flex-1 flex-col overflow-y-auto">
      {pinnedChats.length > 0 ? (
        <div className="pb-2">
          <div className="flex items-center gap-1 px-4 pb-1">
            <Pin size={9} strokeWidth={2} fill="currentColor" className="text-ink-subtle" />
            <span className="text-[11px] font-medium uppercase tracking-wide text-ink-subtle">
              Pinned
            </span>
          </div>
          <nav aria-label="Pinned chats" className="flex flex-col gap-px px-2">
            {pinnedChats.map(renderRow)}
          </nav>
        </div>
      ) : null}
      {unpinnedChats.length > 0 ? (
        <div>
          <div className="px-4 pb-1 text-[11px] font-medium uppercase tracking-wide text-ink-subtle">
            Recent chats
          </div>
          <nav aria-label="Recent chats" className="flex flex-col gap-px px-2">
            {unpinnedChats.map(renderRow)}
          </nav>
        </div>
      ) : null}
    </div>
  );
}

function reconcilePinOverrides(
  current: ReadonlyMap<string, boolean>,
  recentChats: readonly GoatChatSummaryView[],
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

function GoatSidebarChatRow({
  chat,
  href,
  active,
  pinned,
  archiving,
  pinning,
  onPrefetch,
  onTogglePin,
  onArchive,
}: {
  chat: GoatChatSummaryView;
  href: string;
  active: boolean;
  pinned: boolean;
  archiving: boolean;
  pinning: boolean;
  onPrefetch: () => void;
  onTogglePin: () => void;
  onArchive: () => void;
}) {
  return (
    <div
      className={`group flex items-center rounded-md text-[13px] transition-colors duration-150 ${
        active ? "bg-surface-active text-ink" : "text-ink/90 hover:bg-surface-hover hover:text-ink"
      }`}
    >
      <Link
        href={href}
        prefetch
        onMouseEnter={onPrefetch}
        onFocus={onPrefetch}
        aria-current={active ? "page" : undefined}
        className="flex min-w-0 flex-1 items-center rounded-l-md py-[5px] pl-2 text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
      >
        <span className="truncate tracking-[-0.005em]">{chat.title}</span>
      </Link>
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
        {pinning ? (
          <Loader2 size={12} strokeWidth={1.75} className="animate-spin" />
        ) : (
          <Pin size={11.5} strokeWidth={1.8} fill={pinned ? "currentColor" : "none"} />
        )}
      </button>
      <button
        type="button"
        title="Archive chat"
        aria-label={`Archive ${chat.title}`}
        disabled={archiving}
        onClick={onArchive}
        className={`mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink/50 transition-opacity duration-150 hover:bg-surface-active hover:text-ink focus:opacity-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-not-allowed ${
          archiving
            ? "opacity-100"
            : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
        }`}
      >
        {archiving ? (
          <Loader2 size={13} strokeWidth={1.75} className="animate-spin" />
        ) : (
          <Archive size={13} strokeWidth={1.75} />
        )}
      </button>
    </div>
  );
}

function chatHref(sessionId: string) {
  return `/chat/${encodeURIComponent(sessionId)}`;
}

function GoatWorkspaceSwitcher() {
  const { workspace, workspaces } = useGoatAppData();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  const switchWorkspace = (workspaceId: string) => {
    if (workspaceId === workspace.id) {
      setOpen(false);
      return;
    }
    startTransition(async () => {
      const result = await switchGoatWorkspaceAction(workspaceId);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setOpen(false);
      router.push("/");
      router.refresh();
    });
  };

  if (workspaces.length <= 1) {
    return (
      <Link
        href="/settings/workspace"
        prefetch
        className="group flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] text-ink/90 transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
      >
        <GoatIcon className="h-3.5 w-3.5 shrink-0 text-ink/60" />
        <span className="min-w-0 flex-1 truncate font-medium leading-tight">{workspace.name}</span>
      </Link>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        type="button"
        disabled={isPending}
        className="group flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] text-ink/90 transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:opacity-60 data-[popup-open]:bg-surface-active data-[popup-open]:text-ink"
      >
        <GoatIcon className="h-3.5 w-3.5 shrink-0 text-ink/60" />
        <span className="min-w-0 flex-1 truncate font-medium leading-tight">{workspace.name}</span>
        {isPending ? (
          <Loader2 size={13} strokeWidth={1.75} className="shrink-0 animate-spin text-ink/45" />
        ) : (
          <ChevronsUpDown size={13} strokeWidth={1.75} className="shrink-0 text-ink/45" />
        )}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-[232px] border-border bg-surface p-1 text-ink shadow-[0_12px_32px_rgba(15,15,15,0.14)]"
      >
        <div className="max-h-[280px] overflow-y-auto">
          {workspaces.map((entry) => {
            const active = entry.id === workspace.id;
            return (
              <button
                type="button"
                key={entry.id}
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
