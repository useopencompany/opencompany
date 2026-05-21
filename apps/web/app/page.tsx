import { redirect } from "next/navigation";
import AppShell from "@/components/AppShell";
import MainPanel from "@/components/MainPanel";
import { getOptionalCurrentWorkspace } from "@/lib/auth";

export default async function Home() {
  const context = await getOptionalCurrentWorkspace();

  if (!context) {
    redirect("/signup");
  }

  return (
    <AppShell>
      <MainPanel workspaceName={context.workspace.name} />
    </AppShell>
  );
}
