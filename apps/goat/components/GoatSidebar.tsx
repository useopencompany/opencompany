"use client";

import type { LucideIcon } from "lucide-react";
import { Brain, House, PanelLeft, Settings } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useGoatAppData } from "@/components/GoatAppDataProvider";

function SidebarNavRow({
  href,
  icon: Icon,
  label,
  active,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  active: boolean;
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
  const { user } = useGoatAppData();
  const pathname = usePathname();
  const brainActive = pathname === "/brain" || pathname.startsWith("/brain/");
  const settingsActive = pathname === "/settings" || pathname.startsWith("/settings/");
  const homeActive = !brainActive && !settingsActive;

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
            className="rounded-md p-1.5 text-ink/60 transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            <PanelLeft size={15} strokeWidth={1.75} />
          </button>
          <span className="truncate px-1 text-[13px] font-semibold tracking-[-0.01em] text-ink">
            Goat
          </span>
        </div>

        {/* Primary nav */}
        <nav aria-label="Goat primary" className="flex flex-col gap-px px-2 pt-2">
          <SidebarNavRow href="/" icon={House} label="Home" active={homeActive} />
          <SidebarNavRow href="/brain" icon={Brain} label="Brain" active={brainActive} />
        </nav>

        <div className="min-h-0 flex-1" />

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

function getInitials(firstName: string | null, lastName: string | null, email: string) {
  const initials = [firstName, lastName]
    .map((part) => part?.trim().at(0))
    .filter(Boolean)
    .join("")
    .toUpperCase();

  return initials || email.trim().at(0)?.toUpperCase() || "?";
}
