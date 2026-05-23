import { AnalyticsProvider } from "@opencompany/analytics/client";
import { getDb } from "@opencompany/db/client";
import { agentSessions } from "@opencompany/db/schema";
import { and, desc, eq, isNull } from "drizzle-orm";
import { ObservabilityContext } from "@/components/ObservabilityContext";
import Sidebar from "@/components/Sidebar";
import { requireCurrentWorkspace } from "@/lib/auth";

export default async function AppShell({ children }: { children: React.ReactNode }) {
  const { authUser, user, workspace } = await requireCurrentWorkspace();
  const userName =
    [authUser.firstName, authUser.lastName].filter(Boolean).join(" ").trim() || authUser.email;
  const db = getDb();
  const sessions = await db
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
        eq(agentSessions.workspaceId, workspace.id),
        eq(agentSessions.userId, user.id),
        isNull(agentSessions.archivedAt),
      ),
    )
    .orderBy(desc(agentSessions.updatedAt))
    .limit(50);

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
        <Sidebar
          userName={userName}
          userEmail={authUser.email}
          workspaceName={workspace.name}
          sessions={sessions.map((session) => ({
            ...session,
            createdAt: session.createdAt.toISOString(),
            updatedAt: session.updatedAt.toISOString(),
          }))}
        />
        {children}
      </div>
    </AnalyticsProvider>
  );
}
