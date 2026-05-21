"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import {
  PanelLeft,
  Bot,
  BookText,
  Building2,
  Inbox,
  LogOut,
  MoreHorizontal,
  MessageSquarePlus,
  Network,
  Users,
} from "lucide-react";

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

export default function Sidebar({
  userName,
  userEmail,
  workspaceName,
}: {
  userName: string;
  userEmail: string;
  workspaceName: string;
}) {
  const pathname = usePathname();
  const isHome = pathname === "/";
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <aside className="relative flex h-full w-[232px] shrink-0 flex-col bg-sidebar after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-[#e6e6e3]">
      {/* Top icons */}
      <div className="flex items-center gap-1 px-2 pt-3 pb-2">
        <button
          aria-label="Toggle sidebar"
          className="rounded-md p-1.5 text-ink/60 transition-colors duration-150 hover:bg-[#ebebe8] hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        >
          <PanelLeft size={15} strokeWidth={1.75} />
        </button>
      </div>

      {/* Primary nav */}
      <nav className="flex flex-col gap-px px-2 pt-1">
        <NavItem href="/inbox" icon={Inbox} label="Inbox" active={isActive("/inbox")} />
        <NavItem href="/" icon={MessageSquarePlus} label="New Session" active={isHome} />
        <NavItem href="/wiki" icon={BookText} label="Wiki" active={isActive("/wiki")} />
        <NavItem href="/agents" icon={Bot} label="Agents" active={isActive("/agents")} />
        <NavItem
          href="/org-chart"
          icon={Network}
          label="Org Chart"
          active={isActive("/org-chart")}
        />
        <NavItem href="/people" icon={Users} label="People" active={isActive("/people")} />
        <NavItem
          href="/companies"
          icon={Building2}
          label="Companies"
          active={isActive("/companies")}
        />
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
      <div className="flex items-center gap-2.5 border-t border-[#eaeae6] px-3 py-2.5">
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
          <span title={userEmail} className="truncate text-[12.5px] font-medium tracking-[-0.005em] text-ink">
            {userName}
          </span>
          <span className="truncate text-[11px] text-ink-subtle">{workspaceName}</span>
        </div>
        <div className="ml-auto flex items-center gap-0.5 text-ink-muted">
          <button className="rounded-md p-1 transition-colors duration-150 hover:bg-[#ebebe8] hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20">
            <MoreHorizontal size={14} strokeWidth={1.75} />
          </button>
          <Link
            href="/auth/sign-out"
            aria-label="Sign out"
            title="Sign out"
            className="rounded-md p-1 transition-colors duration-150 hover:bg-[#ebebe8] hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            <LogOut size={14} strokeWidth={1.75} />
          </Link>
        </div>
      </div>
    </aside>
  );
}
