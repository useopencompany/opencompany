"use client";

import { Send } from "@opencompany/ui/icons";
import { useLiveQuery } from "@tanstack/react-db";
import type { LucideIcon } from "lucide-react";
import {
  Archive,
  Blocks,
  Bot,
  Brain,
  BrainCircuit,
  ChevronDown,
  Clock3,
  MessageCircle,
  PanelLeft,
  Pencil,
  Pin,
  Plug,
  ScrollText,
  Sparkles,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useCollections } from "@/components/CollectionsProvider";
import { usePersonalAgent } from "@/components/personal/PersonalAgentContext";
import { personalIntegrationCount } from "@/components/personal/PersonalCapabilityPanel";
import { SessionStatusDot } from "@/components/SessionStatusDot";
import { SidebarAccountFooter } from "@/components/SidebarAccountFooter";
import { SpaceSwitcher } from "@/components/SpaceSwitcher";
import { useOptionalOpenSession } from "@/components/session-split/PersonalSessionSplit";
import { useOptionalSessionDrag } from "@/components/session-split/SessionDragContext";
import { useToast } from "@/components/ToastProvider";
import { useHydrated } from "@/components/useHydrated";
import { useWorkspaceContext } from "@/components/WorkspaceContext";
import type { SidebarSessionPayload } from "@/lib/agent-sessions/payload";
import { derivePersonalSidebarSessions, deriveVisibleInbox } from "@/lib/collections/selectors";
import { PERSONAL_INTEGRATION_TOOL_IDS } from "@/lib/personal/integrations-catalog";
import { personalPaths } from "@/lib/personal/paths";
import { writeSessionDragPayload } from "@/types/session-layout";

// How long the red highlight shows on a session row before it is optimistically removed.
const ARCHIVE_HIGHLIGHT_DELAY_MS = 220;
// Debounce session route prefetches so moving across history rows does not stampede the dev server.
const SESSION_PREFETCH_HOVER_DELAY_MS = 150;

type SidebarSession = SidebarSessionPayload;

// A clickable capability/behavior row that navigates to its surface. Capability rows show a count
// of how many of that thing the agent's `.agent` config currently has.
function CapabilityNavRow({
  icon: Icon,
  label,
  active,
  count,
  proBadge,
  href,
}: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  count?: number;
  proBadge?: boolean;
  href: string;
}) {
  return (
    <Link
      href={href}
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
      {proBadge && (
        <span className="ml-auto rounded-[3px] bg-ink/[0.07] px-1 py-px text-[9px] font-semibold uppercase tracking-[0.04em] text-ink-subtle">
          Pro
        </span>
      )}
      {count !== undefined && count > 0 && (
        <span className={`${proBadge ? "" : "ml-auto"} text-[11px] tabular-nums text-ink-subtle`}>
          {count}
        </span>
      )}
    </Link>
  );
}

// A collapsible parent nav row that toggles a set of child capability rows. Used to group
// Skills / Integrations / Tools / Channels under a single "Capabilities" entry.
function CapabilityGroupRow({
  icon: Icon,
  label,
  childActive,
  children,
}: {
  icon: LucideIcon;
  label: string;
  childActive: boolean;
  children: React.ReactNode;
}) {
  // Default open when one of the children is the active surface, so the highlight is visible.
  const [open, setOpen] = useState(childActive);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="group flex w-full items-center gap-2.5 rounded-md px-2 py-[5px] text-left text-[13px] text-ink/90 transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
      >
        <Icon
          size={14}
          strokeWidth={1.75}
          className="shrink-0 text-ink/60 group-hover:text-ink/80"
        />
        <span className="truncate tracking-[-0.005em]">{label}</span>
        <ChevronDown
          size={13}
          strokeWidth={2}
          className={`ml-auto shrink-0 text-ink-subtle transition-transform duration-150 ${
            open ? "" : "-rotate-90"
          }`}
        />
      </button>
      {open && <div className="mt-px flex flex-col gap-px pl-3.5">{children}</div>}
    </div>
  );
}

function Section({
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="px-2 pt-4">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="group flex w-full items-center gap-1 px-2 pb-1 text-[10.5px] font-medium uppercase tracking-[0.06em] text-ink-subtle transition-colors duration-150 hover:text-ink/70 focus:outline-none"
        aria-expanded={open}
      >
        <span>{title}</span>
        <ChevronDown
          size={11}
          strokeWidth={2}
          className={`ml-auto text-ink-subtle transition-transform duration-150 ${
            open ? "" : "-rotate-90"
          }`}
        />
      </button>
      {open && <div className="flex flex-col gap-px">{children}</div>}
    </div>
  );
}

