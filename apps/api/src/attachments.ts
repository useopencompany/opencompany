import { randomUUID } from "node:crypto";
import {
  type Actor,
  actorHasPermission,
  CHAT_ATTACHMENT_UPLOAD_TTL_MS,
  CHAT_WRITE_PERMISSION,
  type ChatAttachmentFormat,
  isTextExtractableChatAttachment,
  validateChatAttachment,
} from "@opencompany/core";
import {
  type ChatAttachmentUpload,
  PostgresChatAttachmentRepository,
} from "@opencompany/db/chat-repository";
import { extractDocxText, extractUtf8Text, extractXlsxText } from "@opencompany/file-extract";
import { del, put } from "@vercel/blob";
import { ApiError } from "./errors";

const MAX_FILENAME_LENGTH = 200;
const EXTRACTED_TEXT_MAX_BYTES = 64_000;

export type AttachmentStorage = {
  put(input: {
    pathname: string;
    bytes: Buffer;
    mediaType: string;
  }): Promise<{ pathname: string; url: string }>;
  delete(input: { pathname: string; url: string }): Promise<void>;
};

export type AttachmentUploadService = {
  upload(input: { actor: Actor; file: File }): Promise<ChatAttachmentUpload>;
};

export function createAttachmentUploadService(input: {
  repository: Pick<PostgresChatAttachmentRepository, "create">;
  storage?: AttachmentStorage;
  now?: () => Date;
  id?: () => string;
}): AttachmentUploadService {
  const storage = input.storage ?? vercelBlobStorage();
  const now = input.now ?? (() => new Date());
  const id = input.id ?? (() => `attachment_${randomUUID()}`);
  return {
    async upload({ actor, file }) {
      if (!actorHasPermission(actor, CHAT_WRITE_PERMISSION)) {
        throw new ApiError(403, "forbidden", "Chat write permission is required.");
      }
      const filename = normalizedFilename(file.name);
      const validation = validateChatAttachment({
        filename,
        mediaType: file.type,
        sizeBytes: file.size,
      });
      if (!validation.ok) {
        throw new ApiError(400, "invalid_request", validation.message);
      }
      const attachmentId = id();
      const bytes = Buffer.from(await file.arrayBuffer());
      const pathname = `goat-chat-v1/${actor.userId}/${attachmentId}/${safePathSegment(filename)}`;
      const stored = await storage.put({
        pathname,
        bytes,
        mediaType: validation.mediaType,
      });
      try {
        const createdAt = now();
        const created = await input.repository.create({
          actor,
          id: attachmentId,
          format: validation.format,
          mediaType: validation.mediaType,
          filename,
          sizeBytes: bytes.byteLength,
          blobPathname: stored.pathname,
          blobUrl: stored.url,
          extractedText: await extractAttachmentText(validation.format, bytes),
          expiresAt: new Date(createdAt.getTime() + CHAT_ATTACHMENT_UPLOAD_TTL_MS),
        });
        if (!created) {
          throw new ApiError(403, "forbidden", "The selected workspace is unavailable.");
        }
        return created;
      } catch (error) {
        await storage.delete(stored).catch(() => undefined);
        throw error;
      }
    },
  };
}

function vercelBlobStorage(): AttachmentStorage {
  return {
    async put(input) {
      const stored = await put(input.pathname, input.bytes, {
        access: "private",
        addRandomSuffix: true,
        contentType: input.mediaType,
      });
      return { pathname: stored.pathname, url: stored.url };
    },
    async delete(input) {
      await del(input.url);
    },
  };
}

async function extractAttachmentText(format: ChatAttachmentFormat, bytes: Buffer) {
  try {
    if (format === "docx") {
      return (await extractDocxText(bytes, { maxBytes: EXTRACTED_TEXT_MAX_BYTES })) || null;
    }
    if (format === "xlsx") {
      return (await extractXlsxText(bytes, { maxBytes: EXTRACTED_TEXT_MAX_BYTES })) || null;
    }
    if (isTextExtractableChatAttachment(format)) {
      return extractUtf8Text(bytes, { maxBytes: EXTRACTED_TEXT_MAX_BYTES }) || null;
    }
  } catch {
    // Extraction is best effort. The private file still remains available to supported models.
  }
  return null;
}

function normalizedFilename(value: string) {
  const filename = value
    .trim()
    .replaceAll(/[\u0000-\u001f\u007f]/gu, "")
    .slice(0, MAX_FILENAME_LENGTH);
  return filename || "upload";
}

function safePathSegment(filename: string) {
  const safe = filename.replaceAll(/[^a-zA-Z0-9._-]+/gu, "-").replaceAll(/^-+|-+$/gu, "");
  return safe || "upload";
}
