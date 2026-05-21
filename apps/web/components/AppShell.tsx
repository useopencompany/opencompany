import { AnalyticsProvider } from "@opencompany/analytics/client";
import { AuthKitProvider } from "@workos-inc/authkit-nextjs/components";
import Sidebar from "@/components/Sidebar";
import { getCurrentWorkspace } from "@/lib/auth";

export default async function AppShell({ children }: { children: React.ReactNode }) {
  const { authUser, user, workspace } = await getCurrentWorkspace();
  const userName =
    [authUser.firstName, authUser.lastName].filter(Boolean).join(" ").trim() || authUser.email;

  return (
    <AuthKitProvider>
      <AnalyticsProvider
        identity={{
          userId: user.id,
          workspaceId: workspace.id,
          email: authUser.email,
          firstName: authUser.firstName,
          lastName: authUser.lastName,
        }}
      >
        <div className="flex h-screen w-screen overflow-hidden bg-canvas">
          <Sidebar userName={userName} userEmail={authUser.email} workspaceName={workspace.name} />
          {children}
        </div>
      </AnalyticsProvider>
    </AuthKitProvider>
  );
}
