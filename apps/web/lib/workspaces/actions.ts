"use server";

import { getDb } from "@opencompany/db/client";
import { workspaces } from "@opencompany/db/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getCurrentWorkspace } from "@/lib/auth";
import { getWorkOSClient } from "@/lib/workos";

export async function updateWorkspaceName(name: string) {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false as const, error: "Name cannot be empty." };
  if (trimmed.length > 80) {
    return { ok: false as const, error: "Name is too long (max 80 chars)." };
  }

  const { workspace } = await getCurrentWorkspace();
  if (!workspace.workosOrganizationId) {
    return { ok: false as const, error: "Workspace is not linked to an organization." };
  }

  const db = getDb();

  await getWorkOSClient().organizations.updateOrganization({
    organization: workspace.workosOrganizationId,
    name: trimmed,
  });

  await db
    .update(workspaces)
    .set({ name: trimmed, updatedAt: new Date() })
    .where(eq(workspaces.id, workspace.id));

  revalidatePath("/", "layout");
  revalidatePath("/settings");

  return { ok: true as const, name: trimmed };
}
