"use server";

import { currentBrainByRef } from "@/lib/auth";
import {
  type BrainMutationResult,
  createBrainDocumentForUser,
  createBrainFolderForUser,
  createBrainSkillForUser,
  createBrainWorkflowForUser,
  deleteBrainDocumentForUser,
  deleteBrainFolderForUser,
  moveBrainDocumentForUser,
  renameBrainDocumentForUser,
  renameBrainFolderForUser,
  updateBrainDocumentForUser,
  updateBrainSkillForUser,
  updateBrainWorkflowForUser,
} from "@/lib/brain";
import {
  type BrainAssetUploadInput,
  createBrainAssetForUser,
  replaceBrainAssetForUser,
} from "@/lib/brain-assets";

// All mutations run against the explicit route-selected brain after checking
// that the current user can access it.
// Manual markdown and folder creation are admin-only mutations. Automated and
// external content still enters through the brain CLI and ingestion agents.

export async function createBrainDocumentAction(input: {
  brainRef: string;
  folderPath: string;
  fileName: string;
}): Promise<BrainMutationResult> {
  const resolved = await resolveBrainMutationContext(input.brainRef);
  if ("ok" in resolved) return resolved;
  const { context, brain } = resolved;
  return createBrainDocumentForUser({
    brainRef: brain.id,
    userWorkosId: context.user.workosUserId,
    folderPath: input.folderPath,
    fileName: input.fileName,
  });
}

export async function createBrainSkillAction(input: {
  brainRef: string;
  folderPath: string;
  name: string;
  description?: string;
}): Promise<BrainMutationResult> {
  const resolved = await resolveBrainMutationContext(input.brainRef);
  if ("ok" in resolved) return resolved;
  const { context, brain } = resolved;
  return createBrainSkillForUser({
    brainRef: brain.id,
    userWorkosId: context.user.workosUserId,
    folderPath: input.folderPath,
    name: input.name,
    ...(input.description !== undefined ? { description: input.description } : {}),
  });
}

export async function createBrainWorkflowAction(input: {
  brainRef: string;
  folderPath: string;
  name: string;
  description?: string;
}): Promise<BrainMutationResult> {
  const resolved = await resolveBrainMutationContext(input.brainRef);
  if ("ok" in resolved) return resolved;
  const { context, brain } = resolved;
  return createBrainWorkflowForUser({
    brainRef: brain.id,
    userWorkosId: context.user.workosUserId,
    folderPath: input.folderPath,
    name: input.name,
    ...(input.description !== undefined ? { description: input.description } : {}),
  });
}

export async function updateBrainDocumentAction(input: {
  brainRef: string;
  documentId: string;
  body: string;
  expectedContentHash?: string;
}): Promise<BrainMutationResult> {
  const resolved = await resolveBrainMutationContext(input.brainRef);
  if ("ok" in resolved) return resolved;
  const { context, brain } = resolved;
  return updateBrainDocumentForUser({
    brainRef: brain.id,
    userWorkosId: context.user.workosUserId,
    documentId: input.documentId,
    body: input.body,
    ...(input.expectedContentHash ? { expectedContentHash: input.expectedContentHash } : {}),
  });
}

export async function updateBrainSkillAction(input: {
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
  return updateBrainSkillForUser({
    brainRef: brain.id,
    userWorkosId: context.user.workosUserId,
    documentId: input.documentId,
    name: input.name,
    description: input.description,
    instructions: input.instructions,
    ...(input.expectedContentHash ? { expectedContentHash: input.expectedContentHash } : {}),
  });
}

export async function updateBrainWorkflowAction(input: {
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
  return updateBrainWorkflowForUser({
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

export async function renameBrainDocumentAction(input: {
  brainRef: string;
  documentId: string;
  title: string;
}): Promise<BrainMutationResult> {
  const resolved = await resolveBrainMutationContext(input.brainRef);
  if ("ok" in resolved) return resolved;
  const { context, brain } = resolved;
  return renameBrainDocumentForUser({
    brainRef: brain.id,
    userWorkosId: context.user.workosUserId,
    documentId: input.documentId,
    title: input.title,
  });
}

export async function moveBrainDocumentAction(input: {
  brainRef: string;
  documentId: string;
  folderPath: string;
}): Promise<BrainMutationResult> {
  const resolved = await resolveBrainMutationContext(input.brainRef);
  if ("ok" in resolved) return resolved;
  const { context, brain } = resolved;
  return moveBrainDocumentForUser({
    brainRef: brain.id,
    userWorkosId: context.user.workosUserId,
    documentId: input.documentId,
    folderPath: input.folderPath,
  });
}

export async function deleteBrainDocumentAction(input: {
  brainRef: string;
  documentId: string;
}): Promise<BrainMutationResult> {
  const resolved = await resolveBrainMutationContext(input.brainRef);
  if ("ok" in resolved) return resolved;
  const { context, brain } = resolved;
  return deleteBrainDocumentForUser({
    brainRef: brain.id,
    userWorkosId: context.user.workosUserId,
    documentId: input.documentId,
  });
}

export async function createBrainFolderAction(input: {
  brainRef: string;
  folderPath: string;
}): Promise<BrainMutationResult> {
  const resolved = await resolveBrainMutationContext(input.brainRef);
  if ("ok" in resolved) return resolved;
  const { context, brain } = resolved;
  return createBrainFolderForUser({
    brainRef: brain.id,
    userWorkosId: context.user.workosUserId,
    folderPath: input.folderPath,
  });
}

export async function renameBrainFolderAction(input: {
  brainRef: string;
  fromPath: string;
  toPath: string;
}): Promise<BrainMutationResult> {
  const resolved = await resolveBrainMutationContext(input.brainRef);
  if ("ok" in resolved) return resolved;
  const { context, brain } = resolved;
  return renameBrainFolderForUser({
    brainRef: brain.id,
    userWorkosId: context.user.workosUserId,
    fromPath: input.fromPath,
    toPath: input.toPath,
  });
}

export async function deleteBrainFolderAction(input: {
  brainRef: string;
  folderPath: string;
}): Promise<BrainMutationResult> {
  const resolved = await resolveBrainMutationContext(input.brainRef);
  if ("ok" in resolved) return resolved;
  const { context, brain } = resolved;
  return deleteBrainFolderForUser({
    brainRef: brain.id,
    userWorkosId: context.user.workosUserId,
    folderPath: input.folderPath,
  });
}

export async function uploadBrainAssetAction(
  input: BrainAssetUploadInput & { brainRef: string },
): Promise<BrainMutationResult> {
  const resolved = await resolveBrainMutationContext(input.brainRef);
  if ("ok" in resolved) return resolved;
  const { context, brain } = resolved;
  return createBrainAssetForUser({
    ...input,
    brainRef: brain.id,
    userWorkosId: context.user.workosUserId,
  });
}

export async function replaceBrainAssetAction(
  input: BrainAssetUploadInput & { brainRef: string; documentId: string },
): Promise<BrainMutationResult> {
  const resolved = await resolveBrainMutationContext(input.brainRef);
  if ("ok" in resolved) return resolved;
  const { context, brain } = resolved;
  return replaceBrainAssetForUser({
    ...input,
    brainRef: brain.id,
    userWorkosId: context.user.workosUserId,
  });
}

async function resolveBrainMutationContext(brainRef: string): Promise<
  | Awaited<ReturnType<typeof currentBrainByRef>>
  | {
      ok: false;
      message: string;
    }
> {
  try {
    const resolved = await currentBrainByRef(brainRef);
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
