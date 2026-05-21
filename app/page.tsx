import AppShell from "@/components/AppShell";
import LoginPanel from "@/components/LoginPanel";
import MainPanel from "@/components/MainPanel";
import { getOptionalCurrentWorkspace } from "@/lib/auth";

export default async function Home() {
  const context = await getOptionalCurrentWorkspace();

  if (!context) {
    return <LoginPanel />;
  }

  return (
    <AppShell>
      <MainPanel workspaceName={context.workspace.name} />
    </AppShell>
  );
}
