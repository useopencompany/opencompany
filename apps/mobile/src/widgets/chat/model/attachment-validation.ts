import {
  CHAT_ATTACHMENTS_PER_MESSAGE,
  validateChatAttachment,
} from "@opencompany/core/attachments";
import type { ComposerAttachment } from "./chat-composer-context";

export const MAX_CHAT_ATTACHMENTS = CHAT_ATTACHMENTS_PER_MESSAGE;

export function validateComposerAttachments(
  existingCount: number,
  attachments: ComposerAttachment[],
): { valid: ComposerAttachment[]; error: string | null } {
  if (existingCount + attachments.length > MAX_CHAT_ATTACHMENTS)
    return { valid: [], error: "You can attach up to five files to one message." };
  const valid: ComposerAttachment[] = [];
  for (const attachment of attachments) {
    const result = validateChatAttachment({
      filename: attachment.name,
      mediaType: attachment.mimeType ?? "",
      sizeBytes: attachment.size ?? 0,
    });
    if (!result.ok) return { valid: [], error: `${attachment.name}: ${result.message}` };
    valid.push({
      ...attachment,
      kind: result.kind === "image" ? "image" : "file",
      mimeType: result.mediaType,
    });
  }
  return { valid, error: null };
}