function groupSessions(sessions: SidebarSession[]) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  // Today's sessions render without a header — the label is only used to
  // separate older time frames below them.
  const groups: Array<{ label: string; sessions: SidebarSession[]; hideLabel?: boolean }> = [
    { label: "Today", sessions: [], hideLabel: true },
    { label: "Yesterday", sessions: [] },
    { label: "Last 7 days", sessions: [] },
    { label: "Earlier", sessions: [] },
  ];
  const [todayGroup, yesterdayGroup, lastWeekGroup, earlierGroup] = groups as [
    (typeof groups)[number],
    (typeof groups)[number],
    (typeof groups)[number],
    (typeof groups)[number],
  ];

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

// Right-click menu for a session row. Rendered through a portal at the cursor so it
// is never clipped by the sidebar's overflow, and clamped to stay on-screen. Closes
// on Escape or any outside interaction (mousedown / scroll / resize / blur).
function SessionRowMenu({
  x,
  y,
  starred,
  onRename,
  onTogglePin,
  onArchive,
  onClose,
}: {
  x: number;
  y: number;
  starred: boolean;
  onRename: () => void;
  onTogglePin: () => void;
  onArchive: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      left: Math.min(x, window.innerWidth - rect.width - 8),
      top: Math.min(y, window.innerHeight - rect.height - 8),
    });
  }, [x, y]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onClose);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    window.addEventListener("keydown", onKey);
    document.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("mousedown", onClose);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  const item =
    "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] text-ink hover:bg-surface-hover focus:outline-none";

  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={{ position: "fixed", left: pos.left, top: pos.top }}
      onMouseDown={(event) => event.stopPropagation()}
      className="z-50 min-w-[172px] rounded-md border border-border bg-surface p-1 text-ink shadow-[0_12px_32px_rgba(0,0,0,0.12),0_2px_8px_rgba(0,0,0,0.08)]"
    >
      <button
        type="button"
        role="menuitem"
        className={item}
        onClick={() => {
          onClose();
          onRename();
        }}
      >
        <Pencil size={13} strokeWidth={1.8} className="text-ink-subtle" />
        Rename
      </button>
      <button
        type="button"
        role="menuitem"
        className={item}
        onClick={() => {
          onClose();
          onTogglePin();
        }}
      >
        <Pin size={13} strokeWidth={1.8} className="text-ink-subtle" />
        {starred ? "Unpin" : "Pin"}
      </button>
      <div className="my-1 h-px bg-ink/10" />
      <button
        type="button"
        role="menuitem"
        className={item}
        onClick={() => {
          onClose();
          onArchive();
        }}
      >
        <Archive size={13} strokeWidth={1.8} className="text-ink-subtle" />
        Archive
      </button>
    </div>,
    document.body,
  );
}

