"use client";

import { Popover, PopoverContent, PopoverTrigger } from "@opencompany/ui/components/popover";
import { toast } from "@opencompany/ui/components/sonner";
import type { LucideIcon } from "lucide-react";
import {
  Archive,
  Building2,
  Check,
  ChevronsUpDown,
  House,
  Loader2,
  PanelLeft,
  PlugZap,
  Settings,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useGoatAppData } from "@/components/GoatAppDataProvider";
import { GoatBrainSwitcher } from "@/components/GoatBrainSwitcher";
import { closeGoatChatSessionAction } from "@/lib/chat-actions";
import { switchGoatWorkspaceAction } from "@/lib/workspace-actions";

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
  const mcpSetupActive = pathname === "/setup/mcp";

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
              href="/setup/mcp"
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

  // Keep the footer pinned to the bottom when there is nothing to show.
  if (recentChats.length === 0) {
    return <div className="min-h-0 flex-1" />;
  }

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

  return (
    <div className="mt-4 flex min-h-0 flex-1 flex-col">
      <div className="px-4 pb-1 text-[11px] font-medium uppercase tracking-wide text-ink-subtle">
        Recent chats
      </div>
      <nav
        aria-label="Recent chats"
        className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-2"
      >
        {recentChats.map((chat) => {
          const href = chatHref(chat.id);
          const active = pathname === href;
          const prefetchChat = () => router.prefetch(href);
          const archiving = archivingId === chat.id;
          return (
            <div key={chat.id} className="group relative">
              <Link
                href={href}
                prefetch
                onMouseEnter={prefetchChat}
                onFocus={prefetchChat}
                aria-current={active ? "page" : undefined}
                className={`flex w-full items-center rounded-md py-[5px] pl-2 pr-8 text-left text-[13px] transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
                  active
                    ? "bg-surface-active text-ink"
                    : "text-ink/90 hover:bg-surface-hover hover:text-ink"
                }`}
              >
                <span className="truncate tracking-[-0.005em]">{chat.title}</span>
              </Link>
              <button
                type="button"
                aria-label={`Archive ${chat.title}`}
                title="Archive chat"
                disabled={archiving}
                onClick={() => archiveChat(chat.id, chat.title, href)}
                className="absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-ink/50 opacity-0 transition-[opacity,color,background-color] duration-150 hover:bg-surface-active hover:text-ink focus:outline-none focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ink/20 group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-100"
              >
                {archiving ? (
                  <Loader2 size={13} strokeWidth={1.75} className="animate-spin" />
                ) : (
                  <Archive size={13} strokeWidth={1.75} />
                )}
              </button>
            </div>
          );
        })}
      </nav>
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
        <Building2 size={14} strokeWidth={1.75} className="shrink-0 text-ink/60" />
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
        <Building2 size={14} strokeWidth={1.75} className="shrink-0 text-ink/60" />
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
