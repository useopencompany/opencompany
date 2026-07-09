"use server";

import { currentGoatBrain } from "@/lib/auth";
import {
  type BrainMutationResult,
  deleteGoatBrainDocumentForUser,
  moveGoatBrainDocumentForUser,
  renameGoatBrainDocumentForUser,
  updateGoatBrainDocumentForUser,
} from "@/lib/brain";

// All mutations run against the active brain from the auth context, which is
// resolved from the user's accessible brains — that lookup is the access check.
// Creating documents and folders is deliberately not exposed as an action:
// new content enters through the brain CLI and ingestion agents only.

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