function SessionRow({
  session,
  active,
  starred,
  onSelect,
  onToggleStar,
  onArchive,
  onRename,
}: {
  session: SidebarSession;
  active: boolean;
  starred?: boolean;
  onSelect: (sessionId: string) => void;
  onToggleStar: (sessionId: string, currentlyStarred: boolean) => void;
  onArchive: (sessionId: string, active: boolean) => void;
  onRename: (sessionId: string, title: string) => void;
}) {
  const router = useRouter();
  const [archiving, setArchiving] = useState(false);
  const prefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const archiveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Inline rename: double-click the title (or pick Rename from the right-click menu)
  // to edit in place. `editing` swaps the title button for an input; `menu` holds the
  // open context menu's cursor position (or null). `editingRef` guards commit/cancel
  // so the blur handler can't double-fire after Enter/Escape already resolved.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const editingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Split-pane integration (null on surfaces without a split provider): rows are
  // drag sources for the session canvas, and clicks post an open-request so the
  // canvas can swap/flash panes even when the URL doesn't change.
  const drag = useOptionalSessionDrag();
  const openSession = useOptionalOpenSession();
  const href = personalPaths.session(session.id);

  const schedulePrefetch = useCallback(() => {
    if (prefetchTimerRef.current) return;
    prefetchTimerRef.current = setTimeout(() => {
      prefetchTimerRef.current = null;
      router.prefetch(href);
    }, SESSION_PREFETCH_HOVER_DELAY_MS);
  }, [href, router]);

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

  // Focus + select the field whenever we enter edit mode.
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const startEditing = useCallback(() => {
    editingRef.current = true;
    setDraft(session.title);
    setEditing(true);
  }, [session.title]);

  const commitEditing = useCallback(() => {
    if (!editingRef.current) return;
    editingRef.current = false;
    setEditing(false);
    const next = draft.trim();
    if (next && next !== session.title) {
      onRename(session.id, next);
    } else {
      setDraft(session.title);
    }
  }, [draft, onRename, session.id, session.title]);

  const cancelEditing = useCallback(() => {
    if (!editingRef.current) return;
    editingRef.current = false;
    setEditing(false);
    setDraft(session.title);
  }, [session.title]);

  const archiveNow = useCallback(() => {
    // Brief red highlight as feedback before the optimistic delete removes the row
    // from the sidebar (onArchive archives via the collection).
    setArchiving(true);
    archiveTimerRef.current = setTimeout(() => {
      archiveTimerRef.current = null;
      onArchive(session.id, active);
    }, ARCHIVE_HIGHLIGHT_DELAY_MS);
  }, [active, onArchive, session.id]);

  return (
    <div
      draggable={Boolean(drag) && !editing}
      onDragStart={
        drag
          ? (event) => {
              writeSessionDragPayload(event.dataTransfer, {
                id: session.id,
                name: session.title,
              });
              // Defer the state flip so the browser captures the drag image before
              // React re-renders (a synchronous re-render during dragstart cancels
              // the drag in some browsers).
              setTimeout(() => drag.startDrag({ id: session.id, name: session.title }), 0);
            }
          : undefined
      }
      onDragEnd={drag ? () => drag.endDrag() : undefined}
      onContextMenu={(event) => {
        if (editing) return;
        event.preventDefault();
        setMenu({ x: event.clientX, y: event.clientY });
      }}
      className={`group flex items-center rounded-md text-[13px] transition-all duration-150 ${
        active ? "bg-surface-active text-ink" : "text-ink/90 hover:bg-surface-hover hover:text-ink"
      } ${archiving ? "ring-1 ring-red-500/80 bg-red-500/10" : ""}`}
    >
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitEditing();
            } else if (event.key === "Escape") {
              event.preventDefault();
              cancelEditing();
            }
          }}
          onBlur={commitEditing}
          aria-label="Session name"
          className="min-w-0 flex-1 rounded-md bg-surface px-2 py-[5px] text-[13px] text-ink outline-none ring-1 ring-ink/25 focus-visible:ring-ink/40"
        />
      ) : (
        <button
          type="button"
          onMouseEnter={schedulePrefetch}
          onMouseLeave={cancelPrefetch}
          onFocus={schedulePrefetch}
          onBlur={cancelPrefetch}
          onTouchStart={schedulePrefetch}
          onClick={() => {
            openSession?.openSession({ id: session.id, name: session.title });
            onSelect(session.id);
          }}
          onDoubleClick={(event) => {
            event.preventDefault();
            startEditing();
          }}
          title={session.lastError ?? session.title}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-l-md px-2 py-[5px] text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
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
          {session.source === "whatsapp" ? (
            <MessageCircle
              size={12}
              strokeWidth={2}
              className="shrink-0 text-emerald-600"
              aria-label="WhatsApp"
            />
          ) : null}
        </button>
      )}
      {!editing ? (
        <>
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
              archiveNow();
            }}
            className={`mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-subtle transition-opacity duration-150 hover:bg-surface-active hover:text-ink focus:opacity-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-not-allowed ${
              archiving
                ? "opacity-100"
                : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
            }`}
          >
            <Archive size={12.5} strokeWidth={1.8} />
          </button>
        </>
      ) : null}
      {menu ? (
        <SessionRowMenu
          x={menu.x}
          y={menu.y}
          starred={Boolean(starred)}
          onRename={startEditing}
          onTogglePin={() => onToggleStar(session.id, Boolean(starred))}
          onArchive={archiveNow}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}

// Client-only: keep the personal session list live by reading the agent_sessions
// collection (scoped to the current workspace/user by the shape proxy) and filtering
// to this agent. Falls back to the server-rendered list until the collection hydrates.
function useLivePersonalSessions(agentId: string, initialSessions: SidebarSession[]) {
  const { agentSessions, sessionStars } = useCollections();
  const { data: rows, isLoading } = useLiveQuery((q) => q.from({ session: agentSessions }));
  const { data: starRows } = useLiveQuery((q) => q.from({ star: sessionStars }));

  return useMemo(() => {
    if (isLoading || !rows) return initialSessions;
    return derivePersonalSidebarSessions(agentId, rows, starRows ?? []);
  }, [rows, starRows, isLoading, agentId, initialSessions]);
}

// Live count of visible inbox items, for the Home nav badge. Mirrors PersonalInbox's derivation
// (open + elapsed-snooze) and ticks slowly so a snooze waking re-counts without a refresh.
function useLiveInboxCount() {
  const { inboxItems } = useCollections();
  const { data: rows, isLoading } = useLiveQuery((q) => q.from({ item: inboxItems }));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  return isLoading || !rows ? 0 : deriveVisibleInbox(rows, now).length;
}

// Derive which surface is active from the URL so the sidebar highlight always tracks the route.
function useActivePersonalRoute() {
  const pathname = usePathname();
  const segments = pathname.split("/").filter(Boolean); // e.g. ["personal", "files", "memory", "x.md"]
  const [, section, ...rest] = segments;

  const inboxActive = segments.length === 1; // exactly "/personal"
  const activePanel =
    section === "agent" ||
    section === "brain" ||
    section === "routines" ||
    section === "memory" ||
    section === "settings" ||
    section === "skills" ||
    section === "integrations" ||
    section === "tools" ||
    section === "channels"
      ? section
      : null;
  const activeSessionId = section === "session" ? (rest[0] ?? null) : null;
  // Files live at /personal/files/<...segments>; the "new" route is the create form, not a file.
  const activeFilePath =
    section === "files" && rest.length > 0 && rest[0] !== "new"
      ? rest.map((part) => decodeURIComponent(part)).join("/")
      : null;

  return { inboxActive, activePanel, activeSessionId, activeFilePath };
}

// Hydration gate. useLiveQuery (inside useLivePersonalSessions) reads useSyncExternalStore with no
// server snapshot, so — exactly like Sidebar/SidebarLive, MainPanel, SessionView and AgentsView —
// it must only be subscribed AFTER hydration. Mounting it during the SSR / first client render
// leaves the collection's load state stuck, so new sessions never stream in and the list only
// updates on a full refresh. Until hydrated we render the server-provided list.
export default function PersonalSidebar(props: {
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const hydrated = useHydrated();
  const { initialSessions } = usePersonalAgent();
  if (!hydrated) return <PersonalSidebarView {...props} sessions={initialSessions} />;
  return <PersonalSidebarLive {...props} />;
}

// Client-only: subscribes the agent_sessions collection via useLiveQuery and feeds the live,
// agent-scoped session list into the presentational sidebar.
function PersonalSidebarLive(props: { collapsed: boolean; onToggleCollapsed: () => void }) {
  const { agent, initialSessions } = usePersonalAgent();
  const sessions = useLivePersonalSessions(agent.id, initialSessions);
  const inboxCount = useLiveInboxCount();
  return <PersonalSidebarView {...props} sessions={sessions} inboxCount={inboxCount} />;
}

function PersonalSidebarView({
  sessions,
  collapsed,
  onToggleCollapsed,
  inboxCount = 0,
}: {
  sessions: SidebarSession[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
  inboxCount?: number;
}) {
  const router = useRouter();
  const { userId, workspaceId } = useWorkspaceContext();
  const { agentSessions, sessionStars } = useCollections();
  const { showError, showToast } = useToast();
  const {
    agent,
    userName,
    userEmail,
    workspaceName,
    workspaces,
    config,
    personalSkills,
    githubRequested,
    proMode,
    companySurfaceEnabled,
  } = usePersonalAgent();
  const { inboxActive, activePanel, activeSessionId, activeFilePath } = useActivePersonalRoute();
  // Sessions with an in-flight pin toggle. Guards rapid re-clicks from firing an
  // insert against an already-optimistically-inserted star (duplicate key).
  const pinTogglesInFlight = useRef<Set<string>>(new Set());

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

  // Archive is the sidebar's soft delete: optimistically remove the row from the
  // agent_sessions collection (it vanishes at once) and navigate home if the archived
  // session is the one open. The collection's onDelete archives via the server action;
  // a failure rolls the row back and surfaces the error.
  const handleArchive = useCallback(
    (sessionId: string, active: boolean) => {
      const tx = agentSessions.delete(sessionId);
      // Optimistic: the row is already gone, so confirm right away. A failure rolls the row back
      // into the sidebar and the catch below surfaces the error toast.
      showToast({ title: "Chat archived" });
      if (active) router.replace(personalPaths.home);
      void tx.isPersisted.promise.catch((error) => {
        showError(
          error instanceof Error ? error.message : "Could not archive session.",
          "Could not archive session",
        );
      });
    },
    [agentSessions, router, showError, showToast],
  );

  // Rename optimistically updates the title in the agent_sessions collection (the
  // sidebar reflects it at once); the collection's onUpdate persists it via the server
  // action, and a failure rolls the row back and surfaces the error.
  const handleRename = useCallback(
    (sessionId: string, title: string) => {
      const next = title.trim();
      if (!next) return;
      const tx = agentSessions.update(sessionId, (draft) => {
        draft.title = next;
      });
      void tx.isPersisted.promise.catch((error) => {
        showError(
          error instanceof Error ? error.message : "Could not rename session.",
          "Could not rename session",
        );
      });
    },
    [agentSessions, showError],
  );

  const { starredSessions, unstarredSessions } = useMemo(() => {
    const starred: SidebarSession[] = [];
    const unstarred: SidebarSession[] = [];
    for (const session of sessions) {
      if (session.starredAt) {
        starred.push(session);
      } else {
        unstarred.push(session);
      }
    }
    starred.sort((a, b) => Date.parse(b.starredAt ?? "0") - Date.parse(a.starredAt ?? "0"));
    return { starredSessions: starred, unstarredSessions: unstarred };
  }, [sessions]);
  const groupedSessions = useMemo(() => groupSessions(unstarredSessions), [unstarredSessions]);
  const showSessionsSection = sessions.length === 0 || unstarredSessions.length > 0;
  const skillCount = (config.skills?.length ?? 0) + personalSkills.length;
  const integrationCount = personalIntegrationCount({ config, githubRequested });
  const toolCount = config.tools.filter(
    (tool) => !PERSONAL_INTEGRATION_TOOL_IDS.has(tool.id),
  ).length;

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
          <SpaceSwitcher
            activeSpace="personal"
            activeWorkspaceId={workspaceId}
            workspaceName={workspaceName}
            workspaces={workspaces}
            hideWorkspace={!companySurfaceEnabled}
            displayLabel="opencompany v3"
            className="min-w-0 flex-1 px-0 pb-0"
          />
        </div>

        {/* Primary nav */}
        <nav className="flex flex-col gap-px px-2 pt-2">
          <Link
            href={personalPaths.home}
            className={`group flex w-full items-center gap-2.5 rounded-md px-2 py-[5px] text-left text-[13px] transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
              inboxActive
                ? "bg-surface-active text-ink"
                : "text-ink/90 hover:bg-surface-hover hover:text-ink"
            }`}
          >
            <Send
              size={14}
              className={inboxActive ? "text-ink" : "text-ink/60 group-hover:text-ink/80"}
            />
            <span className="truncate tracking-[-0.005em]">New Session</span>
            {inboxCount > 0 ? (
              <span className="ml-auto rounded-full bg-ink/10 px-1.5 text-[11px] font-medium tabular-nums text-ink/70">
                {inboxCount}
              </span>
            ) : null}
          </Link>
          <Link
            href={personalPaths.brain}
            className={`group flex w-full items-center gap-2.5 rounded-md px-2 py-[5px] text-left text-[13px] transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
              activePanel === "brain"
                ? "bg-surface-active text-ink"
                : "text-ink/90 hover:bg-surface-hover hover:text-ink"
            }`}
          >
            <Brain
              size={14}
              strokeWidth={1.75}
              className={
                activePanel === "brain" ? "text-ink" : "text-ink/60 group-hover:text-ink/80"
              }
            />
            <span className="truncate tracking-[-0.005em]">Personal Brain</span>
          </Link>
          <Link
            href={personalPaths.routines}
            className={`group flex w-full items-center gap-2.5 rounded-md px-2 py-[5px] text-left text-[13px] transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
              activePanel === "routines"
                ? "bg-surface-active text-ink"
                : "text-ink/90 hover:bg-surface-hover hover:text-ink"
            }`}
          >
            <Clock3
              size={14}
              strokeWidth={1.75}
              className={
                activePanel === "routines" ? "text-ink" : "text-ink/60 group-hover:text-ink/80"
              }
            />
            <span className="truncate tracking-[-0.005em]">Routines</span>
          </Link>
        </nav>

        {/* Scrollable body */}
        <div className="no-scrollbar mt-1 flex flex-1 flex-col overflow-y-auto pb-3">
          {starredSessions.length > 0 && (
            <div className="px-2 pt-3">
              <div className="flex items-center gap-1 px-2 pb-1">
                <Pin size={9} strokeWidth={2} fill="currentColor" className="text-ink-subtle" />
                <span className="text-[10.5px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
                  Pinned
                </span>
              </div>
              <div className="flex flex-col gap-px">
                {starredSessions.map((session) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    active={activeSessionId === session.id}
                    starred
                    onSelect={(id) => router.push(personalPaths.session(id))}
                    onToggleStar={handleToggleStar}
                    onArchive={handleArchive}
                    onRename={handleRename}
                  />
                ))}
              </div>
            </div>
          )}

          <Section title="Configuration">
            <Link
              href={personalPaths.agent}
              className={`group flex w-full items-center gap-2.5 rounded-md px-2 py-[5px] text-left text-[13px] transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
                activePanel === "agent"
                  ? "bg-surface-active text-ink"
                  : "text-ink/90 hover:bg-surface-hover hover:text-ink"
              }`}
            >
              <Bot
                size={14}
                strokeWidth={1.75}
                className={
                  activePanel === "agent" ? "text-ink" : "text-ink/60 group-hover:text-ink/80"
                }
              />
              <span className="truncate tracking-[-0.005em]">Behavior</span>
            </Link>
            <CapabilityNavRow
              icon={ScrollText}
              label="Soul"
              active={activeFilePath === "soul.md"}
              href={personalPaths.soul}
            />
            {proMode && (
              <CapabilityNavRow
                icon={BrainCircuit}
                label="Memory"
                active={activePanel === "memory"}
                proBadge
                href={personalPaths.memory}
              />
            )}
            <CapabilityGroupRow
              icon={Blocks}
              label="Capabilities"
              childActive={
                activePanel === "skills" ||
                activePanel === "integrations" ||
                activePanel === "tools" ||
                activePanel === "channels"
              }
            >
              <CapabilityNavRow
                icon={Sparkles}
                label="Skills"
                count={skillCount}
                active={activePanel === "skills"}
                href={personalPaths.skills}
              />
              <CapabilityNavRow
                icon={Plug}
                label="Integrations"
                count={integrationCount}
                active={activePanel === "integrations"}
                href={personalPaths.integrations}
              />
              <CapabilityNavRow
                icon={Wrench}
                label="Tools"
                count={toolCount}
                active={activePanel === "tools"}
                href={personalPaths.tools}
              />
              <CapabilityNavRow
                icon={MessageCircle}
                label="Channels"
                active={activePanel === "channels"}
                href={personalPaths.channels}
              />
            </CapabilityGroupRow>
          </Section>

          {showSessionsSection && (
            <Section title="Sessions">
              {sessions.length === 0 ? (
                <div className="mx-1 mt-1 rounded-md border border-dashed border-border bg-surface/35 px-2.5 py-3 text-[12px] leading-5 text-ink-muted">
                  Sessions you start will appear here.
                </div>
              ) : (
                <>
                  {groupedSessions.map((group, index) => (
                    <div key={group.label} className={index === 0 ? "" : "pt-3"}>
                      {!group.hideLabel && (
                        <div className="px-2 pb-1 text-[10.5px] font-medium uppercase tracking-[0.05em] text-ink-subtle/80">
                          {group.label}
                        </div>
                      )}
                      <div className="flex flex-col gap-px">
                        {group.sessions.map((session) => (
                          <SessionRow
                            key={session.id}
                            session={session}
                            active={activeSessionId === session.id}
                            starred={false}
                            onSelect={(id) => router.push(personalPaths.session(id))}
                            onToggleStar={handleToggleStar}
                            onArchive={handleArchive}
                            onRename={handleRename}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </>
              )}
            </Section>
          )}
        </div>

        <SidebarAccountFooter
          userName={userName}
          userEmail={userEmail}
          subtitle={`${agent.name} · Personal`}
          settingsHref={personalPaths.settings}
          workspaceId={workspaceId}
        />
      </div>
    </aside>
  );
}
