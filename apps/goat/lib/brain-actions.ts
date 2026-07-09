"use server";

import { currentGoatBrain } from "@/lib/auth";
import {
  type BrainMutationResult,
  deleteGoatBrainDocumentForUser,
  moveGoatBrainDocumentForUser,
  renameGoatBrainDocumentForUser,
  updateGoatBrainDocumentForUser,
} from "@/lib/brain";
import {
  createGoatBrainAssetForUser,
  type GoatBrainAssetUploadInput,
  replaceGoatBrainAssetForUser,
} from "@/lib/brain-assets";

// All mutations run against the active brain from the auth context, which is
// resolved from the user's accessible brains — that lookup is the access check.
// Creating markdown documents and folders is deliberately not exposed as an
// action: written content enters through the brain CLI and ingestion agents
// only. File uploads are the one exception — the upload action registers a
// binary asset whose curation still happens through the ingestion agent.

export async function updateGoatBrainDocumentAction(input: {
  documentId: string;
  body: string;
  expectedContentHash?: string;
}): Promise<BrainMutationResult> {
  const { context, brain } = await currentGoatBrain();
  return updateGoatBrainDocumentForUser({
    brainRef: brain.id,
    userWorkosId: context.user.workosUserId,
    documentId: input.documentId,
    body: input.body,
    ...(input.expectedContentHash ? { expectedContentHash: input.expectedContentHash } : {}),
  });
}

export async function renameGoatBrainDocumentAction(input: {
  documentId: string;
  title: string;
}): Promise<BrainMutationResult> {
  const { context, brain } = await currentGoatBrain();
  return renameGoatBrainDocumentForUser({
    brainRef: brain.id,
    userWorkosId: context.user.workosUserId,
    documentId: input.documentId,
    title: input.title,
  });
}

export async function moveGoatBrainDocumentAction(input: {
  documentId: string;
  folderPath: string;
}): Promise<BrainMutationResult> {
  const { context, brain } = await currentGoatBrain();
  return moveGoatBrainDocumentForUser({
    brainRef: brain.id,
    userWorkosId: context.user.workosUserId,
    documentId: input.documentId,
    folderPath: input.folderPath,
  });
}

export async function deleteGoatBrainDocumentAction(
  documentId: string,
): Promise<BrainMutationResult> {
  const { context, brain } = await currentGoatBrain();
  return deleteGoatBrainDocumentForUser({
    brainRef: brain.id,
    userWorkosId: context.user.workosUserId,
    documentId,
  });
}

export async function uploadGoatBrainAssetAction(
  input: GoatBrainAssetUploadInput,
): Promise<BrainMutationResult> {
  const { context, brain } = await currentGoatBrain();
  return createGoatBrainAssetForUser({
    ...input,
    brainRef: brain.id,
    userWorkosId: context.user.workosUserId,
  });
}

export async function replaceGoatBrainAssetAction(
  input: GoatBrainAssetUploadInput & { documentId: string },
): Promise<BrainMutationResult> {
  const { context, brain } = await currentGoatBrain();
  return replaceGoatBrainAssetForUser({
    ...input,
    brainRef: brain.id,
    userWorkosId: context.user.workosUserId,
  });
}
