"use client";

import { useLiveQuery } from "@tanstack/react-db";
import { useQuery } from "@tanstack/react-query";
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
  Pin,
  ScrollText,
  Search,
  Settings,
  X,
  // Sparkles,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCollections } from "@/components/CollectionsProvider";
import FeedbackDialog from "@/components/FeedbackDialog";
import { SessionStatusDot } from "@/components/SessionStatusDot";
import { SpaceSwitcher } from "@/components/SpaceSwitcher";
import { useToast } from "@/components/ToastProvider";
import { useHydrated } from "@/components/useHydrated";
import { useWorkspaceContext } from "@/components/WorkspaceContext";
import type { SidebarSessionPayload } from "@/lib/agent-sessions/payload";
import { deriveSidebarSessions } from "@/lib/collections/selectors";

const SIDEBAR_STORAGE_KEY = "opencompany-sidebar-collapsed";
const SIDEBAR_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
// Debounce route prefetches so dragging across the history list doesn't fire one per item.
const SESSION_PREFETCH_HOVER_DELAY_MS = 150;
// How long the red highlight shows on a session row before it is optimistically removed.
const ARCHIVE_HIGHLIGHT_DELAY_MS = 220;
const STATUS_PAGE_URL = "https://myopencompany.betteruptime.com";
const STATUS_PAGE_JSON_URL = `${STATUS_PAGE_URL}/index.json`;
const STATUS_PAGE_QUERY_STALE_TIME_MS = 60 * 1000;
const ACCOUNT_MENU_ITEM_CLASS =
  "flex h-[29px] w-full items-center gap-2.5 px-3 text-left text-[13px] font-medium tracking-[-0.005em] text-ink transition-colors duration-150 hover:bg-surface-hover focus:outline-none focus-visible:bg-surface-hover";

type StatusPageAggregateState = "operational" | "degraded" | "downtime" | "maintenance";

