"use client";

import type { LucideIcon } from "lucide-react";
import {
  ArrowLeft,
  ArrowUpRight,
  BrainCircuit,
  CircleDollarSign,
  Container,
  CreditCard,
  FolderGit2,
  MessageSquare,
  PackageOpen,
  PanelLeft,
  PlugZap,
  SearchCheck,
  SlidersHorizontal,
  Sparkles,
  UserRound,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAppDataOptional } from "@/components/AppDataProvider";
import { IntentPrefetchLink } from "@/components/IntentPrefetchLink";

type SettingsNavItem = {
  href: string;
  icon: LucideIcon;
  label: string;
  badge?: string;
  adminOnly?: boolean;
  /**
   * Rows that lead out of /settings. This rail unmounts on arrival, so they are never current and
   * carry an outbound arrow instead — the reader should expect the left rail to change.
   */
  leavesSettings?: boolean;
  isActive?: (pathname: string) => boolean;
};

type SettingsNavGroup = {
  label: string;
  items: SettingsNavItem[];
};

const NAV_GROUPS: SettingsNavGroup[] = [
  {
    label: "Personal",
    items: [
      {
        href: "/settings",
        icon: UserRound,
        label: "Account",
        isActive: (pathname) => pathname === "/settings",
      },
      {
        href: "/settings/mcp",
        icon: PlugZap,
        label: "MCP",
        isActive: (pathname) => pathname === "/settings/mcp",
      },
      {
        href: "/settings/preferences",
        icon: SlidersHorizontal,
        label: "Preferences",
        isActive: (pathname) => pathname === "/settings/preferences",
      },
    ],
  },
  {
    label: "Workspace",
    items: [
      {
        href: "/settings/workspace/inference",
        icon: BrainCircuit,
        label: "Inference",
        isActive: (pathname) => pathname === "/settings/workspace/inference",
      },
      {
        href: "/settings/workspace/sandboxes",
        icon: Container,
        label: "Sandboxes",
        isActive: (pathname) => pathname === "/settings/workspace/sandboxes",
      },
      {
        href: "/settings/workspace/capabilities",
        icon: SearchCheck,
        label: "Capabilities",
        isActive: (pathname) => pathname === "/settings/workspace/capabilities",
      },
      {
        href: "/skills",
        icon: Sparkles,
        label: "Skills",
        leavesSettings: true,
      },
      {
        href: "/plugins",
        icon: PackageOpen,
        label: "Plugins",
        leavesSettings: true,
      },
      {
        href: "/settings/repositories",
        icon: FolderGit2,
        label: "Repositories",
        isActive: (pathname) => pathname === "/settings/repositories",
      },
      {
        href: "/settings/workspace/usage",
        icon: CircleDollarSign,
        label: "Usage",
        isActive: (pathname) => pathname === "/settings/workspace/usage",
      },
      {
        href: "/settings/workspace/billing",
        icon: CreditCard,
        label: "Billing",
        isActive: (pathname) => pathname === "/settings/workspace/billing",
      },
      {
        href: "/settings/workspace",
        icon: Users,
        label: "Members",
        isActive: (pathname) => pathname === "/settings/workspace",
      },
    ],
  },
  {
    label: "Channels",
    items: [
      {
        href: "/settings/workspace/slack",
        icon: MessageSquare,
        label: "Slack",
        badge: "Beta",
        adminOnly: true,
        isActive: (pathname) => pathname === "/settings/workspace/slack",
      },
    ],
  },
];

function SettingsNavRow({ item, active }: { item: SettingsNavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <IntentPrefetchLink
      href={item.href}
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
      <span className="truncate tracking-[-0.005em]">{item.label}</span>
      {item.badge ? (
        <span className="ml-auto shrink-0 rounded-full bg-surface-muted px-1.5 py-px text-[10px] font-medium leading-4 text-ink-subtle">
          {item.badge}
        </span>
      ) : null}
      {item.leavesSettings ? (
        <ArrowUpRight
          size={13}
          strokeWidth={1.75}
          aria-hidden
          className="ml-auto shrink-0 text-ink-subtle/70 group-hover:text-ink/60"
        />
      ) : null}
    </IntentPrefetchLink>
  );
}

// Settings-scoped sidebar. Shell swaps this in for the primary Sidebar while the user is
// anywhere under /settings, so the whole left rail becomes a table of contents for settings.
export function SettingsSidebar({
  collapsed,
  onToggleCollapsed,
  showCollapseButton = true,
}: {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  showCollapseButton?: boolean;
}) {
  const pathname = usePathname();
  const isAdmin = useAppDataOptional()?.workspace.role === "admin";

  return (
    <aside
      className={`relative h-full shrink-0 overflow-hidden bg-sidebar transition-[width] duration-200 ease-out ${
        collapsed ? "w-0" : "w-[256px]"
      }`}
      aria-hidden={collapsed}
    >
      <div className="flex h-full w-[256px] flex-col">
        {/* Header: collapse control + return to the app */}
        <div className="flex items-center gap-1 px-2 pb-2 pt-3">
          {showCollapseButton ? (
            <button
              type="button"
              aria-label="Collapse sidebar"
              aria-expanded={!collapsed}
              onClick={onToggleCollapsed}
              className="rounded-md p-1.5 text-ink/60 transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
            >
              <PanelLeft size={15} strokeWidth={1.75} />
            </button>
          ) : null}
          <Link
            href="/"
            prefetch
            className="group flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-[13px] text-ink/80 transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            <ArrowLeft
              size={14}
              strokeWidth={1.75}
              className="shrink-0 text-ink/60 transition-colors group-hover:text-ink/80"
            />
            <span className="truncate font-medium tracking-[-0.005em]">Back to app</span>
          </Link>
        </div>

        <div className="px-3 pb-1 pt-3">
          <span className="text-[15px] font-semibold tracking-[-0.01em] text-ink">Settings</span>
        </div>

        <nav
          aria-label="Settings"
          className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-2 pb-6 pt-3"
        >
          {NAV_GROUPS.map((group) => (
            <div key={group.label} className="flex flex-col gap-px">
              <div className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-ink-subtle">
                {group.label}
              </div>
              {group.items
                .filter((item) => !item.adminOnly || isAdmin)
                .map((item) => (
                  <SettingsNavRow
                    key={item.href}
                    item={item}
                    active={item.isActive?.(pathname) ?? false}
                  />
                ))}
            </div>
          ))}
        </nav>
      </div>
    </aside>
  );
}
