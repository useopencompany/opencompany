import { AnalyticsProvider } from "@opencompany/analytics/client";
import { getDb } from "@opencompany/db/client";
import { agentSessions } from "@opencompany/db/schema";
import { and, desc, eq, isNull } from "drizzle-orm";
import { cookies } from "next/headers";
import { Suspense } from "react";
import { ObservabilityContext } from "@/components/ObservabilityContext";
import Sidebar from "@/components/Sidebar";
import { requireCurrentWorkspace } from "@/lib/auth";

const SIDEBAR_COLLAPSED_COOKIE = "opencompany-sidebar-collapsed";

type SidebarSessionRow = {
  id: string;
  title: string;
  status: string;
  modelName: string;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function serializeSidebarSessions(sessions: SidebarSessionRow[]) {
  return sessions.map((session) => ({
    ...session,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
  }));
}

async function loadSidebarSessions(userId: string, workspaceId: string) {
  const db = getDb();
  return db
    .select({
      id: agentSessions.id,
      title: agentSessions.title,
      status: agentSessions.status,
      modelName: agentSessions.modelName,
      lastError: agentSessions.lastError,
      createdAt: agentSessions.createdAt,
      updatedAt: agentSessions.updatedAt,
    })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.workspaceId, workspaceId),
        eq(agentSessions.userId, userId),
        isNull(agentSessions.archivedAt),
      ),
    )
    .orderBy(desc(agentSessions.updatedAt))
    .limit(50);
}

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
  sessionsPromise: Promise<SidebarSessionRow[]>;
}) {
  const sessions = await sessionsPromise;

  return (
    <Sidebar
      userName={userName}
      userEmail={userEmail}
      workspaceName={workspaceName}
      initialCollapsed={initialCollapsed}
      sessions={serializeSidebarSessions(sessions)}
    />
  );
}

export default async function AppShell({ children }: { children: React.ReactNode }) {
  const { authUser, user, workspace } = await requireCurrentWorkspace();
  const cookieStore = await cookies();
  const sidebarCollapsedCookie = cookieStore.get(SIDEBAR_COLLAPSED_COOKIE);
  const userName =
    [authUser.firstName, authUser.lastName].filter(Boolean).join(" ").trim() || authUser.email;
  const sessionsPromise = loadSidebarSessions(user.id, workspace.id);
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
      <ObservabilityContext userId={user.id} workspaceId={workspace.id} />
      <div className="flex h-screen w-screen overflow-hidden bg-canvas">
        <Suspense
          fallback={
            <Sidebar
              userName={userName}
              userEmail={authUser.email}
              workspaceName={workspace.name}
              initialCollapsed={initialSidebarCollapsed}
              sessions={[]}
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
        {children}
      </div>
    </AnalyticsProvider>
  );
}
