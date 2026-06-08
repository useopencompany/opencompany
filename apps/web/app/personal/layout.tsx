import { AnalyticsProvider } from "@opencompany/analytics/client";
import { CollectionsProvider } from "@/components/CollectionsProvider";
import { ObservabilityContext } from "@/components/ObservabilityContext";
import PersonalShell from "@/components/personal/PersonalShell";
import QueryProvider from "@/components/QueryProvider";
import { ToastProvider } from "@/components/ToastProvider";
import { WorkspaceProvider } from "@/components/WorkspaceContext";
import { loadPersonalSessionsForAgent } from "@/lib/agent-sessions/data";
import { currentWorkspace } from "@/lib/auth";
import { loadWorkspaceIntegrationState } from "@/lib/integrations/actions";
import { loadPersonalAgentContextFiles, loadPersonalSkills } from "@/lib/personal/context";
import { ensurePersonalAgent } from "@/lib/personal/scaffold";

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

  const agentName = user.firstName?.trim() || authUser.email.split("@")[0] || "You";
  const agent = await ensurePersonalAgent({
    userId: user.id,
    workspaceId: workspace.id,
    name: agentName,
  });

  const [sessions, contextFiles, personalSkills, workspaceIntegrations] = await Promise.all([
    loadPersonalSessionsForAgent(user.id, workspace.id, agent.id),
    loadPersonalAgentContextFiles(workspace.id, agent.id, agent.path),
    loadPersonalSkills(workspace.id, agent.id, agent.path, agent.config),
    loadWorkspaceIntegrationState(),
  ]);
  const userName =
    [authUser.firstName, authUser.lastName].filter(Boolean).join(" ").trim() || authUser.email;

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
        <WorkspaceProvider workspaceId={workspace.id} userId={user.id}>
          <CollectionsProvider>
            <ToastProvider>
              <ObservabilityContext userId={user.id} workspaceId={workspace.id} />
              <PersonalShell
                agent={agent}
                userName={userName}
                userEmail={authUser.email}
                workspaceName={workspace.name}
                initialSessions={sessions}
                contextFiles={contextFiles}
                personalSkills={personalSkills}
                githubIntegrationStatus={workspaceIntegrations.github.status}
              >
                {children}
              </PersonalShell>
            </ToastProvider>
          </CollectionsProvider>
        </WorkspaceProvider>
      </QueryProvider>
    </AnalyticsProvider>
  );
}
