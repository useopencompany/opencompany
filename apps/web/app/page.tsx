import { redirect } from "next/navigation";
import { getDb } from "@opencompany/db/client";
import { agents } from "@opencompany/db/schema";
import { desc, eq } from "drizzle-orm";
import AppShell from "@/components/AppShell";
import MainPanel from "@/components/MainPanel";
import { getOptionalCurrentWorkspace } from "@/lib/auth";

export default async function Home() {
  const context = await getOptionalCurrentWorkspace();

  if (!context) {
    redirect("/signup");
  }

  const db = getDb();
  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
    })
    .from(agents)
    .where(eq(agents.workspaceId, context.workspace.id))
    .orderBy(desc(agents.updatedAt));

  return (
    <AppShell>
      <MainPanel agents={rows} />
    </AppShell>
  );
}
