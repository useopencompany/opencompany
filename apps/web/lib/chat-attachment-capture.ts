import {
  type GoatChatAttachmentCaptureDependencies,
  saveChatAttachmentsToGoatBrain as saveSharedChatAttachmentsToGoatBrain,
} from "@opencompany/goat-agent/chat-attachment-capture";
import { put } from "@vercel/blob";
import { createGoatBrainAssetForUser, goatBrainAssetUploadPrefix } from "@/lib/brain-assets";
import { downloadGoatChatAttachment } from "@/lib/chat-attachments";
import type { GoatStoredChatMessage, SaveToBrainToolOutput } from "@/lib/chat-ui";
import { triggerGoatBrainIngestWake } from "@/lib/task-runner";

const dependencies: GoatChatAttachmentCaptureDependencies = {
  downloadAttachment: downloadGoatChatAttachment,
  copyToBrain: async ({ brainRef, filename, bytes, mediaType }) =>
    put(`${goatBrainAssetUploadPrefix(brainRef)}${filename}`, bytes, {
      access: "private",
      addRandomSuffix: true,
      contentType: mediaType,
    }),
  createBrainAsset: ({ actorId, ...input }) =>
    createGoatBrainAssetForUser({ ...input, userWorkosId: actorId }),
  wakeIngest: triggerGoatBrainIngestWake,
};

export function saveChatAttachmentsToGoatBrain(input: {
  brainRef: string;
  userWorkosId: string;
  attachmentIds: string[];
  sessionMessages: readonly Pick<GoatStoredChatMessage, "role" | "attachments">[];
}): Promise<SaveToBrainToolOutput> {
  const { userWorkosId, ...command } = input;
  return saveSharedChatAttachmentsToGoatBrain({ ...command, actorId: userWorkosId }, dependencies);
}
