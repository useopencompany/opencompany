"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";
import {
  Archive,
  Bot,
  Brain,
  ChevronRight,
  // CircleEqual,
  CircleHelp,
  // Download,
  Inbox,
  ListFilter,
  LogOut,
  MessageSquarePlus,
  PanelLeft,
  ScrollText,
  Search,
  Settings,
  X,
  // Sparkles,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import FeedbackDialog from "@/components/FeedbackDialog";
import { SessionStatusDot } from "@/components/SessionStatusDot";
import { useToast } from "@/components/ToastProvider";
import { useWorkspaceContext } from "@/components/WorkspaceContext";
import { archiveAgentSession } from "@/lib/agent-sessions/actions";
import {
  fetchSidebarSessions,
  removeSidebarSession,
  SESSIONS_QUERY_STALE_TIME_MS,
  type SidebarSessionPayload,
  sessionQueryKeys,
} from "@/lib/agent-sessions/payload";

const SIDEBAR_STORAGE_KEY = "opencompany-sidebar-collapsed";
const SIDEBAR_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
// Debounce route prefetches so dragging across the history list doesn't fire one per item.
const SESSION_PREFETCH_HOVER_DELAY_MS = 150;

export type SidebarSession = SidebarSessionPayload;

function persistSidebarCollapsed(collapsed: boolean) {
  window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(collapsed));
  document.cookie = `${SIDEBAR_STORAGE_KEY}=${String(collapsed)}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
}

function SoonBadge() {
  return (
    <span className="rounded-[3px] bg-[#ececea] px-1 py-px text-[8.5px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
      Soon
    </span>
  );
}

function NavItem({
  href,
  icon: Icon,
  label,
  active,
  trailing,
  disabled,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  active?: boolean;
  trailing?: React.ReactNode;
  disabled?: boolean;
}) {
  const content = (
    <>
      <Icon
        size={14}
        strokeWidth={1.75}
        className={active ? "text-ink" : "text-ink/60 group-hover:text-ink/80"}
      />
      <span className="truncate tracking-[-0.005em]">{label}</span>
      {trailing && <span className="ml-auto flex items-center gap-1.5">{trailing}</span>}
    </>
  );
  const className = `group flex w-full items-center gap-2.5 rounded-md px-2 py-[5px] text-[13px] transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
    disabled
      ? "cursor-not-allowed text-ink/35"
      : active
        ? "bg-[#e3e3df] text-ink"
        : "text-ink/90 hover:bg-[#ebebe8] hover:text-ink"
  }`;

  if (disabled) {
    return (
      <div aria-disabled="true" className={className}>
        {content}
      </div>
    );
  }

  return (
    <Link href={href} className={className}>
      {content}
    </Link>
  );
}

function SessionHistoryItem({
  session,
  active,
  workspaceId,
}: {
  session: SidebarSession;
  active?: boolean;
  workspaceId: string;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { showError } = useToast();
  const [isPending, startTransition] = useTransition();
  const prefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const schedulePrefetch = useCallback(() => {
    if (prefetchTimerRef.current) return;
    prefetchTimerRef.current = setTimeout(() => {
      prefetchTimerRef.current = null;
      router.prefetch(`/session/${session.id}`);
    }, SESSION_PREFETCH_HOVER_DELAY_MS);
  }, [router, session.id]);

  const cancelPrefetch = useCallback(() => {
    if (!prefetchTimerRef.current) return;
    clearTimeout(prefetchTimerRef.current);
    prefetchTimerRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      if (prefetchTimerRef.current) clearTimeout(prefetchTimerRef.current);
    };
  }, []);

  return (
    <div
      className={`group flex items-center rounded-md text-[13px] transition-colors duration-150 ${
        active ? "bg-[#e3e3df] text-ink" : "text-ink/90 hover:bg-[#ebebe8] hover:text-ink"
      } ${isPending ? "opacity-60" : ""}`}
    >
      <Link
        href={`/session/${session.id}`}
        title={session.lastError ?? session.title}
        onMouseEnter={schedulePrefetch}
        onMouseLeave={cancelPrefetch}
        onFocus={schedulePrefetch}
        onBlur={cancelPrefetch}
        onTouchStart={schedulePrefetch}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-l-md px-2 py-[5px] focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
      >
        {session.status === "running" || session.status === "provisioning" ? (
          <SessionStatusDot status={session.status} pulse />
        ) : null}
        <span className="min-w-0 flex-1 truncate tracking-[-0.005em]">{session.title}</span>
      </Link>
      <button
        type="button"
        title="Archive session"
        aria-label={`Archive ${session.title}`}
        disabled={isPending}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();

          startTransition(async () => {
            const result = await archiveAgentSession(session.id);
            if (!result.ok) {
              showError(result.error, "Could not archive session");
              return;
            }
            queryClient.setQueryData<SidebarSession[]>(
              sessionQueryKeys.list(workspaceId),
              (sessions) => removeSidebarSession(sessions, session.id),
            );
            queryClient.removeQueries({
              queryKey: sessionQueryKeys.detail(workspaceId, session.id),
            });
            void queryClient.invalidateQueries({ queryKey: sessionQueryKeys.list(workspaceId) });
            if (active) {
              router.replace("/");
            }
          });
        }}
        className={`mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-subtle transition-opacity duration-150 hover:bg-[#dededa] hover:text-ink focus:opacity-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-not-allowed ${
          isPending
            ? "opacity-100"
            : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
        }`}
      >
        <Archive size={12.5} strokeWidth={1.8} />
      </button>
    </div>
  );
}

function filterSessions(sessions: SidebarSession[], query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return sessions;

  return sessions.filter((session) =>
    [session.title, session.status, session.modelName]
      .filter(Boolean)
      .some((value) => value.toLowerCase().includes(normalized)),
  );
}

function groupSessions(sessions: SidebarSession[]) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  const groups: Array<{ label: string; sessions: SidebarSession[] }> = [
    { label: "Today", sessions: [] },
    { label: "Yesterday", sessions: [] },
    { label: "Last 7 days", sessions: [] },
    { label: "Earlier", sessions: [] },
  ];
  const todayGroup = groups[0]!;
  const yesterdayGroup = groups[1]!;
  const lastWeekGroup = groups[2]!;
  const earlierGroup = groups[3]!;

  for (const session of sessions) {
    const date = new Date(session.updatedAt);
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const age = Math.floor((today - day) / dayMs);

    if (age <= 0) todayGroup.sessions.push(session);
    else if (age === 1) yesterdayGroup.sessions.push(session);
    else if (age < 7) lastWeekGroup.sessions.push(session);
    else earlierGroup.sessions.push(session);
  }

  return groups.filter((group) => group.sessions.length > 0);
}

function SessionHistorySkeleton() {
  return (
    <div className="space-y-4 px-2" role="status" aria-label="Loading sessions">
      {[0, 1].map((group) => (
        <div key={group}>
          <div className="mb-2 h-3 w-16 rounded bg-[#e0e0dc]" />
          <div className="space-y-1.5">
            {[0, 1, 2].map((row) => (
              <div key={row} className="h-6 rounded-md bg-[#e8e8e4]" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function AccountMenu({
  userName,
  userEmail,
  onClose,
  onFeedbackOpen,
}: {
  userName: string;
  userEmail: string;
  onClose: () => void;
  onFeedbackOpen: () => void;
}) {
  const menuItems: Array<{
    icon: LucideIcon;
    label: string;
    detail?: string;
    href?: string;
    action?: () => void;
  }> = [
    { icon: MessageSquarePlus, label: "Feedback", action: onFeedbackOpen },
    { icon: Settings, label: "Settings", href: "/settings" },
    // { icon: Download, label: "Download Open Company macOS" },
    // { icon: CircleEqual, label: "Appearance", detail: "System" },
    { icon: ScrollText, label: "Changelog", href: "/changelog" },
    { icon: CircleHelp, label: "Docs", href: "/docs" },
  ];

  return (
    <div className="absolute bottom-[52px] left-3 z-20 w-[220px] overflow-hidden rounded-lg border border-black/[0.08] bg-[#fbfbfa] shadow-[0_16px_36px_rgba(0,0,0,0.12),0_2px_8px_rgba(0,0,0,0.08)]">
      <div className="px-3 pb-3 pt-3">
        <div className="text-[13.5px] font-medium leading-[1.2] tracking-[-0.01em] text-ink">
          {userName}
        </div>
        <div className="mt-0.5 text-[12.5px] leading-[1.2] text-ink-subtle">{userEmail}</div>
        {/* <button
          type="button"
          onClick={onClose}
          className="mt-3 flex h-7 w-full items-center justify-center gap-2 rounded-md border border-black/[0.09] bg-white/30 px-3 text-[13px] font-medium tracking-[-0.005em] text-ink shadow-[inset_0_0_0_1px_rgba(255,255,255,0.65)] transition-colors duration-150 hover:bg-white/70 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        >
          <Sparkles size={15} strokeWidth={1.85} className="text-ink/85" />
          Upgrade to Pro+
        </button> */}
      </div>

      <div className="border-t border-black/[0.07] py-2">
        {menuItems.map(({ icon: Icon, label, detail, href, action }) => {
          const inner = (
            <>
              <Icon size={15.5} strokeWidth={1.8} className="shrink-0 text-ink/60" />
              <span className="min-w-0 flex-1 truncate">{label}</span>
              {detail && <span className="text-ink-subtle">{detail}</span>}
              {(detail || href || label === "Help") && (
                <ChevronRight size={14} strokeWidth={1.8} className="shrink-0 text-ink/35" />
              )}
            </>
          );
          const className =
            "flex h-[29px] w-full items-center gap-2.5 px-3 text-left text-[13px] font-medium tracking-[-0.005em] text-ink transition-colors duration-150 hover:bg-[#eeeeeb] focus:outline-none focus-visible:bg-[#eeeeeb]";

          if (href) {
            return (
              <Link key={label} href={href} onClick={onClose} className={className}>
                {inner}
              </Link>
            );
          }
          return (
            <button
              key={label}
              type="button"
              onClick={() => {
                action?.();
                onClose();
              }}
              className={className}
            >
              {inner}
            </button>
          );
        })}
      </div>

      <div className="border-t border-black/[0.07] py-2">
        <a
          href="/auth/sign-out"
          onClick={onClose}
          className="flex h-[29px] w-full items-center gap-2.5 px-3 text-left text-[13px] font-medium tracking-[-0.005em] text-ink transition-colors duration-150 hover:bg-[#eeeeeb] focus:outline-none focus-visible:bg-[#eeeeeb]"
        >
          <LogOut size={15.5} strokeWidth={1.8} className="shrink-0 text-ink/60" />
          <span>Log Out</span>
        </a>
      </div>
    </div>
  );
}

export default function Sidebar({
  userName,
  userEmail,
  workspaceName,
  initialCollapsed,
  initialSessions,
  sessionsLoading = false,
}: {
  userName: string;
  userEmail: string;
  workspaceName: string;
  initialCollapsed: boolean;
  initialSessions: SidebarSession[];
  sessionsLoading?: boolean;
}) {
  const pathname = usePathname();
  const { workspaceId } = useWorkspaceContext();
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [filterOpen, setFilterOpen] = useState(false);
  const [sessionQuery, setSessionQuery] = useState("");
  const footerRef = useRef<HTMLDivElement>(null);
  const { data: queriedSessions, isPending } = useQuery({
    queryKey: sessionQueryKeys.list(workspaceId),
    queryFn: fetchSidebarSessions,
    initialData: sessionsLoading ? undefined : initialSessions,
    enabled: !sessionsLoading,
    staleTime: SESSIONS_QUERY_STALE_TIME_MS,
  });
  const sessions = queriedSessions ?? initialSessions;
  const showSessionsLoading = sessionsLoading || (isPending && sessions.length === 0);
  const isHome = pathname === "/";
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  const filteredSessions = useMemo(
    () => filterSessions(sessions, sessionQuery),
    [sessions, sessionQuery],
  );
  const groupedSessions = useMemo(() => groupSessions(filteredSessions), [filteredSessions]);

  function updateCollapsed(nextCollapsed: boolean) {
    setCollapsed(nextCollapsed);
    persistSidebarCollapsed(nextCollapsed);

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
            <NavItem href="/" icon={MessageSquarePlus} label="New Session" active={isHome} />
            <NavItem href="/agents" icon={Bot} label="Agents" active={isActive("/agents")} />
            <NavItem href="/brain" icon={Brain} label="Brain" active={isActive("/brain")} />
            <NavItem
              href="/inbox"
              icon={Inbox}
              label="Inbox"
              active={isActive("/inbox")}
              trailing={<SoonBadge />}
              disabled
            />
          </nav>

          {/* History */}
          <div className="mt-5 flex flex-1 flex-col overflow-y-auto px-2">
            {filterOpen && (
              <div className="relative mb-2 px-1">
                <Search
                  size={12}
                  strokeWidth={1.8}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-subtle"
                />
                <input
                  value={sessionQuery}
                  onChange={(event) => setSessionQuery(event.target.value)}
                  placeholder="Filter sessions"
                  className="h-7 w-full rounded-md border border-[#e4e4e0] bg-white/55 pl-7 pr-7 text-[12.5px] text-ink outline-none placeholder:text-ink-subtle focus:border-[#d4d4cf] focus:ring-2 focus:ring-ink/[0.04]"
                />
                {sessionQuery && (
                  <button
                    type="button"
                    aria-label="Clear session filter"
                    onClick={() => setSessionQuery("")}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-ink-subtle hover:bg-[#ececea] hover:text-ink"
                  >
                    <X size={11.5} strokeWidth={2} />
                  </button>
                )}
              </div>
            )}

            {showSessionsLoading ? (
              <SessionHistorySkeleton />
            ) : sessions.length === 0 ? (
              <div className="mx-2 mt-2 rounded-md border border-dashed border-[#deded9] bg-white/35 px-2.5 py-3 text-[12px] leading-5 text-ink-muted">
                Sessions you start from agents will appear here.
              </div>
            ) : filteredSessions.length === 0 ? (
              <div className="mx-2 mt-2 rounded-md border border-dashed border-[#deded9] bg-white/35 px-2.5 py-3 text-[12px] leading-5 text-ink-muted">
                No sessions match this filter.
              </div>
            ) : (
              groupedSessions.map((group, index) => (
                <div key={group.label} className={index === 0 ? "" : "pt-3"}>
                  <div className="px-2 pb-1 text-[10.5px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
                    {group.label}
                  </div>
                  <div className="flex flex-col gap-px">
                    {group.sessions.map((session) => (
                      <SessionHistoryItem
                        key={session.id}
                        session={session}
                        workspaceId={workspaceId}
                        active={pathname === `/session/${session.id}`}
                      />
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Footer profile */}
          <div
            ref={footerRef}
            className="relative flex items-center gap-2.5 border-t border-[#eaeae6] px-3 py-2.5"
          >
            {accountMenuOpen && (
              <AccountMenu
                userName={userName}
                userEmail={userEmail}
                onClose={() => setAccountMenuOpen(false)}
                onFeedbackOpen={() => setFeedbackOpen(true)}
              />
            )}
            <button
              type="button"
              aria-label="Open account menu"
              aria-expanded={accountMenuOpen}
              onClick={() => setAccountMenuOpen((open) => !open)}
              className={`-mx-1.5 flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1.5 py-1.5 transition-colors duration-150 hover:bg-[#ebebe8] focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
                accountMenuOpen ? "bg-[#e3e3df]" : ""
              }`}
            >
              <div
                aria-hidden
                className="h-6 w-6 shrink-0 rounded-full ring-1 ring-black/[0.06]"
                style={{
                  background:
                    "radial-gradient(circle at 30% 30%, #c9d9ff 0%, #3b5bdb 35%, #0b1224 80%)",
                  boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.18), 0 1px 2px rgba(0,0,0,0.08)",
                }}
              />
              <div className="flex min-w-0 flex-col leading-tight text-left">
                <span
                  title={userEmail}
                  className="truncate text-[12.5px] font-medium tracking-[-0.005em] text-ink"
                >
                  {userName}
                </span>
                <span className="truncate text-[11px] text-ink-subtle">{workspaceName}</span>
              </div>
            </button>
            <div className="ml-auto flex items-center gap-0.5 text-ink-muted">
              <button
                type="button"
                aria-label="Filter sessions"
                aria-pressed={filterOpen}
                className={`rounded-md p-1 transition-colors duration-150 hover:bg-[#ebebe8] hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
                  filterOpen ? "bg-[#e3e3df] text-ink" : ""
                }`}
                onClick={() => setFilterOpen((open) => !open)}
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

      <FeedbackDialog open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
    </>
  );
}
