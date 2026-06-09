"use client";

import { useLiveQuery } from "@tanstack/react-db";
import type { LucideIcon } from "lucide-react";
import {
  Blocks,
  Bot,
  Brain,
  BrainCircuit,
  ChevronDown,
  Inbox,
  MessageCircle,
  PanelLeft,
  Plug,
  Sparkles,
  Wrench,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useCollections } from "@/components/CollectionsProvider";
import { usePersonalAgent } from "@/components/personal/PersonalAgentContext";
import { personalIntegrationCount } from "@/components/personal/PersonalCapabilityPanel";
import { SessionStatusDot } from "@/components/SessionStatusDot";
import { SidebarAccountFooter } from "@/components/SidebarAccountFooter";
import { useHydrated } from "@/components/useHydrated";
import type { SidebarSessionPayload } from "@/lib/agent-sessions/payload";
import { deriveVisibleInbox } from "@/lib/collections/selectors";
import { PERSONAL_INTEGRATION_TOOL_IDS } from "@/lib/personal/integrations-catalog";
import { personalPaths } from "@/lib/personal/paths";

// Sessions mid-archive must not flash in the list (mirrors deriveSidebarSessions).
const HIDDEN_SESSION_STATUSES = new Set(["archiving", "archived"]);

type SidebarSession = SidebarSessionPayload;

// A clickable capability/behavior row that navigates to its surface. Capability rows show a count
// of how many of that thing the agent's `.agent` config currently has.
function CapabilityNavRow({
  icon: Icon,
  label,
  active,
  count,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
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
      {count !== undefined && count > 0 && (
        <span className="ml-auto text-[11px] tabular-nums text-ink-subtle">{count}</span>
      )}
    </button>
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

function SessionRow({
  session,
  active,
  onSelect,
}: {
  session: SidebarSession;
  active: boolean;
  onSelect: (sessionId: string) => void;
}) {
  const showStatusDot =
    session.status === "running" ||
    session.status === "provisioning" ||
    session.status === "awaiting_approval" ||
    session.status === "awaiting_input" ||
    session.status === "interrupted";

  return (
    <button
      type="button"
      onClick={() => onSelect(session.id)}
      title={session.lastError ?? session.title}
      className={`group flex w-full items-center gap-2.5 rounded-md px-2 py-[5px] text-left text-[13px] transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
        active ? "bg-surface-active text-ink" : "text-ink/90 hover:bg-surface-hover hover:text-ink"
      }`}
    >
      {showStatusDot ? <SessionStatusDot status={session.status} pulse /> : null}
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
  );
}

// Client-only: keep the personal session list live by reading the agent_sessions
// collection (scoped to the current workspace/user by the shape proxy) and filtering
// to this agent. Falls back to the server-rendered list until the collection hydrates.
function useLivePersonalSessions(agentId: string, initialSessions: SidebarSession[]) {
  const { agentSessions } = useCollections();
  const { data: rows, isLoading } = useLiveQuery((q) => q.from({ session: agentSessions }));

  return useMemo(() => {
    if (isLoading || !rows) return initialSessions;
    return rows
      .filter(
        (row) =>
          row.agent_id === agentId &&
          // Unified list: web sessions AND WhatsApp-originated sessions (not delegated agent ones).
          (row.source === "user" || row.source === "whatsapp") &&
          row.archived_at === null &&
          !HIDDEN_SESSION_STATUSES.has(row.status),
      )
      .map((row) => ({
        id: row.id,
        title: row.title,
        status: row.status,
        source: row.source === "whatsapp" ? ("whatsapp" as const) : ("user" as const),
        modelName: row.model_name,
        lastError: row.last_error,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        starredAt: null,
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [rows, isLoading, agentId, initialSessions]);
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
  const { agent, userName, userEmail, config, personalSkills, githubRequested, proMode } =
    usePersonalAgent();
  const { inboxActive, activePanel, activeSessionId } = useActivePersonalRoute();

  const groupedSessions = useMemo(() => groupSessions(sessions), [sessions]);
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
        </div>

        {/* Primary nav */}
        <nav className="flex flex-col gap-px px-2 pt-2">
          <button
            type="button"
            onClick={() => router.push(personalPaths.home)}
            className={`group flex w-full items-center gap-2.5 rounded-md px-2 py-[5px] text-left text-[13px] transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
              inboxActive
                ? "bg-surface-active text-ink"
                : "text-ink/90 hover:bg-surface-hover hover:text-ink"
            }`}
          >
            <Inbox
              size={14}
              strokeWidth={1.75}
              className={inboxActive ? "text-ink" : "text-ink/60 group-hover:text-ink/80"}
            />
            <span className="truncate tracking-[-0.005em]">Home</span>
            {inboxCount > 0 ? (
              <span className="ml-auto rounded-full bg-ink/10 px-1.5 text-[11px] font-medium tabular-nums text-ink/70">
                {inboxCount}
              </span>
            ) : null}
          </button>
        </nav>

        {/* Scrollable body */}
        <div className="mt-1 flex flex-1 flex-col overflow-y-auto pb-3">
          <Section title="Configuration">
            <CapabilityNavRow
              icon={Bot}
              label="Agent"
              active={activePanel === "agent"}
              onClick={() => router.push(personalPaths.agent)}
            />
            {proMode && (
              <CapabilityNavRow
                icon={BrainCircuit}
                label="Memory"
                active={activePanel === "memory"}
                onClick={() => router.push(personalPaths.memory)}
              />
            )}
            <CapabilityNavRow
              icon={Brain}
              label="Personal Brain"
              active={activePanel === "brain"}
              onClick={() => router.push(personalPaths.brain)}
            />
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
                onClick={() => router.push(personalPaths.skills)}
              />
              <CapabilityNavRow
                icon={Plug}
                label="Integrations"
                count={integrationCount}
                active={activePanel === "integrations"}
                onClick={() => router.push(personalPaths.integrations)}
              />
              <CapabilityNavRow
                icon={Wrench}
                label="Tools"
                count={toolCount}
                active={activePanel === "tools"}
                onClick={() => router.push(personalPaths.tools)}
              />
              <CapabilityNavRow
                icon={MessageCircle}
                label="Channels"
                active={activePanel === "channels"}
                onClick={() => router.push(personalPaths.channels)}
              />
            </CapabilityGroupRow>
          </Section>

          <Section title="Sessions">
            {sessions.length === 0 ? (
              <div className="mx-1 mt-1 rounded-md border border-dashed border-border bg-surface/35 px-2.5 py-3 text-[12px] leading-5 text-ink-muted">
                Sessions you start will appear here.
              </div>
            ) : (
              groupedSessions.map((group, index) => (
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
                        onSelect={(id) => router.push(personalPaths.session(id))}
                      />
                    ))}
                  </div>
                </div>
              ))
            )}
          </Section>
        </div>

        <SidebarAccountFooter
          userName={userName}
          userEmail={userEmail}
          subtitle={`${agent.name} · Personal`}
          settingsHref={personalPaths.settings}
        />
      </div>
    </aside>
  );
}
