"use client";

import { agentBundleDir, type ResolvedSkillMetadata } from "@opencompany/agent-runtime";
import type { AgentConfig, AgentToolId, TiptapDoc } from "@opencompany/agent-runtime/types";
import { PanelLeft } from "lucide-react";
import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { FloatingNavInsetProvider } from "@/components/FloatingNavInsetContext";
import PersonalSidebar from "@/components/PersonalSidebar";
import {
  type PersonalAgent,
  PersonalAgentProvider,
} from "@/components/personal/PersonalAgentContext";
import {
  hasPersonalGitHubIntegrationRequest,
  type PersonalGitHubIntegrationStatus,
} from "@/components/personal/PersonalCapabilityPanel";
import { useToast } from "@/components/ToastProvider";
import type { SidebarSessionPayload } from "@/lib/agent-sessions/payload";
import type { AgentBundleFilePayload } from "@/lib/agents/bundle-files";
import {
  addPersonalAgentIntegration,
  addPersonalAgentSkill,
  addPersonalAgentTool,
  type PersonalIntegrationId,
} from "@/lib/personal/actions";
import type { PersonalIntegrationDetails } from "@/lib/personal/integration-details";
import type { PersonalIntegrationConnections } from "@/lib/personal/integrations-catalog";

const SIDEBAR_STORAGE_KEY = "opencompany-personal-sidebar-collapsed";
const sidebarCollapsedSubscribers = new Set<() => void>();

function subscribeSidebarCollapsed(onStoreChange: () => void) {
  sidebarCollapsedSubscribers.add(onStoreChange);

  function handleStorage(event: StorageEvent) {
    if (event.key === SIDEBAR_STORAGE_KEY) onStoreChange();
  }

  window.addEventListener("storage", handleStorage);
  return () => {
    sidebarCollapsedSubscribers.delete(onStoreChange);
    window.removeEventListener("storage", handleStorage);
  };
}

function getSidebarCollapsedSnapshot() {
  // Collapsed by default: an unset value (first visit) reads as collapsed; only an explicit
  // "false" (user expanded it before) keeps the sidebar open.
  return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) !== "false";
}

function getSidebarCollapsedServerSnapshot() {
  return true;
}

function persistSidebarCollapsed(next: boolean) {
  window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(next));
  for (const subscriber of sidebarCollapsedSubscribers) subscriber();
}

type AddCapabilityResult =
  | { ok: true; config: AgentConfig; body: string; content: TiptapDoc }
  | { ok: false; error: string };

export type PersonalShellProps = {
  agent: PersonalAgent;
  userName: string;
  userEmail: string;
  workspaceName: string;
  initialSessions: SidebarSessionPayload[];
  contextFiles: AgentBundleFilePayload[];
  personalSkills: ResolvedSkillMetadata[];
  githubIntegrationStatus: PersonalGitHubIntegrationStatus;
  integrationConnections: PersonalIntegrationConnections;
  integrationDetails: PersonalIntegrationDetails;
  proMode: boolean;
  companySurfaceEnabled: boolean;
  children: React.ReactNode;
};

