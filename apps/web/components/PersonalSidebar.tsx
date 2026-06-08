"use client";

import { agentBundleDir, agentDefinitionFileNameForPath } from "@opencompany/agent-runtime";
import type { AgentConfig } from "@opencompany/agent-runtime/types";
import { useLiveQuery } from "@tanstack/react-db";
import type { LucideIcon } from "lucide-react";
import {
  Blocks,
  Bot,
  ChevronDown,
  FileText,
  Folder,
  Inbox,
  PanelLeft,
  Plug,
  Plus,
  SlidersHorizontal,
  Sparkles,
  Wrench,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useCollections } from "@/components/CollectionsProvider";
import { personalIntegrationCount } from "@/components/personal/PersonalCapabilityPanel";
import { SessionStatusDot } from "@/components/SessionStatusDot";
import { SpaceSwitcher } from "@/components/SpaceSwitcher";
import { useHydrated } from "@/components/useHydrated";
import type { SidebarSessionPayload } from "@/lib/agent-sessions/payload";
import type { AgentBundleFilePayload } from "@/lib/agents/bundle-files";

// The agent-config surfaces the sidebar can open in the main panel.
export type PersonalPanel = "behavior" | "skills" | "integrations" | "tools";

// Sessions mid-archive must not flash in the list (mirrors deriveSidebarSessions).
const HIDDEN_SESSION_STATUSES = new Set(["archiving", "archived"]);

type SidebarSession = SidebarSessionPayload;

// A clickable capability/behavior row that opens its surface in the main panel. Capability
// rows show a count of how many of that thing the agent's `.agent` config currently has.
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

type ContextFile = AgentBundleFilePayload;

// The agent bundle is a flat-ish folder; group its files into the canonical slots the
// runner materializes (memory.md, skills/, attachments). `files/` is the catch-all so any
// path the agent writes still shows up somewhere real instead of silently disappearing.
const CONTEXT_FOLDERS: Array<{
  key: string;
  label: string;
  match: (relativePath: string) => boolean;
}> = [
  { key: "memory", label: "memory/", match: (p) => p === "memory.md" || p.startsWith("memory/") },
  { key: "skills", label: "skills/", match: (p) => p.startsWith("skills/") },
  { key: "files", label: "files/", match: () => true },
];

function categorizeContextFiles(files: ContextFile[]) {
  const buckets = new Map<string, ContextFile[]>(CONTEXT_FOLDERS.map((folder) => [folder.key, []]));
  for (const file of files) {
    const folder = CONTEXT_FOLDERS.find((candidate) => candidate.match(file.relativePath));
    if (folder) buckets.get(folder.key)?.push(file);
  }
  return buckets;
}

function baseName(path: string) {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

// The agent definition (the `.agent` file) always exists — it's the agent's instructions — so
// this row is never dimmed. We show its real filename (e.g. "leo.agent") and a distinct Bot icon
// so the `.agent` format reads as the agent's identity rather than just another context file.
// Clicking it opens the Behavior editor (the definition's editable body); the tooltip shows the
// full bundle path it maps to.
function ContextDefinitionRow({
  agentPath,
  active,
  onClick,
}: {
  agentPath: string | null;
  active: boolean;
  onClick: () => void;
}) {
  const fileName = agentPath ? agentDefinitionFileNameForPath(agentPath) : "agent.agent";
  const title = agentPath ? `${agentBundleDir(agentPath)}/${fileName}` : undefined;
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`group flex w-full items-center gap-2.5 rounded-md px-2 py-[5px] text-left text-[13px] transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
        active ? "bg-surface-active text-ink" : "text-ink/90 hover:bg-surface-hover hover:text-ink"
      }`}
    >
      <Bot
        size={14}
        strokeWidth={1.75}
        className={`shrink-0 ${active ? "text-ink" : "text-ink/55"}`}
      />
      <span className="truncate tracking-[-0.005em]">{fileName}</span>
    </button>
  );
}

