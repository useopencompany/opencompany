import { AnalyticsProvider } from "@opencompany/analytics/client";
import { cookies } from "next/headers";
import { Suspense } from "react";
import { CollectionsProvider } from "@/components/CollectionsProvider";
import { MobileMenuButton } from "@/components/MobileMenuButton";
import { ObservabilityContext } from "@/components/ObservabilityContext";
import QueryProvider from "@/components/QueryProvider";
import { ShellChrome } from "@/components/ShellChrome";
import Sidebar from "@/components/Sidebar";
import { ToastProvider } from "@/components/ToastProvider";
import { WorkspaceProvider } from "@/components/WorkspaceContext";
import { loadSidebarSessionsForWorkspace } from "@/lib/agent-sessions/data";
import type { SidebarSessionPayload } from "@/lib/agent-sessions/payload";
import { currentWorkspace } from "@/lib/auth";

const SIDEBAR_COLLAPSED_COOKIE = "opencompany-sidebar-collapsed";

async function SidebarWithSessions({
  userName,
  userEmail,
  workspaceName,
  initialCollapsed,
  sessionsPromise,
}: {
  userName: string;
  userEmail: string;
  workspaceName: string;
  initialCollapsed: boolean;
  sessionsPromise: Promise<SidebarSessionPayload[]>;
}) {
  const sessions = await sessionsPromise;

  return (
    <Sidebar
      userName={userName}
      userEmail={userEmail}
      workspaceName={workspaceName}
      initialCollapsed={initialCollapsed}
      initialSessions={sessions}
    />
  );
}

export default async function AppShell({ children }: { children: React.ReactNode }) {
  const { authUser, user, workspace } = await currentWorkspace();
  const cookieStore = await cookies();
  const sidebarCollapsedCookie = cookieStore.get(SIDEBAR_COLLAPSED_COOKIE);
  const userName =
    [authUser.firstName, authUser.lastName].filter(Boolean).join(" ").trim() || authUser.email;
  const sessionsPromise = loadSidebarSessionsForWorkspace(user.id, workspace.id);
  const initialSidebarCollapsed = sidebarCollapsedCookie?.value === "true";

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
              <div className="flex h-dvh w-full overflow-hidden overflow-x-hidden bg-canvas">
                <ShellChrome
                  sidebar={
                    <Suspense
                      fallback={
                        <Sidebar
                          userName={userName}
                          userEmail={authUser.email}
                          workspaceName={workspace.name}
                          initialCollapsed={initialSidebarCollapsed}
                          initialSessions={[]}
                          sessionsLoading
                        />
                      }
                    >
                      <SidebarWithSessions
                        userName={userName}
                        userEmail={authUser.email}
                        workspaceName={workspace.name}
                        initialCollapsed={initialSidebarCollapsed}
                        sessionsPromise={sessionsPromise}
                      />
                    </Suspense>
                  }
                >
                  <MobileMenuButton />
                  {children}
                </ShellChrome>
              </div>
            </ToastProvider>
          </CollectionsProvider>
        </WorkspaceProvider>
      </QueryProvider>
    </AnalyticsProvider>
  );
}
