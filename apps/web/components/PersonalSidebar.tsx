"use client";

import { useLiveQuery } from "@tanstack/react-db";
import type { LucideIcon } from "lucide-react";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  Inbox,
  PanelLeft,
  Plug,
  Plus,
  Sparkles,
  Wrench,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useCollections } from "@/components/CollectionsProvider";
import { usePersonalAgent } from "@/components/personal/PersonalAgentContext";
import { personalIntegrationCount } from "@/components/personal/PersonalCapabilityPanel";
import { SessionStatusDot } from "@/components/SessionStatusDot";
import { SidebarAccountFooter } from "@/components/SidebarAccountFooter";
import { SpaceSwitcher } from "@/components/SpaceSwitcher";
import { useHydrated } from "@/components/useHydrated";
import type { SidebarSessionPayload } from "@/lib/agent-sessions/payload";
import type { AgentBundleFilePayload } from "@/lib/agents/bundle-files";
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

type ContextFile = AgentBundleFilePayload;

// The context tree mirrors the agent bundle exactly: every file sits at its real path under the
// bundle dir, and folders are only the directories that actually contain files. There are no
// synthetic buckets, canonical slots, or always-present folders — what the sidebar shows is the
// true on-disk state of `agent/`.
type ContextTreeFolder = {
  kind: "folder";
  name: string;
  path: string;
  children: ContextTreeNode[];
};
type ContextTreeFile = { kind: "file"; name: string; file: ContextFile };
type ContextTreeNode = ContextTreeFolder | ContextTreeFile;

function buildContextTree(files: ContextFile[]): ContextTreeNode[] {
  const root: ContextTreeFolder = { kind: "folder", name: "", path: "", children: [] };
  for (const file of files) {
    const segments = file.relativePath.split("/").filter(Boolean);
    let current = root;
    for (const name of segments.slice(0, -1)) {
      const folderPath = current.path ? `${current.path}/${name}` : name;
      let next = current.children.find(
        (child): child is ContextTreeFolder => child.kind === "folder" && child.name === name,
      );
      if (!next) {
        next = { kind: "folder", name, path: folderPath, children: [] };
        current.children.push(next);
      }
      current = next;
    }
    current.children.push({ kind: "file", name: segments.at(-1) ?? file.relativePath, file });
  }
  sortContextTree(root);
  return root.children;
}

// Folders before files, each alphabetical — the conventional, stable file-tree ordering.
function sortContextTree(folder: ContextTreeFolder) {
  folder.children.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const child of folder.children) {
    if (child.kind === "folder") sortContextTree(child);
  }
}

// Indentation grows with tree depth so nested files sit under their folder. Plain px math keeps
// folder headers and file rows on the same grid.
function contextIndent(depth: number) {
  return 8 + depth * 16;
}

// A single folder in the context tree. Toggles its own children open/closed like VS Code, and
// starts collapsed so the tree opens compact — but auto-opens (and stays open) whenever the active
// file lives inside it, so deep-linking a file reveals it. The chevron reflects the state; a
// non-folder row reserves the same chevron column (see ContextTreeNodes) so icons stay aligned.
function ContextFolderNode({
  node,
  depth,
  activeFilePath,
  onSelectFile,
}: {
  node: ContextTreeFolder;
  depth: number;
  activeFilePath: string | null;
  onSelectFile: (relativePath: string) => void;
}) {
  const containsActive = activeFilePath?.startsWith(`${node.path}/`) ?? false;
  // Open follows the user's explicit toggle once they make one; until then it defaults to "open
  // when the active file lives inside" so deep-linking a file reveals it without an effect.
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const open = manualOpen ?? containsActive;
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="flex flex-col gap-px">
      <button
        type="button"
        onClick={() => setManualOpen(!open)}
        aria-expanded={open}
        style={{ paddingLeft: contextIndent(depth) }}
        className="flex w-full items-center gap-2.5 rounded-md py-[5px] pr-2 text-left text-[13px] text-ink/90 transition-colors duration-150 hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
      >
        <Chevron size={12} strokeWidth={2} className="shrink-0 text-ink/40" />
        <Folder size={14} strokeWidth={1.75} className="shrink-0 text-ink/55" />
        <span className="truncate tracking-[-0.005em]">{node.name}/</span>
      </button>
      {open && (
        <ContextTreeNodes
          nodes={node.children}
          depth={depth + 1}
          activeFilePath={activeFilePath}
          onSelectFile={onSelectFile}
        />
      )}
    </div>
  );
}

