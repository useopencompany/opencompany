import { AnalyticsProvider } from "@opencompany/analytics/client";
import { CollectionsProvider } from "@/components/CollectionsProvider";
import { MobileInspectorProvider } from "@/components/MobileInspectorContext";
import { ObservabilityContext } from "@/components/ObservabilityContext";
import PersonalShell from "@/components/personal/PersonalShell";
import QueryProvider from "@/components/QueryProvider";
import { ToastProvider } from "@/components/ToastProvider";
import { WorkspaceProvider } from "@/components/WorkspaceContext";
import { loadPersonalSessionsForAgent } from "@/lib/agent-sessions/data";
import {
  loadAgentReferencesForWorkspace,
  loadGitHubIntegrationRepositoriesForWorkspace,
} from "@/lib/agents/data";
import { agentGitHubRepositories, buildGitHubRepositoryCatalogs } from "@/lib/agents/payload";
import { currentWorkspace } from "@/lib/auth";
import { isCodexEngineEnabled } from "@/lib/flags/codexEngine";
import { loadWorkspaceIntegrationState } from "@/lib/integrations/actions";
import { loadGoogleIntegrationState } from "@/lib/integrations/google-data";
import { loadWorkspaceMcpSettingsForWorkspace } from "@/lib/mcp/data";
import { loadPersonalAgentContextFiles, loadPersonalSkills } from "@/lib/personal/context";
import { buildPersonalIntegrationDetails } from "@/lib/personal/integration-details-server";
import type { PersonalIntegrationConnections } from "@/lib/personal/integrations-catalog";
import { ensurePersonalAgent } from "@/lib/personal/scaffold";
import { normalizeUserTimezoneSource } from "@/lib/timezones";
import { loadWorkspaceToolPolicyOverrides } from "@/lib/tool-policies/data";

// Standalone experimentation surface. Deliberately OUTSIDE the (workspace) route group, so it does
// not inherit AppShell/Sidebar — but it still needs the same provider stack (minus the workspace
// sidebar chrome) because the composer and SessionView consume WorkspaceContext, the collections,
// the query client, and toasts.
//
// This layout loads the personal agent + its data ONCE and renders the persistent PersonalShell
// chrome (sidebar + main-panel frame). Sub-route pages render into PersonalShell's children, so
// the shared client state (config, behavior draft, file list) survives navigation between them.
export default async function PersonalLayout({ children }: { children: React.ReactNode }) {
  const { authUser, user, workspace } = await currentWorkspace();

  // Short first-person name the scaffold templates into the agent's body/soul ("{{userName}}");
  // distinct from the full display name derived below for the sidebar footer.
  const scaffoldUserName = user.firstName?.trim() || authUser.email.split("@")[0] || "you";
  const agent = await ensurePersonalAgent({
    userId: user.id,
    workspaceId: workspace.id,
    userName: scaffoldUserName,
  });

  const [
    sessions,
    contextFiles,
    personalSkills,
    workspaceIntegrations,
    googleState,
    mcpSettings,
    toolPolicies,
    githubIntegrationRepositories,
    workspaceAgents,
  ] = await Promise.all([
    loadPersonalSessionsForAgent(user.id, workspace.id, agent.id),
    loadPersonalAgentContextFiles(workspace.id, agent.id, agent.path),
    loadPersonalSkills(workspace.id, agent.id, agent.path, agent.config),
    loadWorkspaceIntegrationState(),
    loadGoogleIntegrationState(),
    loadWorkspaceMcpSettingsForWorkspace(workspace.id),
    loadWorkspaceToolPolicyOverrides(workspace.id),
    loadGitHubIntegrationRepositoriesForWorkspace(workspace.id),
    loadAgentReferencesForWorkspace(workspace.id),
  ]);

  // The workspace GitHub integration's repository catalog (only usable repos), so the Behavior
  // editor can offer concrete @owner/repo mentions instead of just the generic @github pill.
  const { usableRepositories: githubRepositories } = buildGitHubRepositoryCatalogs({
    repositories: githubIntegrationRepositories,
    savedRepositories: agentGitHubRepositories(agent.config),
  });
  const userName =
    [authUser.firstName, authUser.lastName].filter(Boolean).join(" ").trim() || authUser.email;

  // Whether each integration is connected at the workspace level, so the personal Integrations
  // tab and the add modal can show "Connected" vs "Connect" and link to the in-tab OAuth flow.
  const integrationConnections: PersonalIntegrationConnections = {
    github: workspaceIntegrations.github.status === "connected",
    gmail: googleState.gmail.status === "connected",
    google_calendar: googleState.google_calendar.status === "connected",
    google_drive: googleState.google_drive.status === "connected",
    linear: mcpSettings.linear.configured,
    slack: mcpSettings.slack.configured,
    posthog: mcpSettings.posthog.configured,
    betterstack: mcpSettings.betterstack.configured,
    braintrust: mcpSettings.braintrust.configured,
    notion: mcpSettings.notion.configured,
  };

  // Richer per-integration detail (accounts, repositories/calendars, MCP endpoints) for the
  // expandable rows on the Integrations tab. Pure projection of the state loaded above.
  const integrationDetails = buildPersonalIntegrationDetails({
    github: workspaceIntegrations.github,
    google: googleState,
    mcp: mcpSettings,
  });

  return (
    <AnalyticsProvider
      identity={{
        userId: user.id,
        workspaceId: workspace.id,
        email: authUser.email,
        firstName: authUser.firstName,
        lastName: authUser.lastName,
      }}
    >
      <QueryProvider>
        <WorkspaceProvider
          workspaceId={workspace.id}
          userId={user.id}
          codexEngineEnabled={isCodexEngineEnabled(user)}
        >
          <CollectionsProvider>
            <ToastProvider>
              <ObservabilityContext userId={user.id} workspaceId={workspace.id} />
              {/* Bridges the mobile right-edge swipe (driven in PersonalShell) to the session
                  inspector that SessionView registers — must sit above both, which are descendants
                  of PersonalShell. No-op on desktop. */}
              <MobileInspectorProvider>
                <PersonalShell
                  agent={agent}
                  userName={userName}
                  userEmail={authUser.email}
                  userTimezone={user.timezone}
                  userTimezoneSource={normalizeUserTimezoneSource(user.timezoneSource)}
                  workspaceName={workspace.name}
                  initialSessions={sessions}
                  contextFiles={contextFiles}
                  personalSkills={personalSkills}
                  githubIntegrationStatus={workspaceIntegrations.github.status}
                  githubRepositories={githubRepositories}
                  workspaceAgents={workspaceAgents}
                  integrationConnections={integrationConnections}
                  integrationDetails={integrationDetails}
                  toolPolicies={toolPolicies}
                  proMode={user.proMode}
                  companySurfaceEnabled={user.companySurfaceEnabled}
                  codexEngineEnabled={user.codexEngineEnabled}
                >
                  {children}
                </PersonalShell>
              </MobileInspectorProvider>
            </ToastProvider>
          </CollectionsProvider>
        </WorkspaceProvider>
      </QueryProvider>
    </AnalyticsProvider>
  );
}