async function fetchStatusPageAggregateState(): Promise<StatusPageAggregateState> {
  const response = await fetch(STATUS_PAGE_JSON_URL, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Status page request failed with ${response.status}.`);
  }

  const payload: unknown = await response.json();
  const aggregateState = readAggregateState(payload);
  if (!aggregateState) {
    throw new Error("Status page response did not include a recognized aggregate state.");
  }
  return aggregateState;
}

function readAggregateState(payload: unknown): StatusPageAggregateState | null {
  if (!isRecord(payload)) return null;
  const data = payload.data;
  if (!isRecord(data)) return null;
  const attributes = data.attributes;
  if (!isRecord(attributes)) return null;
  const aggregateState = attributes.aggregate_state;
  if (
    aggregateState === "operational" ||
    aggregateState === "degraded" ||
    aggregateState === "downtime" ||
    aggregateState === "maintenance"
  ) {
    return aggregateState;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function statusPageMeta({
  aggregateState,
  pending,
  error,
}: {
  aggregateState: StatusPageAggregateState | undefined;
  pending: boolean;
  error: boolean;
}) {
  if (pending) {
    return {
      label: "Checking status",
      description: "Checking status",
      dotClassName: "bg-ink-subtle/45",
    };
  }
  if (error || !aggregateState) {
    return {
      label: "Status unavailable",
      description: "Status unavailable",
      dotClassName: "bg-ink-subtle/45",
    };
  }
  if (aggregateState === "operational") {
    return {
      label: "All systems operational",
      description: "All systems operational",
      dotClassName: "bg-success",
    };
  }
  if (aggregateState === "downtime") {
    return {
      label: "Service disruption",
      description: "Service disruption",
      dotClassName: "bg-danger",
    };
  }
  if (aggregateState === "maintenance") {
    return {
      label: "Maintenance",
      description: "Maintenance",
      dotClassName: "bg-warning",
    };
  }
  return {
    label: "Service degraded",
    description: "Service degraded",
    dotClassName: "bg-warning",
  };
}

export type SidebarSession = SidebarSessionPayload;

function persistSidebarCollapsed(collapsed: boolean) {
  window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(collapsed));
  document.cookie = `${SIDEBAR_STORAGE_KEY}=${String(collapsed)}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
}

function SoonBadge() {
  return (
    <span className="rounded-[3px] bg-surface-subtle px-1 py-px text-[8.5px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
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
        ? "bg-surface-active text-ink"
        : "text-ink/90 hover:bg-surface-hover hover:text-ink"
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
  starred,
  onToggleStar,
  onArchive,
}: {
  session: SidebarSession;
  active?: boolean;
  starred?: boolean;
  onToggleStar: (sessionId: string, currentlyStarred: boolean) => void;
  onArchive: (sessionId: string, active: boolean) => void;
}) {
  const router = useRouter();
  const [archiving, setArchiving] = useState(false);
  const prefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const archiveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      if (archiveTimerRef.current) clearTimeout(archiveTimerRef.current);
    };
  }, []);

  return (
    <div
      className={`group flex items-center rounded-md text-[13px] transition-all duration-150 ${
        active ? "bg-surface-active text-ink" : "text-ink/90 hover:bg-surface-hover hover:text-ink"
      } ${archiving ? "ring-1 ring-red-500/80 bg-red-500/10" : ""}`}
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
        {session.status === "running" ||
        session.status === "provisioning" ||
        session.status === "awaiting_approval" ||
        session.status === "awaiting_input" ||
        session.status === "interrupted" ? (
          <SessionStatusDot status={session.status} pulse />
        ) : null}
        <span className="min-w-0 flex-1 truncate tracking-[-0.005em]">{session.title}</span>
      </Link>
      <button
        type="button"
        title={starred ? "Unpin session" : "Pin session"}
        aria-label={starred ? `Unpin ${session.title}` : `Pin ${session.title}`}
        aria-pressed={starred}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onToggleStar(session.id, Boolean(starred));
        }}
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-subtle transition-opacity duration-150 hover:bg-surface-active hover:text-ink focus:opacity-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
          starred
            ? "opacity-100"
            : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
        }`}
      >
        <Pin size={11.5} strokeWidth={1.8} fill={starred ? "currentColor" : "none"} />
      </button>
      <button
        type="button"
        title="Archive session"
        aria-label={`Archive ${session.title}`}
        aria-busy={archiving}
        disabled={archiving}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();

          // Brief red highlight as feedback before the optimistic delete removes
          // the row from the sidebar (onArchive archives via the collection).
          setArchiving(true);
          archiveTimerRef.current = setTimeout(() => {
            archiveTimerRef.current = null;
            onArchive(session.id, Boolean(active));
          }, ARCHIVE_HIGHLIGHT_DELAY_MS);
        }}
        className={`mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-subtle transition-opacity duration-150 hover:bg-surface-active hover:text-ink focus:opacity-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-not-allowed ${
          archiving
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
          <div className="mb-2 h-3 w-16 rounded bg-surface-subtle" />
          <div className="space-y-1.5">
            {[0, 1, 2].map((row) => (
              <div key={row} className="h-6 rounded-md bg-surface-subtle" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function StatusPageMenuItem({ onClose }: { onClose: () => void }) {
  const statusQuery = useQuery({
    queryKey: ["status-page", STATUS_PAGE_JSON_URL],
    queryFn: fetchStatusPageAggregateState,
    staleTime: STATUS_PAGE_QUERY_STALE_TIME_MS,
    retry: false,
  });
  const meta = statusPageMeta({
    aggregateState: statusQuery.data,
    pending: statusQuery.isPending,
    error: statusQuery.isError,
  });

  return (
    <a
      href={STATUS_PAGE_URL}
      target="_blank"
      rel="noreferrer"
      onClick={onClose}
      className="mt-3 flex min-w-0 items-center gap-2 rounded-md py-1 text-[12.5px] leading-4 text-ink-subtle transition-colors duration-150 hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
      title={meta.description}
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 shrink-0 rounded-full shadow-[0_0_0_2px_rgba(15,15,15,0.04)] ${meta.dotClassName}`}
      />
      <span className="truncate">{meta.label}</span>
    </a>
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
    <div className="absolute bottom-[60px] left-1 z-20 w-[220px] overflow-hidden rounded-lg border border-black/[0.08] bg-surface-raised shadow-[0_16px_36px_rgba(0,0,0,0.12),0_2px_8px_rgba(0,0,0,0.08)]">
      <div className="px-3 pb-3 pt-3">
        <div className="text-[13.5px] font-medium leading-[1.2] tracking-[-0.01em] text-ink">
          {userName}
        </div>
        <div className="mt-0.5 text-[12.5px] leading-[1.2] text-ink-subtle">{userEmail}</div>
        <StatusPageMenuItem onClose={onClose} />
        {/* <button
          type="button"
          onClick={onClose}
          className="mt-3 flex h-7 w-full items-center justify-center gap-2 rounded-md border border-black/[0.09] bg-surface/30 px-3 text-[13px] font-medium tracking-[-0.005em] text-ink shadow-[inset_0_0_0_1px_rgba(255,255,255,0.65)] transition-colors duration-150 hover:bg-surface/70 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
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

          if (href) {
            return (
              <Link key={label} href={href} onClick={onClose} className={ACCOUNT_MENU_ITEM_CLASS}>
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
              className={ACCOUNT_MENU_ITEM_CLASS}
            >
              {inner}
            </button>
          );
        })}
      </div>

      <div className="border-t border-black/[0.07] py-2">
        <a href="/auth/sign-out" onClick={onClose} className={ACCOUNT_MENU_ITEM_CLASS}>
          <LogOut size={15.5} strokeWidth={1.8} className="shrink-0 text-ink/60" />
          <span>Log Out</span>
        </a>
      </div>
    </div>
  );
}

type SidebarChromeProps = {
  userName: string;
  userEmail: string;
  workspaceName: string;
  initialCollapsed: boolean;
};

// Pre-hydration / Suspense-fallback renders have no live collection to mutate;
// the buttons exist for markup parity but can't be clicked before hydration.
const noopToggleStar = () => {};
const noopArchive = () => {};

export default function Sidebar({
  userName,
  userEmail,
  workspaceName,
  initialCollapsed,
  initialSessions,
  sessionsLoading = false,
}: SidebarChromeProps & {
  initialSessions: SidebarSession[];
  sessionsLoading?: boolean;
}) {
  const hydrated = useHydrated();
  const chrome = { userName, userEmail, workspaceName, initialCollapsed };

  // SSR + first client render (and the Suspense loading fallback) render from the
  // server-provided list with no live query, so the hydrated markup matches the
  // server HTML. `useLiveQuery` is client-only and must not run during SSR.
  if (!hydrated || sessionsLoading) {
    return (
      <SidebarContent
        {...chrome}
        sessions={initialSessions}
        showSessionsLoading={sessionsLoading}
        onToggleStar={noopToggleStar}
        onArchive={noopArchive}
      />
    );
  }

  return <SidebarLive {...chrome} initialSessions={initialSessions} />;
}

// Client-only: subscribes the agent_sessions + session_stars collections via
// useLiveQuery and wires optimistic star/archive writes through them.
function SidebarLive({
  initialSessions,
  ...chrome
}: SidebarChromeProps & { initialSessions: SidebarSession[] }) {
  const router = useRouter();
  const { userId } = useWorkspaceContext();
  const { agentSessions, sessionStars } = useCollections();
  const { showError } = useToast();
  // Sessions with an in-flight pin toggle. Guards rapid re-clicks from firing an
  // insert against an already-optimistically-inserted star (duplicate key).
  const pinTogglesInFlight = useRef<Set<string>>(new Set());

  const { data: sessionRows, isLoading: sessionsBusy } = useLiveQuery((q) =>
    q.from({ session: agentSessions }),
  );
  const { data: starRows } = useLiveQuery((q) => q.from({ star: sessionStars }));
  const liveSessions = useMemo(
    () => deriveSidebarSessions(sessionRows ?? [], starRows ?? []),
    [sessionRows, starRows],
  );
  // Keep showing the server list until the collection has hydrated, so there is
  // no skeleton flash on navigation.
  const sessions = sessionsBusy ? initialSessions : liveSessions;

  // Star state is server-truth (per user, persisted, cross-device). Toggling
  // inserts/deletes a row in the session_stars collection optimistically; the
  // collection's onInsert/onDelete persist via setSessionStar and reconcile by
  // txid. A failure auto-rolls back the optimistic change.
  const handleToggleStar = useCallback(
    (sessionId: string, currentlyStarred: boolean) => {
      if (pinTogglesInFlight.current.has(sessionId)) return;
      pinTogglesInFlight.current.add(sessionId);

      const tx = currentlyStarred
        ? sessionStars.delete(sessionId)
        : sessionStars.insert({
            session_id: sessionId,
            user_id: userId,
            starred_at: new Date().toISOString(),
          });

      void tx.isPersisted.promise
        .catch((error) => {
          showError(
            error instanceof Error ? error.message : "Could not reach the server.",
            currentlyStarred ? "Could not unpin session" : "Could not pin session",
          );
        })
        .finally(() => pinTogglesInFlight.current.delete(sessionId));
    },
    [sessionStars, userId, showError],
  );

  // Archive is the sidebar's soft delete: remove the row from the agent_sessions
  // collection optimistically (it vanishes at once) and navigate home if the
  // archived session is open. The collection's onDelete archives via the server
  // action; a failure rolls the row back and surfaces the error.
  const handleArchive = useCallback(
    (sessionId: string, active: boolean) => {
      const tx = agentSessions.delete(sessionId);
      if (active) router.replace("/");
      void tx.isPersisted.promise.catch((error) => {
        showError(
          error instanceof Error ? error.message : "Could not archive session.",
          "Could not archive session",
        );
      });
    },
    [agentSessions, router, showError],
  );

  return (
    <SidebarContent
      {...chrome}
      sessions={sessions}
      showSessionsLoading={false}
      onToggleStar={handleToggleStar}
      onArchive={handleArchive}
    />
  );
}

function SidebarContent({
  userName,
  userEmail,
  workspaceName,
  initialCollapsed,
  sessions,
  showSessionsLoading,
  onToggleStar,
  onArchive,
}: SidebarChromeProps & {
  sessions: SidebarSession[];
  showSessionsLoading: boolean;
  onToggleStar: (sessionId: string, currentlyStarred: boolean) => void;
  onArchive: (sessionId: string, active: boolean) => void;
}) {
  const pathname = usePathname();
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [filterOpen, setFilterOpen] = useState(false);
  const [sessionQuery, setSessionQuery] = useState("");
  const footerRef = useRef<HTMLDivElement>(null);
  const isHome = pathname === "/";
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  const filteredSessions = useMemo(
    () => filterSessions(sessions, sessionQuery),
    [sessions, sessionQuery],
  );

  // Partition into starred (ordered by most-recently-starred) and unstarred (ordered by recency).
  const { starredSessions, unstarredSessions } = useMemo(() => {
    const starred: SidebarSession[] = [];
    const unstarred: SidebarSession[] = [];
    for (const session of filteredSessions) {
      if (session.starredAt) {
        starred.push(session);
      } else {
        unstarred.push(session);
      }
    }
    starred.sort((a, b) => Date.parse(b.starredAt ?? "0") - Date.parse(a.starredAt ?? "0"));
    return { starredSessions: starred, unstarredSessions: unstarred };
  }, [filteredSessions]);

  const groupedSessions = useMemo(() => groupSessions(unstarredSessions), [unstarredSessions]);

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
        className={`relative h-full shrink-0 overflow-hidden bg-sidebar transition-[width] duration-200 ease-out after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-border after:transition-opacity after:duration-200 ${
          collapsed ? "w-0 after:opacity-0" : "w-[256px] after:opacity-100"
        }`}
        aria-hidden={collapsed}
      >
        <div className="flex h-full w-[256px] flex-col">
          {/* Top icons */}
          <div className="flex items-center gap-1 px-2 pb-2 pt-3">
            <button
              type="button"
              aria-label="Collapse sidebar"
              aria-expanded={!collapsed}
              onClick={() => updateCollapsed(true)}
              className="rounded-md p-1.5 text-ink/60 transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
            >
              <PanelLeft size={15} strokeWidth={1.75} />
            </button>
          </div>

          <SpaceSwitcher
            activeSpace="workspace"
            workspaceName={workspaceName}
            workspaceHref={pathname}
          />

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
                  className="h-7 w-full rounded-md border border-border bg-surface/55 pl-7 pr-7 text-[12.5px] text-ink outline-none placeholder:text-ink-subtle focus:border-border-strong focus:ring-2 focus:ring-ink/[0.04]"
                />
                {sessionQuery && (
                  <button
                    type="button"
                    aria-label="Clear session filter"
                    onClick={() => setSessionQuery("")}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-ink-subtle hover:bg-surface-subtle hover:text-ink"
                  >
                    <X size={11.5} strokeWidth={2} />
                  </button>
                )}
              </div>
            )}

            {showSessionsLoading ? (
              <SessionHistorySkeleton />
            ) : sessions.length === 0 ? (
              <div className="mx-2 mt-2 rounded-md border border-dashed border-border bg-surface/35 px-2.5 py-3 text-[12px] leading-5 text-ink-muted">
                Sessions you start from agents will appear here.
              </div>
            ) : filteredSessions.length === 0 ? (
              <div className="mx-2 mt-2 rounded-md border border-dashed border-border bg-surface/35 px-2.5 py-3 text-[12px] leading-5 text-ink-muted">
                No sessions match this filter.
              </div>
            ) : (
              <>
                {starredSessions.length > 0 && (
                  <div className="pb-3">
                    <div className="flex items-center gap-1 px-2 pb-1">
                      <Pin
                        size={9}
                        strokeWidth={2}
                        fill="currentColor"
                        className="text-ink-subtle"
                      />
                      <span className="text-[10.5px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
                        Pinned
                      </span>
                    </div>
                    <div className="flex flex-col gap-px">
                      {starredSessions.map((session) => (
                        <SessionHistoryItem
                          key={session.id}
                          session={session}
                          active={pathname === `/session/${session.id}`}
                          starred
                          onToggleStar={onToggleStar}
                          onArchive={onArchive}
                        />
                      ))}
                    </div>
                  </div>
                )}
                {groupedSessions.map((group, index) => (
                  <div
                    key={group.label}
                    className={index === 0 && starredSessions.length === 0 ? "" : "pt-3"}
                  >
                    <div className="px-2 pb-1 text-[10.5px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
                      {group.label}
                    </div>
                    <div className="flex flex-col gap-px">
                      {group.sessions.map((session) => (
                        <SessionHistoryItem
                          key={session.id}
                          session={session}
                          active={pathname === `/session/${session.id}`}
                          starred={false}
                          onToggleStar={onToggleStar}
                          onArchive={onArchive}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>

          {/* Footer profile */}
          <div
            ref={footerRef}
            className="relative flex items-center gap-2.5 border-t border-border-subtle px-3 py-2.5"
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
              className={`-mx-1.5 flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1.5 py-1.5 transition-colors duration-150 hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
                accountMenuOpen ? "bg-surface-active" : ""
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
                className={`rounded-md p-1 transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
                  filterOpen ? "bg-surface-active text-ink" : ""
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
          className="fixed left-2 top-3 z-50 rounded-md border border-border bg-canvas/85 p-1.5 text-ink/60 shadow-[0_1px_2px_rgba(15,15,15,0.04)] backdrop-blur-md transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        >
          <PanelLeft size={15} strokeWidth={1.75} />
        </button>
      )}

      <FeedbackDialog open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
    </>
  );
}
