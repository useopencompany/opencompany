"use client";

import { agentBundleDir, type ResolvedSkillMetadata } from "@opencompany/agent-runtime";
import type {
  AgentConfig,
  AgentReference,
  AgentToolId,
  TiptapDoc,
} from "@opencompany/agent-runtime/types";
import { PanelLeft } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { FloatingNavInsetProvider } from "@/components/FloatingNavInsetContext";
import { useMobileInspector } from "@/components/MobileInspectorContext";
import PersonalSidebar from "@/components/PersonalSidebar";
import {
  type PersonalAgent,
  PersonalAgentProvider,
} from "@/components/personal/PersonalAgentContext";
import {
  hasPersonalGitHubIntegrationRequest,
  type PersonalGitHubIntegrationStatus,
} from "@/components/personal/PersonalCapabilityPanel";
import { PersonalSplitProvider } from "@/components/session-split/PersonalSessionSplit";
import { useToast } from "@/components/ToastProvider";
import type { SidebarSessionPayload } from "@/lib/agent-sessions/payload";
import type { AgentBundleFilePayload } from "@/lib/agents/bundle-files";
import type { GitHubIntegrationRepositoryPayload } from "@/lib/agents/payload";
import {
  addPersonalAgentIntegration,
  addPersonalAgentSkill,
  addPersonalAgentTool,
  type PersonalIntegrationId,
} from "@/lib/personal/actions";
import type { PersonalIntegrationDetails } from "@/lib/personal/integration-details";
import type { PersonalIntegrationConnections } from "@/lib/personal/integrations-catalog";
import { browserTimezone, type UserTimezoneSource } from "@/lib/timezones";
import type { WorkspaceToolPolicyOverrides } from "@/lib/tool-policies/data";
import { useDrawerGesture } from "@/lib/useDrawerGesture";
import { useIsMobile } from "@/lib/useIsMobile";
import { setUserTimezone as setUserTimezoneAction } from "@/lib/users/actions";
import { cn } from "@/lib/utils";
import type { WorkspacePickerItem } from "@/lib/workspaces/actions";

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
  userTimezone: string;
  userTimezoneSource: UserTimezoneSource;
  workspaceId: string;
  workspaceName: string;
  workspaces: WorkspacePickerItem[];
  initialSessions: SidebarSessionPayload[];
  contextFiles: AgentBundleFilePayload[];
  personalSkills: ResolvedSkillMetadata[];
  githubIntegrationStatus: PersonalGitHubIntegrationStatus;
  // The workspace GitHub integration's usable repository catalog, so the Behavior editor can
  // offer concrete @owner/repo mentions (not just the generic @github pill).
  githubRepositories: GitHubIntegrationRepositoryPayload[];
  // Workspace-wide/company agents mentionable from the personal Behavior editor.
  workspaceAgents: AgentReference[];
  integrationConnections: PersonalIntegrationConnections;
  integrationDetails: PersonalIntegrationDetails;
  toolPolicies: WorkspaceToolPolicyOverrides;
  proMode: boolean;
  companySurfaceEnabled: boolean;
  codexEngineEnabled: boolean;
  children: React.ReactNode;
};

