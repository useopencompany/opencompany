"use client";

import { Popover, PopoverContent, PopoverTrigger } from "@opencompany/ui/components/popover";
import {
  BookOpen,
  CircleDashed,
  FileClock,
  ListTodo,
  MoreHorizontal,
  PanelLeft,
  Plus,
  Settings,
  Workflow,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { useAppData } from "@/components/AppDataProvider";
import { HOME_NAVIGATION_EVENT } from "@/lib/chat-navigation";

const SETTINGS_TITLES: Record<string, string> = {
  "/settings": "Settings",
  "/settings/preferences": "Preferences",
  "/settings/workspace": "Workspace",
  "/settings/usage": "Usage",
  "/settings/integrations": "Integrations",
  "/settings/workspace/inference": "Inference",
  "/settings/repositories": "Repositories",
  "/settings/skills": "Skills",
  "/settings/mcp": "MCP",
  "/settings/attio": "Attio",
  "/settings/fathom": "Fathom ingestion",
  "/settings/granola": "Granola",
  "/settings/jamie": "Jamie",
};

function pathSegmentLabel(value: string | undefined, fallback: string) {
  if (!value) return fallback;
  try {
    return decodeURIComponent(value)
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (character) => character.toUpperCase());
  } catch {
    return fallback;
  }
}

export function DesktopTitleBar({
  collapsed,
  onToggleSidebar,
}: {
  collapsed: boolean;
  onToggleSidebar: () => void;
}) {
  const { recentChats, tasks, workspace } = useAppData();
  const pathname = usePathname();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const segments = pathname.split("/").filter(Boolean);

  let title = workspace.name;
  let section = "Home";
  let SectionIcon = CircleDashed;

  if (segments[0] === "chat") {
    title = recentChats.find((chat) => chat.id === segments[1])?.title ?? "Chat";
    section = "Chat";
  } else if (segments[0] === "tasks") {
    title = tasks.find((task) => task.id === segments[1])?.name ?? "Tasks";
    section = "Tasks";
    SectionIcon = ListTodo;
  } else if (segments[0] === "workflows") {
    title = pathSegmentLabel(segments[1], "Workflows");
    section = "Workflows";
    SectionIcon = Workflow;
  } else if (segments[0] === "wiki") {
    title = pathSegmentLabel(segments.at(-1), "Wiki");
    section = "Wiki";
    SectionIcon = BookOpen;
  } else if (segments[0] === "settings") {
    title = SETTINGS_TITLES[pathname] ?? pathSegmentLabel(segments.at(-1), "Settings");
    section = "Settings";
    SectionIcon = Settings;
  }

  const startNewChat = () => {
    if (pathname === "/" || pathname.startsWith("/chat/")) {
      window.dispatchEvent(new Event(HOME_NAVIGATION_EVENT));
    }
    router.push("/");
  };

  return (
    <header className="desktop-drag-region relative z-50 flex h-12 shrink-0 select-none items-center border-b border-border-subtle/70 bg-sidebar px-3 text-ink">
      <div className="desktop-no-drag flex items-center pl-[66px]">
        <button
          type="button"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
          onClick={onToggleSidebar}
          className="flex h-7 w-7 items-center justify-center rounded-md text-ink-muted transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        >
          <PanelLeft size={15} strokeWidth={1.75} />
        </button>
      </div>

      <div className="pointer-events-none absolute inset-x-40 flex min-w-0 items-center justify-center">
        <div className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1">
          <SectionIcon size={15} strokeWidth={1.8} className="shrink-0 text-ink-muted" />
          <span className="truncate text-[13.5px] font-medium tracking-[-0.01em] text-ink">
            {title}
          </span>
          {title !== section ? (
            <span className="hidden shrink-0 text-[11.5px] text-ink-subtle lg:inline">
              {section}
            </span>
          ) : null}
        </div>
      </div>

      <div className="desktop-no-drag ml-auto flex items-center gap-1">
        <button
          type="button"
          aria-label="New chat"
          title="New chat"
          onClick={startNewChat}
          className="flex h-7 w-7 items-center justify-center rounded-md text-ink-muted transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        >
          <Plus size={16} strokeWidth={1.75} />
        </button>

        <Popover open={menuOpen} onOpenChange={setMenuOpen}>
          <PopoverTrigger
            type="button"
            aria-label="More options"
            className="flex h-7 w-7 items-center justify-center rounded-md text-ink-muted transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 data-[popup-open]:bg-surface-active data-[popup-open]:text-ink"
          >
            <MoreHorizontal size={16} strokeWidth={1.75} />
          </PopoverTrigger>
          <PopoverContent align="end" sideOffset={6} className="w-48 bg-surface p-1 text-ink">
            <Link
              href="/settings"
              prefetch
              onClick={() => setMenuOpen(false)}
              className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-ink/90 transition-colors hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
            >
              <Settings size={14} strokeWidth={1.75} className="text-ink/60" />
              Settings
            </Link>
            <Link
              href="/changelog"
              prefetch
              onClick={() => setMenuOpen(false)}
              className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-ink/90 transition-colors hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
            >
              <FileClock size={14} strokeWidth={1.75} className="text-ink/60" />
              Changelog
            </Link>
          </PopoverContent>
        </Popover>
      </div>
    </header>
  );
}
