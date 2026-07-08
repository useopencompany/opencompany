import { randomUUID } from "node:crypto";
import {
  ATTACHMENT_MAX_PER_MESSAGE,
  modelSupportsAttachments,
  validateAttachmentCandidate,
} from "@opencompany/agent-runtime";
import type { AgentModelId } from "@opencompany/agent-runtime/types";
import type { GoatMessageAttachmentKind } from "@opencompany/db/goat-schema";

export type SubmitGoatAttachmentInput = {
  blobPathname: string;
  blobUrl: string;
  mediaType: string;
  filename: string;
  sizeBytes: number;
};

export type GoatAttachmentView = {
  id: string;
  kind: GoatMessageAttachmentKind;
  mediaType: string;
  filename: string;
  sizeBytes: number;
};

export type GoatStoredAttachment = GoatAttachmentView & {
  blobPathname: string;
  blobUrl: string;
};

export function goatAttachmentBlobPrefix(userWorkosId: string) {
  return `goat/users/${userWorkosId}/`;
}

export function validateGoatSubmitAttachments(input: {
  attachments: readonly SubmitGoatAttachmentInput[];
  userWorkosId: string;
  modelName?: AgentModelId | string;
  checkModelCapabilities?: boolean;
}): { ok: true } | { ok: false; error: string } {
  if (input.attachments.length > ATTACHMENT_MAX_PER_MESSAGE) {
    return { ok: false, error: "Too many attachments." };
  }

  const capability =
    input.checkModelCapabilities === false || !input.modelName
      ? { images: true, pdf: true }
      : modelSupportsAttachments(input.modelName);
  const prefix = goatAttachmentBlobPrefix(input.userWorkosId);

  for (const attachment of input.attachments) {
    const validation = validateAttachmentCandidate({
      mediaType: attachment.mediaType,
      sizeBytes: attachment.sizeBytes,
      filename: attachment.filename,
    });
    if (!validation.ok) {
      return { ok: false, error: "Unsupported or oversized attachment." };
    }
    if (validation.kind === "image" && !capability.images) {
      return { ok: false, error: "This model can't read images." };
    }
    if (validation.kind === "pdf" && !capability.pdf) {
      return { ok: false, error: "This model can't read PDFs." };
    }
    if (!attachment.blobPathname.startsWith(prefix)) {
      return { ok: false, error: "Attachment outside user scope." };
    }
  }

  return { ok: true };
}

export function buildGoatAttachmentRows(input: {
  userWorkosId: string;
  attachments: readonly SubmitGoatAttachmentInput[];
  chatSessionId?: string | null;
  chatMessageId?: string | null;
  taskId?: string | null;
  taskMessageId?: string | null;
  now?: Date;
}) {
  return input.attachments.map((attachment) => {
    const validation = validateAttachmentCandidate({
      mediaType: attachment.mediaType,
      sizeBytes: attachment.sizeBytes,
      filename: attachment.filename,
    });
    if (!validation.ok) {
      throw new Error("Cannot persist invalid Goat attachment.");
    }
    return {
      id: newGoatMessageAttachmentId(),
      userWorkosId: input.userWorkosId,
      chatSessionId: input.chatSessionId ?? null,
      chatMessageId: input.chatMessageId ?? null,
      taskId: input.taskId ?? null,
      taskMessageId: input.taskMessageId ?? null,
      kind: validation.kind,
      mediaType: attachment.mediaType,
      filename: attachment.filename,
      sizeBytes: attachment.sizeBytes,
      blobPathname: attachment.blobPathname,
      blobUrl: attachment.blobUrl,
      createdAt: input.now ?? new Date(),
    };
  });
}

export function newGoatMessageAttachmentId() {
  return `goat_att_${randomUUID()}`;
}
