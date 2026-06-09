import { AnalyticsProvider } from "@opencompany/analytics/client";
import { CollectionsProvider } from "@/components/CollectionsProvider";
import { ObservabilityContext } from "@/components/ObservabilityContext";
import QueryProvider from "@/components/QueryProvider";
import { ToastProvider } from "@/components/ToastProvider";
import { WorkspaceProvider } from "@/components/WorkspaceContext";
import { currentWorkspace } from "@/lib/auth";
import { ensurePersonalAgent } from "@/lib/personal/scaffold";

// V2 onboarding surface (experimental). A deliberately distraction-free chatbox wired to the
// personal agent — NO sidebar/inbox chrome. It lives OUTSIDE the /personal route group precisely
// so it does not inherit PersonalShell; instead it provides only the minimal provider stack the
// composer and the session-creation action consume (workspace context, query client, toasts).
//
// The personal agent is ensured here so that after a dev reset (resetPersonalAgent), the next load
// transparently provisions a fresh agent.
export default async function PersonalOnboardingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { authUser, user, workspace } = await currentWorkspace();

  const agentName = user.firstName?.trim() || authUser.email.split("@")[0] || "You";
  await ensurePersonalAgent({
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
              {children}
            </ToastProvider>
          </CollectionsProvider>
        </WorkspaceProvider>
      </QueryProvider>
    </AnalyticsProvider>
  );
}
