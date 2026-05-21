"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@opencompany/db/client";
import { workspaces } from "@opencompany/db/schema";
import { getCurrentWorkspace } from "@/lib/auth";

export async function updateWorkspaceName(name: string) {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false as const, error: "Name cannot be empty." };
  if (trimmed.length > 80) {
    return { ok: false as const, error: "Name is too long (max 80 chars)." };
  }

  const { workspace } = await getCurrentWorkspace();
  const db = getDb();

  await db
    .update(workspaces)
    .set({ name: trimmed, updatedAt: new Date() })
    .where(eq(workspaces.id, workspace.id));

  revalidatePath("/", "layout");

  return { ok: true as const, name: trimmed };
}
