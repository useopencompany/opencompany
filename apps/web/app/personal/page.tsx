import { AnalyticsProvider } from "@opencompany/analytics/client";
import { CollectionsProvider } from "@/components/CollectionsProvider";
import { ObservabilityContext } from "@/components/ObservabilityContext";
import PersonalSurface from "@/components/PersonalSurface";
import QueryProvider from "@/components/QueryProvider";
import { ToastProvider } from "@/components/ToastProvider";
import { WorkspaceProvider } from "@/components/WorkspaceContext";
import { currentWorkspace } from "@/lib/auth";
import { ensurePersonalAgent } from "@/lib/personal/scaffold";

// Standalone experimentation surface. Deliberately OUTSIDE the (workspace) route group, so it
// does not inherit AppShell/Sidebar — but it still needs the same provider stack (minus the
// sidebar chrome) because the composer and SessionView consume WorkspaceContext, the
// collections, the query client, and toasts.
export default async function PersonalPage() {
  const { authUser, user, workspace } = await currentWorkspace();

  const agentName = user.firstName?.trim() || authUser.email.split("@")[0] || "You";
  const agent = await ensurePersonalAgent({
    userId: user.id,
    workspaceId: workspace.id,
    name: agentName,
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
        <WorkspaceProvider workspaceId={workspace.id} userId={user.id}>
          <CollectionsProvider>
            <ToastProvider>
              <ObservabilityContext userId={user.id} workspaceId={workspace.id} />
              <div className="flex h-screen w-screen flex-col overflow-hidden bg-canvas">
                <PersonalSurface agent={agent} />
              </div>
            </ToastProvider>
          </CollectionsProvider>
        </WorkspaceProvider>
      </QueryProvider>
    </AnalyticsProvider>
  );
}
