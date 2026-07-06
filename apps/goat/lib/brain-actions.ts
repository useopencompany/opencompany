"use server";

import { currentGoatUser } from "@/lib/auth";
import {
  type BrainMutationResult,
  createGoatBrainDocumentForUser,
  createGoatBrainFolderForUser,
  deleteGoatBrainDocumentForUser,
  moveGoatBrainDocumentForUser,
  updateGoatBrainDocumentForUser,
} from "@/lib/brain";

export async function createGoatBrainFolderAction(path: string): Promise<BrainMutationResult> {
  const { user } = await currentGoatUser();
  return createGoatBrainFolderForUser(user.workosUserId, path);
}

export async function createGoatBrainDocumentAction(input: {
  folderPath: string;
  title?: string;
}): Promise<BrainMutationResult> {
  const { user } = await currentGoatUser();
  return createGoatBrainDocumentForUser({
    userWorkosId: user.workosUserId,
    folderPath: input.folderPath,
    ...(input.title ? { title: input.title } : {}),
  });
}

export async function updateGoatBrainDocumentAction(input: {
  documentId: string;
  body: string;
  expectedContentHash?: string;
}): Promise<BrainMutationResult> {
  const { user } = await currentGoatUser();
  return updateGoatBrainDocumentForUser({
    userWorkosId: user.workosUserId,
    documentId: input.documentId,
    body: input.body,
    ...(input.expectedContentHash ? { expectedContentHash: input.expectedContentHash } : {}),
  });
}

export async function moveGoatBrainDocumentAction(input: {
  documentId: string;
  folderPath: string;
}): Promise<BrainMutationResult> {
  const { user } = await currentGoatUser();
  return moveGoatBrainDocumentForUser({
    userWorkosId: user.workosUserId,
    documentId: input.documentId,
    folderPath: input.folderPath,
  });
}

export async function deleteGoatBrainDocumentAction(
  documentId: string,
): Promise<BrainMutationResult> {
  const { user } = await currentGoatUser();
  return deleteGoatBrainDocumentForUser({
    userWorkosId: user.workosUserId,
    documentId,
  });
}
