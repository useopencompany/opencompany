"use server";

import { captureServerEvent } from "@opencompany/analytics/server";
import { getDb } from "@opencompany/db/client";
import { agents, type TiptapDoc } from "@opencompany/db/schema";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentWorkspace } from "@/lib/auth";

function newAgentId() {
  const raw = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  return `agt_${raw}`;
}

export async function createAgent() {
  const { user, workspace } = await getCurrentWorkspace();
  const db = getDb();
  const id = newAgentId();

  await db.insert(agents).values({
    id,
    workspaceId: workspace.id,
  });

  await captureServerEvent("agent_created", user.id, {
    user_id: user.id,
    workspace_id: workspace.id,
    agent_id: id,
  });

  revalidatePath("/agents");
  redirect(`/agents/${id}`);
}

export async function updateAgent(id: string, patch: { name?: string; content?: TiptapDoc }) {
  const { user, workspace } = await getCurrentWorkspace();
  const db = getDb();
  const changedFields: Array<"name" | "content"> = [];

  const update: Partial<typeof agents.$inferInsert> = { updatedAt: new Date() };
  if (typeof patch.name === "string") {
    update.name = patch.name;
    changedFields.push("name");
  }
  if (patch.content) {
    update.content = patch.content;
    changedFields.push("content");
  }

  const updated = await db
    .update(agents)
    .set(update)
    .where(and(eq(agents.id, id), eq(agents.workspaceId, workspace.id)))
    .returning({ id: agents.id });

  if (updated.length > 0 && changedFields.length > 0) {
    await captureServerEvent("agent_saved", user.id, {
      user_id: user.id,
      workspace_id: workspace.id,
      agent_id: id,
      changed_fields: changedFields,
    });
  }

  revalidatePath("/agents");
  revalidatePath(`/agents/${id}`);
}
