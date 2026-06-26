"use client";

import { useLiveQuery } from "@tanstack/react-db";
import type { LucideIcon } from "lucide-react";
import {
  Archive,
  Blocks,
  Bot,
  Brain,
  // CircleEqual,
  // Download,
  Inbox,
  ListFilter,
  MessageSquarePlus,
  PanelLeft,
  Pin,
  Plug,
  Search,
  X,
  // Sparkles,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCollections } from "@/components/CollectionsProvider";
import { SessionStatusDot } from "@/components/SessionStatusDot";
import { SidebarAccountFooter } from "@/components/SidebarAccountFooter";
import { SpaceSwitcher } from "@/components/SpaceSwitcher";
import { useToast } from "@/components/ToastProvider";
import { useHydrated } from "@/components/useHydrated";
import { useWorkspaceContext } from "@/components/WorkspaceContext";
import type { SidebarSessionPayload } from "@/lib/agent-sessions/payload";
import { BRAIN_BASE_PATH } from "@/lib/brain/paths";
import { deriveSidebarSessions } from "@/lib/collections/selectors";

const SIDEBAR_STORAGE_KEY = "opencompany-sidebar-collapsed";
const SIDEBAR_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
// Debounce route prefetches so dragging across the history list doesn't fire one per item.
const SESSION_PREFETCH_HOVER_DELAY_MS = 150;
// How long the red highlight shows on a session row before it is optimistically removed.
const ARCHIVE_HIGHLIGHT_DELAY_MS = 220;

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
      router.prefetch(`/company/session/${session.id}`);
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
        href={`/company/session/${session.id}`}
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
        ) : session.unseen && !active ? (
          // Unseen finished turn (completed/failed/awaiting_*) on a session you're not
          // looking at — the "new activity" blue dot. Suppressed for the active session.
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: "var(--color-info)" }}
            aria-label="New activity"
          />
        ) : session.status === "awaiting_approval" ||
          session.status === "awaiting_input" ||
          session.status === "awaiting_delegation" ||
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
    const date = new Date(session.createdAt);
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
  const { agents, agentSessions, sessionStars } = useCollections();
  const { showError, showToast } = useToast();
  // Sessions with an in-flight pin toggle. Guards rapid re-clicks from firing an
  // insert against an already-optimistically-inserted star (duplicate key).
  const pinTogglesInFlight = useRef<Set<string>>(new Set());

  const { data: sessionRows, isLoading: sessionsBusy } = useLiveQuery((q) =>
    q.from({ session: agentSessions }),
  );
  const { data: agentRows, isLoading: agentsBusy } = useLiveQuery((q) => q.from({ agent: agents }));
  const { data: starRows } = useLiveQuery((q) => q.from({ star: sessionStars }));
  const liveSessions = useMemo(
    () => deriveSidebarSessions(sessionRows ?? [], starRows ?? [], agentRows ?? []),
    [sessionRows, starRows, agentRows],
  );
  // Keep showing the server list until the collection has hydrated, so there is
  // no skeleton flash on navigation.
  const sessions = sessionsBusy || agentsBusy ? initialSessions : liveSessions;

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
      // Optimistic: the row is already gone, so confirm right away. A failure rolls the row back
      // into the sidebar and the catch below surfaces the error toast.
      showToast({ title: "Chat archived" });
      if (active) router.replace("/company");
      void tx.isPersisted.promise.catch((error) => {
        showError(
          error instanceof Error ? error.message : "Could not archive session.",
          "Could not archive session",
        );
      });
    },
    [agentSessions, router, showError, showToast],
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
  const { workspaceId } = useWorkspaceContext();
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [filterOpen, setFilterOpen] = useState(false);
  const [sessionQuery, setSessionQuery] = useState("");
  const isHome = pathname === "/company";
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
  }

  return (
    <>
      <aside
        className={`relative h-full shrink-0 overflow-hidden bg-sidebar transition-[width] duration-200 ease-out ${
          collapsed ? "w-[256px] md:w-0" : "w-[256px]"
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
              onClick={() => updateCollapsed(true)}
              className="rounded-md p-1.5 text-ink/60 transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
            >
              <PanelLeft size={15} strokeWidth={1.75} />
            </button>
            <SpaceSwitcher
              activeSpace="workspace"
              workspaceName={workspaceName}
              workspaceHref={pathname}
              className="min-w-0 flex-1 px-0 pb-0"
            />
          </div>

          {/* Primary nav */}
          <nav className="flex flex-col gap-px px-2 pt-2">
            <NavItem href="/company" icon={MessageSquarePlus} label="New Session" active={isHome} />
            <NavItem
              href="/company/agents"
              icon={Bot}
              label="Agents"
              active={isActive("/company/agents")}
            />
            <NavItem
              href="/company/skills"
              icon={Blocks}
              label="Skills"
              active={isActive("/company/skills")}
            />
            <NavItem
              href={BRAIN_BASE_PATH}
              icon={Brain}
              label="Brain"
              active={isActive(BRAIN_BASE_PATH)}
            />
            <NavItem
              href="/company/integrations"
              icon={Plug}
              label="Integrations"
              active={isActive("/company/integrations")}
            />
            <NavItem
              href="/company/inbox"
              icon={Inbox}
              label="Inbox"
              active={isActive("/company/inbox")}
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
                  className="h-7 w-full rounded-md border border-border bg-surface/55 pl-7 pr-7 text-[16px] md:text-[12.5px] text-ink outline-none placeholder:text-ink-subtle focus:border-border-strong focus:ring-2 focus:ring-ink/[0.04]"
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
                          active={pathname === `/company/session/${session.id}`}
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
                          active={pathname === `/company/session/${session.id}`}
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

          <SidebarAccountFooter
            userName={userName}
            userEmail={userEmail}
            subtitle={workspaceName}
            workspaceId={workspaceId}
            trailing={
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
            }
          />
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
    </>
  );
}
