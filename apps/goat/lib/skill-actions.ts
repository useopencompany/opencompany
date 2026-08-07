"use server";

import { isValidGoatBrainId } from "@opencompany/goat-brain";
import { revalidatePath } from "next/cache";
import { currentGoatUser } from "@/lib/auth";
import {
  type GoatSkillImportCandidate,
  GoatSkillImportError,
  previewGoatSkillImport,
} from "@/lib/skill-import";
import {
  archiveGoatSkill,
  createGoatSkill,
  createImportedGoatSkill,
  type GoatSkillMutationResult,
  updateGoatSkill,
} from "@/lib/skills";

export type { GoatSkillImportCandidate };

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
  if (
    !input ||
    typeof input.name !== "string" ||
    (input.description !== undefined && typeof input.description !== "string")
  ) {
    return { ok: false, message: "Invalid skill details." };
  }
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
  status: "draft" | "active";
}): Promise<GoatSkillMutationResult> {
  if (
    !input ||
    !isValidGoatBrainId(input.slug) ||
    typeof input.name !== "string" ||
    typeof input.description !== "string" ||
    typeof input.instructions !== "string" ||
    (input.status !== "draft" && input.status !== "active")
  ) {
    return { ok: false, message: "Invalid skill details." };
  }
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
  if (!input || !isValidGoatBrainId(input.slug)) {
    return { ok: false, message: "Invalid skill." };
  }
  const gate = await requireWorkspaceAdmin();
  if (!gate.ok) return gate;
  const result = await archiveGoatSkill({ workspaceId: gate.workspaceId, slug: input.slug });
  if (result.ok) revalidatePath("/settings/skills");
  return result;
}

export type GoatSkillImportPreviewResult =
  | {
      status: "resolved";
      proposedSlug: string;
      name: string;
      description: string;
      instructions: string;
      extraFiles: string[];
    }
  | { status: "ambiguous"; candidates: GoatSkillImportCandidate[] }
  | { status: "error"; message: string };

// Read-only: resolves and previews an external SKILL.md without writing anything. Mirrors
// apps/web's resolve-then-confirm shape (SaveSkillResult in apps/web/lib/skills/actions.ts) —
// the import step below re-resolves from the URL rather than trusting client-echoed preview
// data, so this step never needs to be trusted for persistence, only for display.
export async function previewGoatSkillImportAction(input: {
  url: string;
  selectedPath?: string;
}): Promise<GoatSkillImportPreviewResult> {
  if (!input || typeof input.url !== "string" || !input.url.trim()) {
    return { status: "error", message: "A skill URL is required." };
  }
  const gate = await requireWorkspaceAdmin();
  if (!gate.ok) return { status: "error", message: gate.message };
  try {
    const preview = await previewGoatSkillImport({
      url: input.url,
      ...(typeof input.selectedPath === "string" ? { selectedPath: input.selectedPath } : {}),
    });
    if (preview.status === "ambiguous") {
      return { status: "ambiguous", candidates: preview.candidates };
    }
    return {
      status: "resolved",
      proposedSlug: preview.proposedSlug,
      name: preview.name,
      description: preview.description,
      instructions: preview.instructions,
      extraFiles: preview.extraFiles,
    };
  } catch (error) {
    if (error instanceof GoatSkillImportError) return { status: "error", message: error.message };
    return { status: "error", message: "Couldn't read that skill. Check the URL and try again." };
  }
}

export type GoatSkillImportResult =
  | { status: "imported"; slug: string }
  | { status: "ambiguous"; candidates: GoatSkillImportCandidate[] }
  | { status: "error"; message: string };

// Re-resolves the URL (never trusts client-submitted preview content — see note above) and
// persists it as a read-only skill. Importing the same source again reuses the existing row
// (createImportedGoatSkill dedups on workspace + source) instead of duplicating it.
export async function importGoatSkillAction(input: {
  url: string;
  selectedPath?: string;
}): Promise<GoatSkillImportResult> {
  if (!input || typeof input.url !== "string" || !input.url.trim()) {
    return { status: "error", message: "A skill URL is required." };
  }
  const gate = await requireWorkspaceAdmin();
  if (!gate.ok) return { status: "error", message: gate.message };
  try {
    const resolved = await previewGoatSkillImport({
      url: input.url,
      ...(typeof input.selectedPath === "string" ? { selectedPath: input.selectedPath } : {}),
    });
    if (resolved.status === "ambiguous") {
      return { status: "ambiguous", candidates: resolved.candidates };
    }
    const result = await createImportedGoatSkill({
      workspaceId: gate.workspaceId,
      createdByWorkosId: gate.userWorkosId,
      name: resolved.name,
      description: resolved.description,
      instructions: resolved.instructions,
      source: resolved.source,
      resolvedCommit: resolved.resolvedCommit,
      integrity: resolved.integrity,
    });
    if (!result.ok) return { status: "error", message: result.message };
    revalidatePath("/settings/skills");
    return { status: "imported", slug: result.slug };
  } catch (error) {
    if (error instanceof GoatSkillImportError) return { status: "error", message: error.message };
    return { status: "error", message: "Couldn't import that skill. Check the URL and try again." };
  }
}
