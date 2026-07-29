"use server";

import { currentGoatBrainByRef } from "@/lib/auth";
import {
  type BrainMutationResult,
  createGoatBrainDocumentForUser,
  createGoatBrainFolderForUser,
  createGoatBrainSkillForUser,
  createGoatBrainWorkflowForUser,
  deleteGoatBrainDocumentForUser,
  deleteGoatBrainFolderForUser,
  moveGoatBrainDocumentForUser,
  renameGoatBrainDocumentForUser,
  renameGoatBrainFolderForUser,
  updateGoatBrainDocumentForUser,
  updateGoatBrainSkillForUser,
  updateGoatBrainWorkflowForUser,
} from "@/lib/brain";
import {
  createGoatBrainAssetForUser,
  type GoatBrainAssetUploadInput,
  replaceGoatBrainAssetForUser,
} from "@/lib/brain-assets";

// All mutations run against the explicit route-selected brain after checking
// that the current user can access it.
// Manual markdown and folder creation are admin-only mutations. Automated and
// external content still enters through the brain CLI and ingestion agents.

export async function createGoatBrainDocumentAction(input: {
  brainRef: string;
  folderPath: string;
  fileName: string;
}): Promise<BrainMutationResult> {
  const resolved = await resolveBrainMutationContext(input.brainRef);
  if ("ok" in resolved) return resolved;
  const { context, brain } = resolved;
  return createGoatBrainDocumentForUser({
    brainRef: brain.id,
    userWorkosId: context.user.workosUserId,
    folderPath: input.folderPath,
    fileName: input.fileName,
  });
}

export async function createGoatBrainSkillAction(input: {
  brainRef: string;
  folderPath: string;
  name: string;
  description?: string;
}): Promise<BrainMutationResult> {
  const resolved = await resolveBrainMutationContext(input.brainRef);
  if ("ok" in resolved) return resolved;
  const { context, brain } = resolved;
  return createGoatBrainSkillForUser({
    brainRef: brain.id,
    userWorkosId: context.user.workosUserId,
    folderPath: input.folderPath,
    name: input.name,
    ...(input.description !== undefined ? { description: input.description } : {}),
  });
}

export async function createGoatBrainWorkflowAction(input: {
  brainRef: string;
  folderPath: string;
  name: string;
  description?: string;
}): Promise<BrainMutationResult> {
  const resolved = await resolveBrainMutationContext(input.brainRef);
  if ("ok" in resolved) return resolved;
  const { context, brain } = resolved;
  return createGoatBrainWorkflowForUser({
    brainRef: brain.id,
    userWorkosId: context.user.workosUserId,
    folderPath: input.folderPath,
    name: input.name,
    ...(input.description !== undefined ? { description: input.description } : {}),
  });
}

export async function updateGoatBrainDocumentAction(input: {
  brainRef: string;
  documentId: string;
  body: string;
  expectedContentHash?: string;
}): Promise<BrainMutationResult> {
  const resolved = await resolveBrainMutationContext(input.brainRef);
  if ("ok" in resolved) return resolved;
  const { context, brain } = resolved;
  return updateGoatBrainDocumentForUser({
    brainRef: brain.id,
    userWorkosId: context.user.workosUserId,
    documentId: input.documentId,
    body: input.body,
    ...(input.expectedContentHash ? { expectedContentHash: input.expectedContentHash } : {}),
  });
}

export async function updateGoatBrainSkillAction(input: {
  brainRef: string;
  documentId: string;
  name: string;
  description: string;
  instructions: string;
  expectedContentHash?: string;
}): Promise<BrainMutationResult> {
  const resolved = await resolveBrainMutationContext(input.brainRef);
  if ("ok" in resolved) return resolved;
  const { context, brain } = resolved;
  return updateGoatBrainSkillForUser({
    brainRef: brain.id,
    userWorkosId: context.user.workosUserId,
    documentId: input.documentId,
    name: input.name,
    description: input.description,
    instructions: input.instructions,
    ...(input.expectedContentHash ? { expectedContentHash: input.expectedContentHash } : {}),
  });
}

export async function updateGoatBrainWorkflowAction(input: {
  brainRef: string;
  documentId: string;
  name: string;
  description: string;
  instructions: string;
  model?: string;
  expectedContentHash?: string;
}): Promise<BrainMutationResult> {
  const resolved = await resolveBrainMutationContext(input.brainRef);
  if ("ok" in resolved) return resolved;
  const { context, brain } = resolved;
  return updateGoatBrainWorkflowForUser({
    brainRef: brain.id,
    userWorkosId: context.user.workosUserId,
    documentId: input.documentId,
    name: input.name,
    description: input.description,
    instructions: input.instructions,
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.expectedContentHash ? { expectedContentHash: input.expectedContentHash } : {}),
  });
}