// Renders the context tree. Folders toggle open/closed (collapsed by default); files are
// clickable and open in the editor. Every row maps 1:1 to a real bundle path — there are no
// synthetic rows, counts, or empty-slot placeholders. Files reserve a leading chevron-width
// spacer so their icons line up with folder icons at the same depth.
function ContextTreeNodes({
  nodes,
  depth,
  activeFilePath,
  onSelectFile,
}: {
  nodes: ContextTreeNode[];
  depth: number;
  activeFilePath: string | null;
  onSelectFile: (relativePath: string) => void;
}) {
  return (
    <>
      {nodes.map((node) =>
        node.kind === "folder" ? (
          <ContextFolderNode
            key={`dir:${node.path}`}
            node={node}
            depth={depth}
            activeFilePath={activeFilePath}
            onSelectFile={onSelectFile}
          />
        ) : (
          <button
            type="button"
            key={`file:${node.file.path}`}
            onClick={() => onSelectFile(node.file.relativePath)}
            title={node.file.relativePath}
            style={{ paddingLeft: contextIndent(depth) }}
            className={`flex w-full items-center gap-2.5 rounded-md py-[3px] pr-2 text-left text-[12.5px] transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
              activeFilePath === node.file.relativePath
                ? "bg-surface-active text-ink"
                : "text-ink/70 hover:bg-surface-hover hover:text-ink"
            }`}
          >
            <span aria-hidden className="w-3 shrink-0" />
            <FileText
              size={13}
              strokeWidth={1.75}
              className={`shrink-0 ${
                activeFilePath === node.file.relativePath ? "text-ink/70" : "text-ink/40"
              }`}
            />
            <span className="truncate tracking-[-0.005em]">{node.name}</span>
          </button>
        ),
      )}
    </>
  );
}

// Create a file anywhere in the bundle. Opens the editor with an empty path so the user types
// the real relative path (e.g. "memory/notes.md") — no folder is assumed or invented.
function NewContextFileRow({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ paddingLeft: contextIndent(0) }}
      className="flex w-full items-center gap-2.5 rounded-md py-[5px] pr-2 text-left text-[13px] text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
    >
      <Plus size={14} strokeWidth={1.75} className="shrink-0" />
      <span className="truncate tracking-[-0.005em]">New file</span>
    </button>
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

// Derive which surface is active from the URL so the sidebar highlight always tracks the route.
function useActivePersonalRoute() {
  const pathname = usePathname();
  const segments = pathname.split("/").filter(Boolean); // e.g. ["personal", "files", "memory", "x.md"]
  const [, section, ...rest] = segments;

  const inboxActive = segments.length === 1; // exactly "/personal"
  const activePanel =
    section === "agent" || section === "skills" || section === "integrations" || section === "tools"
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
  return <PersonalSidebarView {...props} sessions={sessions} />;
}

function PersonalSidebarView({
  sessions,
  collapsed,
  onToggleCollapsed,
}: {
  sessions: SidebarSession[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const router = useRouter();
  const { agent, userName, userEmail, workspaceName, files, config, personalSkills, githubRequested } =
    usePersonalAgent();
  const { inboxActive, activePanel, activeSessionId, activeFilePath } = useActivePersonalRoute();

  const groupedSessions = useMemo(() => groupSessions(sessions), [sessions]);
  const contextTree = useMemo(() => buildContextTree(files), [files]);
  const skillCount = (config.skills?.length ?? 0) + personalSkills.length;
  const integrationCount = personalIntegrationCount({ config, githubRequested });
  const toolCount = config.tools.length;

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
            workspaceName={workspaceName}
            className="min-w-0 flex-1 px-0 pb-0"
          />
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
          </Section>

          <Section title="Context">
            <ContextTreeNodes
              nodes={contextTree}
              depth={0}
              activeFilePath={activeFilePath}
              onSelectFile={(relativePath) => router.push(personalPaths.file(relativePath))}
            />
            <NewContextFileRow onClick={() => router.push(personalPaths.newFile())} />
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
        />
      </div>
    </aside>
  );
}
