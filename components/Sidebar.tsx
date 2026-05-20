"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  PanelLeft,
  Bot,
  Brain,
  ChevronRight,
  CircleEqual,
  CircleHelp,
  Download,
  Inbox,
  LogOut,
  MoreHorizontal,
  ListFilter,
  MessageSquarePlus,
  Settings,
  Sparkles,
} from "lucide-react";

const SIDEBAR_STORAGE_KEY = "cursor-sidebar-collapsed";

function getStoredSidebarCollapsed() {
  if (typeof window === "undefined") return false;

  return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === "true";
}

function NavItem({
  href,
  icon: Icon,
  label,
  active,
  trailing,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  active?: boolean;
  trailing?: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`group flex w-full items-center gap-2.5 rounded-md px-2 py-[5px] text-[13px] transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
        active
          ? "bg-[#e3e3df] text-ink"
          : "text-ink/90 hover:bg-[#ebebe8] hover:text-ink"
      }`}
    >
      <Icon
        size={14}
        strokeWidth={1.75}
        className={active ? "text-ink" : "text-ink/60 group-hover:text-ink/80"}
      />
      <span className="truncate tracking-[-0.005em]">{label}</span>
      {trailing && <span className="ml-auto flex items-center gap-1.5">{trailing}</span>}
    </Link>
  );
}

function HistoryItem({
  href,
  label,
  dot,
  diff,
  active,
}: {
  href: string;
  label: string;
  dot?: boolean;
  diff?: { added: number; removed: number };
  active?: boolean;
}) {
  return (
    <Link
      href={href}
      className={`group flex w-full items-center gap-2.5 rounded-md px-2 py-[5px] text-[13px] transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
        active
          ? "bg-[#e3e3df] text-ink"
          : "text-ink/90 hover:bg-[#ebebe8] hover:text-ink"
      }`}
    >
      {dot ? (
        <span className="ml-[2px] mr-[2px] inline-block h-1.5 w-1.5 rounded-full bg-[#16a34a] shadow-[0_0_0_2px_rgba(22,163,74,0.12)]" />
      ) : (
        <span className="ml-[2px] mr-[2px] inline-block h-1.5 w-1.5" />
      )}
      <span className="truncate tracking-[-0.005em]">{label}</span>
      {diff && (
        <span className="ml-auto flex items-center gap-1.5 text-[11.5px] font-medium tabular-nums">
          <span className="text-[#16a34a]">+{diff.added.toLocaleString()}</span>
          <span className="text-[#dc2626]">−{diff.removed}</span>
        </span>
      )}
    </Link>
  );
}

function AccountMenu({ onClose }: { onClose: () => void }) {
  const menuItems = [
    { icon: Settings, label: "Settings" },
    { icon: Download, label: "Download Cursor macOS" },
    { icon: CircleEqual, label: "Appearance", detail: "System" },
    { icon: CircleHelp, label: "Help" },
  ];

  return (
    <div className="absolute bottom-[52px] left-3 z-20 w-[220px] overflow-hidden rounded-lg border border-black/[0.08] bg-[#fbfbfa] shadow-[0_16px_36px_rgba(0,0,0,0.12),0_2px_8px_rgba(0,0,0,0.08)]">
      <div className="px-3 pb-3 pt-3">
        <div className="text-[13.5px] font-medium leading-[1.2] tracking-[-0.01em] text-ink">
          Louis Morgner
        </div>
        <div className="mt-0.5 text-[12.5px] leading-[1.2] text-ink-subtle">louis@acta.so</div>
        <button
          type="button"
          onClick={onClose}
          className="mt-3 flex h-7 w-full items-center justify-center gap-2 rounded-md border border-black/[0.09] bg-white/30 px-3 text-[13px] font-medium tracking-[-0.005em] text-ink shadow-[inset_0_0_0_1px_rgba(255,255,255,0.65)] transition-colors duration-150 hover:bg-white/70 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        >
          <Sparkles size={15} strokeWidth={1.85} className="text-ink/85" />
          Upgrade to Pro+
        </button>
      </div>

      <div className="border-t border-black/[0.07] py-2">
        {menuItems.map(({ icon: Icon, label, detail }) => (
          <button
            key={label}
            type="button"
            onClick={onClose}
            className="flex h-[29px] w-full items-center gap-2.5 px-3 text-left text-[13px] font-medium tracking-[-0.005em] text-ink transition-colors duration-150 hover:bg-[#eeeeeb] focus:outline-none focus-visible:bg-[#eeeeeb]"
          >
            <Icon size={15.5} strokeWidth={1.8} className="shrink-0 text-ink/60" />
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {detail && <span className="text-ink-subtle">{detail}</span>}
            {(detail || label === "Help") && (
              <ChevronRight size={14} strokeWidth={1.8} className="shrink-0 text-ink/35" />
            )}
          </button>
        ))}
      </div>

      <div className="border-t border-black/[0.07] py-2">
        <button
          type="button"
          onClick={onClose}
          className="flex h-[29px] w-full items-center gap-2.5 px-3 text-left text-[13px] font-medium tracking-[-0.005em] text-ink transition-colors duration-150 hover:bg-[#eeeeeb] focus:outline-none focus-visible:bg-[#eeeeeb]"
        >
          <LogOut size={15.5} strokeWidth={1.8} className="shrink-0 text-ink/60" />
          <span>Log Out</span>
        </button>
      </div>
    </div>
  );
}