export async function renameGoatBrainDocumentAction(input: {
  brainRef: string;
  documentId: string;
  title: string;
}): Promise<BrainMutationResult> {
  const resolved = await resolveBrainMutationContext(input.brainRef);
  if ("ok" in resolved) return resolved;
  const { context, brain } = resolved;
  return renameGoatBrainDocumentForUser({
    brainRef: brain.id,
    userWorkosId: context.user.workosUserId,
    documentId: input.documentId,
    title: input.title,
  });
}

export async function moveGoatBrainDocumentAction(input: {
  brainRef: string;
  documentId: string;
  folderPath: string;
}): Promise<BrainMutationResult> {
  const resolved = await resolveBrainMutationContext(input.brainRef);
  if ("ok" in resolved) return resolved;
  const { context, brain } = resolved;
  return moveGoatBrainDocumentForUser({
    brainRef: brain.id,
    userWorkosId: context.user.workosUserId,
    documentId: input.documentId,
    folderPath: input.folderPath,
  });
}

export async function deleteGoatBrainDocumentAction(input: {
  brainRef: string;
  documentId: string;
}): Promise<BrainMutationResult> {
  const resolved = await resolveBrainMutationContext(input.brainRef);
  if ("ok" in resolved) return resolved;
  const { context, brain } = resolved;
  return deleteGoatBrainDocumentForUser({
    brainRef: brain.id,
    userWorkosId: context.user.workosUserId,
    documentId: input.documentId,
  });
}

export async function createGoatBrainFolderAction(input: {
  brainRef: string;
  folderPath: string;
}): Promise<BrainMutationResult> {
  const resolved = await resolveBrainMutationContext(input.brainRef);
  if ("ok" in resolved) return resolved;
  const { context, brain } = resolved;
  return createGoatBrainFolderForUser({
    brainRef: brain.id,
    userWorkosId: context.user.workosUserId,
    folderPath: input.folderPath,
  });
}

export async function renameGoatBrainFolderAction(input: {
  brainRef: string;
  fromPath: string;
  toPath: string;
}): Promise<BrainMutationResult> {
  const resolved = await resolveBrainMutationContext(input.brainRef);
  if ("ok" in resolved) return resolved;
  const { context, brain } = resolved;
  return renameGoatBrainFolderForUser({
    brainRef: brain.id,
    userWorkosId: context.user.workosUserId,
    fromPath: input.fromPath,
    toPath: input.toPath,
  });
}

export async function deleteGoatBrainFolderAction(input: {
  brainRef: string;
  folderPath: string;
}): Promise<BrainMutationResult> {
  const resolved = await resolveBrainMutationContext(input.brainRef);
  if ("ok" in resolved) return resolved;
  const { context, brain } = resolved;
  return deleteGoatBrainFolderForUser({
    brainRef: brain.id,
    userWorkosId: context.user.workosUserId,
    folderPath: input.folderPath,
  });
}

export async function uploadGoatBrainAssetAction(
  input: GoatBrainAssetUploadInput & { brainRef: string },
): Promise<BrainMutationResult> {
  const resolved = await resolveBrainMutationContext(input.brainRef);
  if ("ok" in resolved) return resolved;
  const { context, brain } = resolved;
  return createGoatBrainAssetForUser({
    ...input,
    brainRef: brain.id,
    userWorkosId: context.user.workosUserId,
  });
}

export async function replaceGoatBrainAssetAction(
  input: GoatBrainAssetUploadInput & { brainRef: string; documentId: string },
): Promise<BrainMutationResult> {
  const resolved = await resolveBrainMutationContext(input.brainRef);
  if ("ok" in resolved) return resolved;
  const { context, brain } = resolved;
  return replaceGoatBrainAssetForUser({
    ...input,
    brainRef: brain.id,
    userWorkosId: context.user.workosUserId,
  });
}

async function resolveBrainMutationContext(brainRef: string): Promise<
  | Awaited<ReturnType<typeof currentGoatBrainByRef>>
  | {
      ok: false;
      message: string;
    }
> {
  try {
    const resolved = await currentGoatBrainByRef(brainRef);
    if (resolved.context.role !== "admin") {
      return { ok: false, message: "Only workspace admins can edit the brain." };
    }
    return resolved;
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "You do not have access to that brain.",
    };
  }
}