// The persistent /personal chrome: the sidebar + the rounded main-panel wrapper, plus all of the
// surface's shared client state. Lives in the route-group layout so it stays mounted across
// navigations between sub-routes (the route page renders into {children}).
export default function PersonalShell({
  agent,
  userName,
  userEmail,
  workspaceName,
  initialSessions,
  contextFiles,
  personalSkills,
  githubIntegrationStatus,
  integrationConnections,
  integrationDetails,
  proMode: initialProMode,
  companySurfaceEnabled: initialCompanySurfaceEnabled,
  children,
}: PersonalShellProps) {
  const { showError } = useToast();
  const [config, setConfig] = useState<AgentConfig>(agent.config);
  const [proMode, setProMode] = useState(initialProMode);
  const [companySurfaceEnabled, setCompanySurfaceEnabled] = useState(initialCompanySurfaceEnabled);
  const [githubRequested, setGitHubRequested] = useState(() =>
    hasPersonalGitHubIntegrationRequest(agent.body),
  );
  const [files, setFiles] = useState<AgentBundleFilePayload[]>(contextFiles);
  const collapsed = useSyncExternalStore(
    subscribeSidebarCollapsed,
    getSidebarCollapsedSnapshot,
    getSidebarCollapsedServerSnapshot,
  );

  const bundleDir = agent.path ? agentBundleDir(agent.path) : null;

  // The editable behavior body. Held in a ref (not state) because only the Behavior route reads
  // it — and only at mount — so updates here must not re-render the rest of the surface.
  const draftRef = useRef<{ body: string; content: typeof agent.content }>({
    body: agent.body,
    content: agent.content,
  });

  // Merge a saved/created file back into the list so the sidebar (names, counts) and the open
  // editor stay in sync without a server round-trip.
  const upsertFile = (file: AgentBundleFilePayload) => {
    setFiles((prev) => {
      const next = prev.filter((existing) => existing.path !== file.path);
      next.push(file);
      return next.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    });
  };

  const applyCapabilityResult = (result: AddCapabilityResult, title: string) => {
    if (!result.ok) {
      showError(result.error, title);
      return;
    }
    setConfig(result.config);
    setGitHubRequested(hasPersonalGitHubIntegrationRequest(result.body));
    draftRef.current = { body: result.body, content: result.content };
  };

  // The manual "Add integration" path appends the integration's @-mention to the agent body
  // server-side, then hands back the re-derived config + rebuilt draft. We reseed config, the
  // github-requested flag, and the behavior draft so every surface (sidebar count, integrations
  // list, Behavior editor) reflects the appended mention without a reload — the body stays the
  // single source of truth.
  const addIntegration = async (integration: PersonalIntegrationId) => {
    const result = await addPersonalAgentIntegration(agent.id, integration);
    applyCapabilityResult(result, "Could not add integration");
  };

  const addTool = async (toolId: AgentToolId) => {
    const result = await addPersonalAgentTool(agent.id, toolId);
    applyCapabilityResult(result, "Could not add tool");
  };

  const addSkill = async (skillId: string) => {
    const result = await addPersonalAgentSkill(agent.id, skillId);
    applyCapabilityResult(result, "Could not add skill");
  };

  const contextValue = useMemo(
    () => ({
      agent,
      bundleDir,
      userName,
      userEmail,
      workspaceName,
      initialSessions,
      personalSkills,
      githubIntegrationStatus,
      integrationConnections,
      integrationDetails,
      config,
      setConfig,
      proMode,
      setProMode,
      companySurfaceEnabled,
      setCompanySurfaceEnabled,
      githubRequested,
      getDraft: () => draftRef.current,
      setDraft: (body: string, content: typeof agent.content) => {
        draftRef.current = { body, content };
        setGitHubRequested(hasPersonalGitHubIntegrationRequest(body));
      },
      files,
      upsertFile,
      addIntegration,
      addTool,
      addSkill,
    }),
    // upsertFile/addIntegration close over stable setters; re-create only when rendered data
    // changes. agent/initial* are stable per layout mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      agent,
      bundleDir,
      config,
      proMode,
      companySurfaceEnabled,
      githubRequested,
      files,
      personalSkills,
      githubIntegrationStatus,
      integrationConnections,
      integrationDetails,
    ],
  );

  return (
    <PersonalAgentProvider value={contextValue}>
      <div className="flex h-screen w-screen overflow-hidden bg-sidebar">
        <PersonalSidebar
          collapsed={collapsed}
          onToggleCollapsed={() => persistSidebarCollapsed(!collapsed)}
        />

        {/* When the sidebar is expanded the main view floats as a rounded panel so the
            sidebar canvas peeks around its edges; collapsed, it bleeds to full screen. */}
        <div
          className={`relative flex min-w-0 flex-1 flex-col overflow-hidden bg-canvas transition-[margin,border-radius] duration-200 ease-out ${
            collapsed
              ? "m-0 rounded-none border-0"
              : "my-2 mr-2 rounded-xl border border-border shadow-[0_1px_3px_rgba(0,0,0,0.04)]"
          }`}
        >
          {collapsed && (
            <button
              type="button"
              aria-label="Expand sidebar"
              aria-expanded={false}
              onClick={() => persistSidebarCollapsed(false)}
              // top-[7px] (not top-3) so the button's center lines up with the session top bar's
              // text + right-side icons, which sit ~21.5px down (py-2 over ~27px content). The
              // button's own border makes it 2px taller, so it needs to ride slightly higher.
              className="fixed left-2 top-[7px] z-50 rounded-md border border-border bg-canvas/85 p-1.5 text-ink/60 shadow-[0_1px_2px_rgba(15,15,15,0.04)] backdrop-blur-md transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
            >
              <PanelLeft size={15} strokeWidth={1.75} />
            </button>
          )}
          {/* While collapsed the floating expand button sits over the top-left of this panel, so
              tell the panel chrome (e.g. SessionView's top bar) to reserve left padding for it. */}
          <FloatingNavInsetProvider value={collapsed}>{children}</FloatingNavInsetProvider>
        </div>
      </div>
    </PersonalAgentProvider>
  );
}
