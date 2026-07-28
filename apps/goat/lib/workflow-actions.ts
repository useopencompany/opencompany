"use server";

import { revalidatePath } from "next/cache";
import { currentGoatUser } from "@/lib/auth";
import {
  archiveGoatWorkflow,
  createGoatWorkflow,
  type GoatWorkflowMutationResult,
  updateGoatWorkflow,
} from "@/lib/workflows";

// Authoring workflows is a workspace-admin mutation, mirroring the old
// Brain-folder authoring gate (manual content was admin-only).
async function requireWorkspaceAdmin(): Promise<
  { ok: false; message: string } | { ok: true; workspaceId: string; userWorkosId: string }
> {
  const context = await currentGoatUser({ optional: true });
  if (!context) return { ok: false, message: "You must be signed in." };
  if (context.role !== "admin") {
    return { ok: false, message: "Only workspace admins can edit workflows." };
  }
  return { ok: true, workspaceId: context.workspace.id, userWorkosId: context.user.workosUserId };
}

export async function createGoatWorkflowAction(input: {
  name: string;
  description?: string;
}): Promise<GoatWorkflowMutationResult> {
  const gate = await requireWorkspaceAdmin();
  if (!gate.ok) return gate;
  const result = await createGoatWorkflow({
    workspaceId: gate.workspaceId,
    createdByWorkosId: gate.userWorkosId,
    name: input.name,
    ...(input.description !== undefined ? { description: input.description } : {}),
  });
  if (result.ok) revalidatePath("/workflows");
  return result;
}

export async function updateGoatWorkflowAction(input: {
  slug: string;
  name: string;
  description: string;
  instructions: string;
  model?: string;
  status?: "draft" | "active";
}): Promise<GoatWorkflowMutationResult> {
  const gate = await requireWorkspaceAdmin();
  if (!gate.ok) return gate;
  const result = await updateGoatWorkflow({ workspaceId: gate.workspaceId, ...input });
  if (result.ok) {
    revalidatePath("/workflows");
    revalidatePath(`/workflows/${input.slug}`);
  }
  return result;
}

export async function archiveGoatWorkflowAction(input: {
  slug: string;
}): Promise<GoatWorkflowMutationResult> {
  const gate = await requireWorkspaceAdmin();
  if (!gate.ok) return gate;
  const result = await archiveGoatWorkflow({ workspaceId: gate.workspaceId, slug: input.slug });
  if (result.ok) revalidatePath("/workflows");
  return result;
}