// A canonical folder slot. Empty slots stay dimmed so the structure is discoverable before
// the agent has written anything into it; populated slots list their real files nested below.
// Files are clickable to open in the editor; the folder header reveals a "+" to add a file.
function ContextFolderRow({
  label,
  files,
  activeFilePath,
  onSelectFile,
  onNewFile,
}: {
  label: string;
  files: ContextFile[];
  activeFilePath: string | null;
  onSelectFile: (relativePath: string) => void;
  onNewFile: (prefix: string) => void;
}) {
  const empty = files.length === 0;
  return (
    <div className="flex flex-col gap-px">
      <div
        className={`group flex w-full items-center gap-2.5 rounded-md px-2 py-[5px] text-[13px] ${
          empty ? "text-ink/35" : "text-ink/90"
        }`}
      >
        <Folder
          size={14}
          strokeWidth={1.75}
          className={`shrink-0 ${empty ? "text-ink/30" : "text-ink/55"}`}
        />
        <span className="truncate tracking-[-0.005em]">{label}</span>
        <button
          type="button"
          onClick={() => onNewFile(label)}
          aria-label={`New file in ${label}`}
          title={`New file in ${label}`}
          className="ml-auto rounded p-0.5 text-ink-subtle opacity-0 transition-opacity duration-150 hover:bg-surface-hover hover:text-ink focus:opacity-100 focus:outline-none group-hover:opacity-100"
        >
          <Plus size={13} strokeWidth={2} />
        </button>
        {!empty && (
          <span className="text-[11px] tabular-nums text-ink-subtle group-hover:hidden">
            {files.length}
          </span>
        )}
      </div>
      {files.map((file) => {
        const active = activeFilePath === file.relativePath;
        return (
          <button
            type="button"
            key={file.path}
            onClick={() => onSelectFile(file.relativePath)}
            title={file.relativePath}
            className={`flex w-full items-center gap-2.5 rounded-md py-[3px] pl-[30px] pr-2 text-left text-[12.5px] transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
              active
                ? "bg-surface-active text-ink"
                : "text-ink/70 hover:bg-surface-hover hover:text-ink"
            }`}
          >
            <FileText
              size={13}
              strokeWidth={1.75}
              className={`shrink-0 ${active ? "text-ink/70" : "text-ink/40"}`}
            />
            <span className="truncate tracking-[-0.005em]">{baseName(file.relativePath)}</span>
          </button>
        );
      })}
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
  const groups: Array<{ label: string; sessions: SidebarSession[] }> = [
    { label: "Today", sessions: [] },
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
          row.source === "user" &&
          row.archived_at === null &&
          !HIDDEN_SESSION_STATUSES.has(row.status),
      )
      .map((row) => ({
        id: row.id,
        title: row.title,
        status: row.status,
        modelName: row.model_name,
        lastError: row.last_error,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        starredAt: null,
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [rows, isLoading, agentId, initialSessions]);
}

export type PersonalSidebarProps = {
  agentId: string;
  agentName: string;
  agentPath: string | null;
  userName: string;
  userEmail: string;
  workspaceName: string;
  initialSessions: SidebarSession[];
  contextFiles: ContextFile[];
  config: AgentConfig;
  githubRequested: boolean;
  activeSessionId: string | null;
  activePanel: PersonalPanel | null;
  activeFilePath: string | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onNewSession: () => void;
  onSelectSession: (sessionId: string) => void;
  onSelectPanel: (panel: PersonalPanel) => void;
  onSelectFile: (relativePath: string) => void;
  onNewFile: (prefix: string) => void;
};

export default function PersonalSidebar(props: PersonalSidebarProps) {
  const hydrated = useHydrated();
  const liveSessions = useLivePersonalSessions(props.agentId, props.initialSessions);
  const sessions = hydrated ? liveSessions : props.initialSessions;
  const groupedSessions = useMemo(() => groupSessions(sessions), [sessions]);
  const contextFolders = useMemo(
    () => categorizeContextFiles(props.contextFiles),
    [props.contextFiles],
  );
  const inboxActive = props.activeSessionId === null && props.activePanel === null;
  const skillCount = props.config.skills?.length ?? 0;
  const integrationCount = personalIntegrationCount({
    config: props.config,
    githubRequested: props.githubRequested,
  });
  const toolCount = props.config.tools.length;

  return (
    <aside
      className={`relative h-full shrink-0 overflow-hidden bg-sidebar transition-[width] duration-200 ease-out ${
        props.collapsed ? "w-0" : "w-[256px]"
      }`}
      aria-hidden={props.collapsed}
    >
      <div className="flex h-full w-[256px] flex-col">
        {/* Top icons */}
        <div className="flex items-center gap-1 px-2 pb-2 pt-3">
          <button
            type="button"
            aria-label="Collapse sidebar"
            aria-expanded={!props.collapsed}
            onClick={props.onToggleCollapsed}
            className="rounded-md p-1.5 text-ink/60 transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            <PanelLeft size={15} strokeWidth={1.75} />
          </button>
        </div>

        <SpaceSwitcher activeSpace="personal" workspaceName={props.workspaceName} />

        {/* Primary nav */}
        <nav className="flex flex-col gap-px px-2 pt-1">
          <button
            type="button"
            onClick={props.onNewSession}
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
            <span className="truncate tracking-[-0.005em]">Inbox</span>
          </button>
        </nav>

        {/* Scrollable body */}
        <div className="mt-1 flex flex-1 flex-col overflow-y-auto pb-3">
          <Section title="Capabilities">
            <CapabilityNavRow
              icon={SlidersHorizontal}
              label="Behavior"
              active={props.activePanel === "behavior"}
              onClick={() => props.onSelectPanel("behavior")}
            />
            <CapabilityNavRow
              icon={Sparkles}
              label="Skills"
              count={skillCount}
              active={props.activePanel === "skills"}
              onClick={() => props.onSelectPanel("skills")}
            />
            <CapabilityNavRow
              icon={Plug}
              label="Integrations"
              count={integrationCount}
              active={props.activePanel === "integrations"}
              onClick={() => props.onSelectPanel("integrations")}
            />
            <CapabilityNavRow
              icon={Wrench}
              label="Tools"
              count={toolCount}
              active={props.activePanel === "tools"}
              onClick={() => props.onSelectPanel("tools")}
            />
          </Section>

          <Section title="Context">
            <ContextDefinitionRow
              agentPath={props.agentPath}
              active={props.activePanel === "behavior"}
              onClick={() => props.onSelectPanel("behavior")}
            />
            {CONTEXT_FOLDERS.map((folder) => (
              <ContextFolderRow
                key={folder.key}
                label={folder.label}
                files={contextFolders.get(folder.key) ?? []}
                activeFilePath={props.activeFilePath}
                onSelectFile={props.onSelectFile}
                onNewFile={props.onNewFile}
              />
            ))}
          </Section>

          <Section title="Sessions">
            {sessions.length === 0 ? (
              <div className="mx-1 mt-1 rounded-md border border-dashed border-border bg-surface/35 px-2.5 py-3 text-[12px] leading-5 text-ink-muted">
                Sessions you start will appear here.
              </div>
            ) : (
              groupedSessions.map((group, index) => (
                <div key={group.label} className={index === 0 ? "" : "pt-3"}>
                  <div className="px-2 pb-1 text-[10.5px] font-medium uppercase tracking-[0.05em] text-ink-subtle/80">
                    {group.label}
                  </div>
                  <div className="flex flex-col gap-px">
                    {group.sessions.map((session) => (
                      <SessionRow
                        key={session.id}
                        session={session}
                        active={props.activeSessionId === session.id}
                        onSelect={props.onSelectSession}
                      />
                    ))}
                  </div>
                </div>
              ))
            )}
          </Section>
        </div>

        {/* Footer profile */}
        <div className="flex items-center gap-2.5 px-3 py-2.5">
          <div
            aria-hidden
            className="h-6 w-6 shrink-0 rounded-full ring-1 ring-black/[0.06]"
            style={{
              background:
                "radial-gradient(circle at 30% 30%, #c9d9ff 0%, #3b5bdb 35%, #0b1224 80%)",
              boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.18), 0 1px 2px rgba(0,0,0,0.08)",
            }}
          />
          <div className="flex min-w-0 flex-col leading-tight">
            <span
              title={props.userEmail}
              className="truncate text-[12.5px] font-medium tracking-[-0.005em] text-ink"
            >
              {props.userName}
            </span>
            <span className="truncate text-[11px] text-ink-subtle">
              {props.agentName} · Personal
            </span>
          </div>
          <Blocks size={14} strokeWidth={1.75} className="ml-auto shrink-0 text-ink-subtle/60" />
        </div>
      </div>
    </aside>
  );
}
