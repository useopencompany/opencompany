import { AuthKitProvider } from "@workos-inc/authkit-nextjs/components";
import Sidebar from "@/components/Sidebar";
import { getCurrentWorkspace } from "@/lib/auth";

export default async function AppShell({ children }: { children: React.ReactNode }) {
  const { authUser, workspace } = await getCurrentWorkspace();
  const userName =
    [authUser.firstName, authUser.lastName].filter(Boolean).join(" ").trim() ||
    authUser.email;

  return (
    <AuthKitProvider>
      <div className="flex h-screen w-screen overflow-hidden bg-canvas">
        <Sidebar
          userName={userName}
          userEmail={authUser.email}
          workspaceName={workspace.name}
        />
        {children}
      </div>
    </AuthKitProvider>
  );
}
