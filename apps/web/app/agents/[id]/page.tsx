import { getDb } from "@opencompany/db/client";
import { agents } from "@opencompany/db/schema";
import { and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import AgentDetail from "@/components/AgentDetail";
import AppShell from "@/components/AppShell";
import { getCurrentWorkspace } from "@/lib/auth";

export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { workspace } = await getCurrentWorkspace();
  const db = getDb();

  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, id), eq(agents.workspaceId, workspace.id)))
    .limit(1);

  if (!agent) notFound();

  return (
    <AppShell>
      <AgentDetail id={agent.id} initialName={agent.name} initialContent={agent.content} />
    </AppShell>
  );
}