// The persistent /personal chrome: the sidebar + the rounded main-panel wrapper, plus all of the
// surface's shared client state. Lives in the route-group layout so it stays mounted across
// navigations between sub-routes (the route page renders into {children}).
export default function PersonalShell({
  agent,
  userName,
  userEmail,
  userTimezone: initialUserTimezone,
  userTimezoneSource: initialUserTimezoneSource,
  workspaceId,
  workspaceName,
  workspaces,
  initialSessions,
  contextFiles,
  personalSkills,
  githubIntegrationStatus,
  githubRepositories,
  workspaceAgents,
  integrationConnections,
  integrationDetails,
  toolPolicies,
  proMode: initialProMode,
  companySurfaceEnabled: initialCompanySurfaceEnabled,
  codexEngineEnabled: initialCodexEngineEnabled,
  children,
}: PersonalShellProps) {
  const { showError } = useToast();
  const [config, setConfig] = useState<AgentConfig>(agent.config);
  const [proMode, setProMode] = useState(initialProMode);
  const [companySurfaceEnabled, setCompanySurfaceEnabled] = useState(initialCompanySurfaceEnabled);
  const [codexEngineEnabled, setCodexEngineEnabled] = useState(initialCodexEngineEnabled);
  const [userTimezone, setUserTimezone] = useState(initialUserTimezone);
  const [userTimezoneSource, setUserTimezoneSource] =
    useState<UserTimezoneSource>(initialUserTimezoneSource);
  const [githubRequested, setGitHubRequested] = useState(() =>
    hasPersonalGitHubIntegrationRequest(agent.body),
  );
  const [files, setFiles] = useState<AgentBundleFilePayload[]>(contextFiles);
  const collapsed = useSyncExternalStore(
    subscribeSidebarCollapsed,
    getSidebarCollapsedSnapshot,
    getSidebarCollapsedServerSnapshot,
  );

  // --- Mobile swipe drawer ---------------------------------------------------
  // On mobile the sidebar's desktop width-collapse is replaced by an off-canvas
  // drawer driven by the same filmstrip swipe as the company shell ([ MENU | CHAT |
  // DETAILS ]). Desktop (>= md) is untouched: `collapsed` still drives the in-flow width.
  const isMobile = useIsMobile();
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const { handle: inspectorHandle } = useMobileInspector();

  const leftDrawerConfig = useMemo(
    () => ({
      isOpen: () => drawerOpen,
      setOpen: setDrawerOpen,
      getWidth: () => drawerRef.current?.getBoundingClientRect().width || 256,
    }),
    [drawerOpen],
  );
  const rightDrawerConfig = useMemo(
    () =>
      inspectorHandle
        ? {
            isOpen: inspectorHandle.isOpen,
            setOpen: inspectorHandle.setOpen,
            getWidth: inspectorHandle.getWidth,
          }
        : null,
    [inspectorHandle],
  );
  // The Memory (Brain) page owns the left-edge swipe for its own file-tree drawer, so the
  // shell yields its nav-drawer gesture there (the nav stays reachable via the ☰ button).
  const pageOwnsLeftSwipe = /\/brain(\/|$)/.test(pathname);
  const { left: leftDrag, right: rightDrag } = useDrawerGesture({
    isMobile: isMobile && !pageOwnsLeftSwipe,
    left: leftDrawerConfig,
    right: rightDrawerConfig,
  });
  // Forward the right panel's live drag to the session inspector that registered it.
  useEffect(() => {
    inspectorHandle?.setDrag(rightDrag.dragging, rightDrag.progress);
  }, [inspectorHandle, rightDrag.dragging, rightDrag.progress]);

  // Close the drawer on navigation (covers sidebar link taps). Adjust during render
  // per React's "you might not need an effect" guidance.
  const [prevPathname, setPrevPathname] = useState(pathname);
  if (prevPathname !== pathname) {
    setPrevPathname(pathname);
    if (drawerOpen) setDrawerOpen(false);
  }

  // Lock body scroll + close on Escape while the drawer is open on mobile.
  useEffect(() => {
    if (!(isMobile && drawerOpen)) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [isMobile, drawerOpen]);

  const bundleDir = agent.path ? agentBundleDir(agent.path) : null;

  useEffect(() => {
    if (userTimezoneSource === "manual") return;
    const detectedTimezone = browserTimezone();
    if (!detectedTimezone) return;
    if (detectedTimezone === userTimezone && userTimezoneSource === "browser") return;

    let cancelled = false;
    void setUserTimezoneAction({ timezone: detectedTimezone, source: "browser" }).then((result) => {
      if (cancelled || !result.ok) return;
      setUserTimezone(result.timezone);
      setUserTimezoneSource(result.source);
      if (result.config) setConfig(result.config);
    });
    return () => {
      cancelled = true;
    };
  }, [userTimezone, userTimezoneSource]);

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
      return false;
    }
    setConfig(result.config);
    setGitHubRequested(hasPersonalGitHubIntegrationRequest(result.body));
    draftRef.current = { body: result.body, content: result.content };
    return true;
  };

  // The manual "Add integration" path appends the integration's @-mention to the agent body
  // server-side, then hands back the re-derived config + rebuilt draft. We reseed config, the
  // github-requested flag, and the behavior draft so every surface (sidebar count, integrations
  // list, Behavior editor) reflects the appended mention without a reload — the body stays the
  // single source of truth.
  const addIntegration = async (integration: PersonalIntegrationId) => {
    const result = await addPersonalAgentIntegration(agent.id, integration);
    return applyCapabilityResult(result, "Could not add integration");
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
      userTimezone,
      userTimezoneSource,
      workspaceId,
      workspaceName,
      workspaces,
      initialSessions,
      personalSkills,
      githubIntegrationStatus,
      githubRepositories,
      workspaceAgents,
      integrationConnections,
      integrationDetails,
      toolPolicies,
      config,
      setConfig,
      proMode,
      setProMode,
      companySurfaceEnabled,
      setCompanySurfaceEnabled,
      codexEngineEnabled,
      setCodexEngineEnabled,
      setUserTimezone,
      setUserTimezoneSource,
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
      codexEngineEnabled,
      userTimezone,
      userTimezoneSource,
      workspaceId,
      workspaces,
      githubRequested,
      files,
      personalSkills,
      githubIntegrationStatus,
      githubRepositories,
      workspaceAgents,
      integrationConnections,
      integrationDetails,
      toolPolicies,
    ],
  );

  return (
    <PersonalAgentProvider value={contextValue}>
      {/* Split-pane layout store. Lives here (not in the session page) so the pane
          arrangement survives navigation between personal sub-routes, and so the
          sidebar can act as a drag source into the session canvas. */}
      <PersonalSplitProvider>
        {/* Root backdrop. The safe-area insets (#501) pad content into the visible area while the
            background bleeds full-screen. On mobile the surface is full-bleed canvas (the sidebar is
            an off-canvas drawer), so the root must be `bg-canvas` — otherwise the lighter `bg-sidebar`
            shows through the top/bottom insets as bands. On desktop the root stays `bg-sidebar` so the
            expanded main panel can float as a rounded card with the sidebar canvas peeking around it. */}
        <div className="relative flex h-dvh w-full overflow-hidden overflow-x-hidden bg-canvas md:bg-sidebar pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
          {/* Sidebar: an in-flow width-collapsing column on desktop; an off-canvas drawer on
              mobile that the swipe drags 1:1 and snaps. */}
          <div
            ref={drawerRef}
            className={cn(
              "shrink-0",
              isMobile &&
                "fixed inset-y-0 left-0 z-40 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] transition-transform duration-200 ease-out",
              isMobile && (drawerOpen ? "translate-x-0" : "-translate-x-full"),
            )}
            // While dragging, follow the finger 1:1: the inline transform overrides the
            // translate class and `transition: none` disables the snap until release.
            style={
              isMobile && leftDrag.dragging
                ? { transform: `translateX(${(leftDrag.progress - 1) * 100}%)`, transition: "none" }
                : undefined
            }
          >
            <PersonalSidebar
              collapsed={isMobile ? false : collapsed}
              onToggleCollapsed={
                isMobile ? () => setDrawerOpen(false) : () => persistSidebarCollapsed(!collapsed)
              }
            />
          </div>

          {isMobile && (drawerOpen || leftDrag.dragging) ? (
            <button
              type="button"
              aria-label="Close menu"
              data-testid="personal-drawer-scrim"
              onClick={() => setDrawerOpen(false)}
              className="fixed inset-0 z-30 bg-black/40"
              // Fade the dim in step with the drag; full strength once open.
              style={leftDrag.dragging ? { opacity: leftDrag.progress } : undefined}
            />
          ) : null}

          {/* When the sidebar is expanded the main view floats as a rounded panel so the
            sidebar canvas peeks around its edges; collapsed (or on mobile), it bleeds to full screen. */}
          <div
            className={cn(
              "relative flex min-w-0 flex-1 flex-col overflow-hidden bg-canvas transition-[margin,border-radius] duration-200 ease-out",
              isMobile || collapsed
                ? "m-0 rounded-none border-0"
                : "my-2 mr-2 rounded-xl border border-border shadow-[0_1px_3px_rgba(0,0,0,0.04)]",
            )}
          >
            {((isMobile && !drawerOpen) || (!isMobile && collapsed)) && (
              <button
                type="button"
                aria-label={isMobile ? "Open menu" : "Expand sidebar"}
                aria-expanded={false}
                onClick={
                  isMobile ? () => setDrawerOpen(true) : () => persistSidebarCollapsed(false)
                }
                // top-[7px] (not top-3) so the button's center lines up with the session top bar's
                // text + right-side icons, which sit ~21.5px down (py-2 over ~27px content). The
                // button's own border makes it 2px taller, so it needs to ride slightly higher.
                className="fixed left-2 top-[7px] z-50 rounded-md border border-border bg-canvas/85 p-1.5 text-ink/60 shadow-[0_1px_2px_rgba(15,15,15,0.04)] backdrop-blur-md transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
              >
                <PanelLeft size={15} strokeWidth={1.75} />
              </button>
            )}
            {/* While the menu button floats over the top-left of this panel, tell the panel chrome
              (e.g. SessionView's top bar) to reserve left padding for it. */}
            <FloatingNavInsetProvider value={isMobile ? !drawerOpen : collapsed}>
              {children}
            </FloatingNavInsetProvider>
          </div>
        </div>
      </PersonalSplitProvider>
    </PersonalAgentProvider>
  );
}
