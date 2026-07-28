"use server";

import { revalidatePath } from "next/cache";
import { currentGoatUser } from "@/lib/auth";
import {
  archiveGoatSkill,
  createGoatSkill,
  type GoatSkillMutationResult,
  updateGoatSkill,
} from "@/lib/skills";

// Authoring skills is a workspace-admin mutation, mirroring the old Brain-folder
// authoring gate (manual content was admin-only).
async function requireWorkspaceAdmin(): Promise<
  { ok: false; message: string } | { ok: true; workspaceId: string; userWorkosId: string }
> {
  const context = await currentGoatUser({ optional: true });
  if (!context) return { ok: false, message: "You must be signed in." };
  if (context.role !== "admin") {
    return { ok: false, message: "Only workspace admins can edit skills." };
  }
  return { ok: true, workspaceId: context.workspace.id, userWorkosId: context.user.workosUserId };
}

export async function createGoatSkillAction(input: {
  name: string;
  description?: string;
}): Promise<GoatSkillMutationResult> {
  const gate = await requireWorkspaceAdmin();
  if (!gate.ok) return gate;
  const result = await createGoatSkill({
    workspaceId: gate.workspaceId,
    createdByWorkosId: gate.userWorkosId,
    name: input.name,
    ...(input.description !== undefined ? { description: input.description } : {}),
  });
  if (result.ok) revalidatePath("/settings/skills");
  return result;
}

export async function updateGoatSkillAction(input: {
  slug: string;
  name: string;
  description: string;
  instructions: string;
  status?: "draft" | "active";
}): Promise<GoatSkillMutationResult> {
  const gate = await requireWorkspaceAdmin();
  if (!gate.ok) return gate;
  const result = await updateGoatSkill({ workspaceId: gate.workspaceId, ...input });
  if (result.ok) {
    revalidatePath("/settings/skills");
    revalidatePath(`/settings/skills/${input.slug}`);
  }
  return result;
}

export async function archiveGoatSkillAction(input: {
  slug: string;
}): Promise<GoatSkillMutationResult> {
  const gate = await requireWorkspaceAdmin();
  if (!gate.ok) return gate;
  const result = await archiveGoatSkill({ workspaceId: gate.workspaceId, slug: input.slug });
  if (result.ok) revalidatePath("/settings/skills");
  return result;
}