export default function Sidebar() {
  const pathname = usePathname();
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(getStoredSidebarCollapsed);
  const footerRef = useRef<HTMLDivElement>(null);
  const isHome = pathname === "/";
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  function updateCollapsed(nextCollapsed: boolean) {
    setCollapsed(nextCollapsed);
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(nextCollapsed));

    if (nextCollapsed) {
      setAccountMenuOpen(false);
    }
  }

  useEffect(() => {
    if (!accountMenuOpen) return;

    function handlePointerDown(event: PointerEvent) {
      if (!footerRef.current?.contains(event.target as Node)) {
        setAccountMenuOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setAccountMenuOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [accountMenuOpen]);

  return (
    <>
      <aside
        className={`relative h-full shrink-0 overflow-hidden bg-sidebar transition-[width] duration-200 ease-out after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-[#e6e6e3] after:transition-opacity after:duration-200 ${
          collapsed ? "w-0 after:opacity-0" : "w-[232px] after:opacity-100"
        }`}
        aria-hidden={collapsed}
      >
        <div className="flex h-full w-[232px] flex-col">
          {/* Top icons */}
          <div className="flex items-center gap-1 px-2 pb-2 pt-3">
            <button
              type="button"
              aria-label="Collapse sidebar"
              aria-expanded={!collapsed}
              onClick={() => updateCollapsed(true)}
              className="rounded-md p-1.5 text-ink/60 transition-colors duration-150 hover:bg-[#ebebe8] hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
            >
              <PanelLeft size={15} strokeWidth={1.75} />
            </button>
          </div>

          {/* Primary nav */}
          <nav className="flex flex-col gap-px px-2 pt-1">
            <NavItem href="/inbox" icon={Inbox} label="Inbox" active={isActive("/inbox")} />
            <NavItem href="/" icon={MessageSquarePlus} label="New Session" active={isHome} />
            <NavItem href="/brain" icon={Brain} label="Brain" active={isActive("/brain")} />
            <NavItem href="/agents" icon={Bot} label="Agents" active={isActive("/agents")} />
          </nav>

          {/* History */}
          <div className="mt-5 flex flex-1 flex-col overflow-y-auto px-2">
            <div className="px-2 pb-1 pt-1 text-[10.5px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
              Yesterday
            </div>
            <HistoryItem
              href="/session/dev-env-setup"
              label="Development environme..."
              dot
              diff={{ added: 10451, removed: 1 }}
              active={pathname === "/session/dev-env-setup"}
            />

            <div className="px-2 pb-1 pt-4 text-[10.5px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
              Last 7 days
            </div>
            <HistoryItem
              href="/session/current-work-understanding"
              label="Current work understanding"
              active={pathname === "/session/current-work-understanding"}
            />
          </div>

          {/* Footer profile */}
          <div
            ref={footerRef}
            className="relative flex items-center gap-2.5 border-t border-[#eaeae6] px-3 py-2.5"
          >
            {accountMenuOpen && <AccountMenu onClose={() => setAccountMenuOpen(false)} />}
            <div
              aria-hidden
              className="h-6 w-6 shrink-0 rounded-full ring-1 ring-black/[0.06]"
              style={{
                background:
                  "radial-gradient(circle at 30% 30%, #c9d9ff 0%, #3b5bdb 35%, #0b1224 80%)",
                boxShadow:
                  "inset 0 0 0 1px rgba(255,255,255,0.18), 0 1px 2px rgba(0,0,0,0.08)",
              }}
            />
            <div className="flex min-w-0 flex-col leading-tight">
              <span className="truncate text-[12.5px] font-medium tracking-[-0.005em] text-ink">
                Louis Morgner
              </span>
              <span className="truncate text-[11px] text-ink-subtle">Pro</span>
            </div>
            <div className="ml-auto flex items-center gap-0.5 text-ink-muted">
              <button
                type="button"
                aria-label="Open account menu"
                aria-expanded={accountMenuOpen}
                className={`rounded-md p-1 transition-colors duration-150 hover:bg-[#ebebe8] hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
                  accountMenuOpen ? "bg-[#e3e3df] text-ink" : ""
                }`}
                onClick={() => setAccountMenuOpen((open) => !open)}
              >
                <MoreHorizontal size={14} strokeWidth={1.75} />
              </button>
              <button
                type="button"
                aria-label="Filter sessions"
                className="rounded-md p-1 transition-colors duration-150 hover:bg-[#ebebe8] hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
              >
                <ListFilter size={14} strokeWidth={1.75} />
              </button>
            </div>
          </div>
        </div>
      </aside>

      {collapsed && (
        <button
          type="button"
          aria-label="Expand sidebar"
          aria-expanded={false}
          onClick={() => updateCollapsed(false)}
          className="fixed left-2 top-3 z-50 rounded-md border border-[#e6e6e3] bg-canvas/85 p-1.5 text-ink/60 shadow-[0_1px_2px_rgba(15,15,15,0.04)] backdrop-blur-md transition-colors duration-150 hover:bg-[#ebebe8] hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        >
          <PanelLeft size={15} strokeWidth={1.75} />
        </button>
      )}
    </>
  );
}
