"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@opencompany/db/client";
import { agents, type TiptapDoc } from "@opencompany/db/schema";
import { getCurrentWorkspace } from "@/lib/auth";

function newAgentId() {
  const raw = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  return `agt_${raw}`;
}

export async function createAgent() {
  const { workspace } = await getCurrentWorkspace();
  const db = getDb();
  const id = newAgentId();

  await db.insert(agents).values({
    id,
    workspaceId: workspace.id,
  });

  revalidatePath("/agents");
  redirect(`/agents/${id}`);
}

export async function updateAgent(
  id: string,
  patch: { name?: string; content?: TiptapDoc },
) {
  const { workspace } = await getCurrentWorkspace();
  const db = getDb();

  const update: Partial<typeof agents.$inferInsert> = { updatedAt: new Date() };
  if (typeof patch.name === "string") update.name = patch.name;
  if (patch.content) update.content = patch.content;

  await db
    .update(agents)
    .set(update)
    .where(and(eq(agents.id, id), eq(agents.workspaceId, workspace.id)));

  revalidatePath("/agents");
  revalidatePath(`/agents/${id}`);
}
