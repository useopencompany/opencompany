import { createHash, randomUUID } from "node:crypto";
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
import { extractDocumentMarkdown } from "@opencompany/file-extract";
import { createLogger } from "@opencompany/observability";
import { del, put } from "@vercel/blob";
import { ApiError } from "./errors";

const MAX_FILENAME_LENGTH = 200;
const EXTRACTED_TEXT_MAX_BYTES = 64_000;
const UPLOAD_FINGERPRINT_VERSION = "chat_attachment.upload.v1";
const logger = createLogger({ service: "opencompany-api", runtime: "attachments" });

export type AttachmentStorage = {
  put(input: {
    pathname: string;
    bytes: Buffer;
    mediaType: string;
    deterministic: boolean;
  }): Promise<{ pathname: string; url: string }>;
  delete(input: { pathname: string; url: string }): Promise<void>;
};

export type AttachmentUploadResult = ChatAttachmentUpload & { replayed: boolean };

export type AttachmentUploadService = {
  upload(input: {
    actor: Actor;
    file: File;
    idempotencyKey?: string;
  }): Promise<AttachmentUploadResult>;
};

type AttachmentRepository = Pick<
  PostgresChatAttachmentRepository,
  "create" | "reserve" | "findCompleted" | "complete"
>;

export function createAttachmentUploadService(input: {
  repository: AttachmentRepository;
  storage?: AttachmentStorage;
  now?: () => Date;
  id?: () => string;
}): AttachmentUploadService {
  const storage = input.storage ?? vercelBlobStorage();
  const now = input.now ?? (() => new Date());
  const id = input.id ?? (() => `attachment_${randomUUID()}`);
  return {
    async upload({ actor, file, idempotencyKey }) {
      if (!actorHasPermission(actor, CHAT_WRITE_PERMISSION)) {
        throw new ApiError(403, "forbidden", "Chat write permission is required.");
      }
      const validated = await validatedFile(file);
      if (!idempotencyKey) {
        return {
          ...(await uploadUnkeyed({
            actor,
            file: validated,
            repository: input.repository,
            storage,
            now,
            id,
          })),
          replayed: false,
        };
      }
      assertIdempotencyKey(idempotencyKey);
      return uploadKeyed({
        actor,
        file: validated,
        idempotencyKey,
        repository: input.repository,
        storage,
        now,
      });
    },
  };
}

type ValidatedAttachmentFile = {
  bytes: Buffer;
  filename: string;
  format: ChatAttachmentFormat;
  mediaType: string;
};

async function validatedFile(file: File): Promise<ValidatedAttachmentFile> {
  const filename = normalizedFilename(file.name);
  const validation = validateChatAttachment({
    filename,
    mediaType: file.type,
    sizeBytes: file.size,
  });
  if (!validation.ok) {
    throw new ApiError(400, "invalid_request", validation.message);
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.byteLength !== file.size) {
    throw new ApiError(400, "invalid_request", "The uploaded file size is invalid.");
  }
  return {
    bytes,
    filename,
    format: validation.format,
    mediaType: validation.mediaType,
  };
}

async function uploadUnkeyed(input: {
  actor: Actor;
  file: ValidatedAttachmentFile;
  repository: AttachmentRepository;
  storage: AttachmentStorage;
  now: () => Date;
  id: () => string;
}) {
  const attachmentId = input.id();
  const pathname = `goat-chat-v1/${input.actor.userId}/${attachmentId}/${safePathSegment(input.file.filename)}`;
  const stored = await privateAttachmentBoundary("blob_put", () =>
    input.storage.put({
      pathname,
      bytes: input.file.bytes,
      mediaType: input.file.mediaType,
      deterministic: false,
    }),
  );
  try {
    const createdAt = input.now();
    const extractedText = await extractAttachmentText(input.file);
    const created = await privateAttachmentBoundary("database_create", () =>
      input.repository.create({
        actor: input.actor,
        id: attachmentId,
        format: input.file.format,
        mediaType: input.file.mediaType,
        filename: input.file.filename,
        sizeBytes: input.file.bytes.byteLength,
        blobPathname: stored.pathname,
        blobUrl: stored.url,
        extractedText,
        expiresAt: new Date(createdAt.getTime() + CHAT_ATTACHMENT_UPLOAD_TTL_MS),
      }),
    );
    if (!created) {
      throw new ApiError(403, "forbidden", "The selected workspace is unavailable.");
    }
    return created;
  } catch (error) {
    await input.storage.delete(stored).catch(() => undefined);
    throw error;
  }
}

async function uploadKeyed(input: {
  actor: Actor;
  file: ValidatedAttachmentFile;
  idempotencyKey: string;
  repository: AttachmentRepository;
  storage: AttachmentStorage;
  now: () => Date;
}): Promise<AttachmentUploadResult> {
  const commandId = deterministicId("attachment_upload_command", input.actor, input.idempotencyKey);
  const attachmentId = deterministicId("attachment", input.actor, input.idempotencyKey);
  const blobPathname = `goat-chat-v1/${input.actor.userId}/${attachmentId}/content`;
  const requestedAt = input.now();
  const requestHash = attachmentRequestHash(input.file);
  const reservation = await privateAttachmentBoundary("database_reserve", () =>
    input.repository.reserve({
      actor: input.actor,
      commandId,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      attachmentId,
      blobPathname,
      expiresAt: new Date(requestedAt.getTime() + CHAT_ATTACHMENT_UPLOAD_TTL_MS),
    }),
  );
  if (!reservation) {
    throw new ApiError(403, "forbidden", "The selected workspace is unavailable.");
  }
  if (reservation.requestHash !== requestHash) {
    throw new ApiError(
      409,
      "idempotency_conflict",
      "The Idempotency-Key was already used for another attachment upload.",
    );
  }
  if (reservation.cleanedAt || reservation.expiresAt.getTime() <= requestedAt.getTime()) {
    throw new ApiError(
      409,
      "conflict",
      "This attachment upload has expired or was cleaned up. Retry with a new Idempotency-Key.",
    );
  }
  if (reservation.completedAt) {
    const completed = await privateAttachmentBoundary("database_replay", () =>
      input.repository.findCompleted(reservation.commandId),
    );
    if (completed) return { ...completed, replayed: true };
    throw new ApiError(
      409,
      "conflict",
      "This attachment upload is no longer available. Retry with a new Idempotency-Key.",
    );
  }

  const stored = await privateAttachmentBoundary("blob_put", () =>
    input.storage.put({
      pathname: reservation.blobPathname,
      bytes: input.file.bytes,
      mediaType: input.file.mediaType,
      deterministic: true,
    }),
  );
  const extractedText = await extractAttachmentText(input.file);
  const completed = await privateAttachmentBoundary("database_complete", () =>
    input.repository.complete({
      commandId: reservation.commandId,
      format: input.file.format,
      mediaType: input.file.mediaType,
      filename: input.file.filename,
      sizeBytes: input.file.bytes.byteLength,
      blobUrl: stored.url,
      extractedText,
    }),
  );
  if (completed) {
    const { created, ...attachment } = completed;
    return { ...attachment, replayed: !created };
  }

  // A concurrent identical request can win after this statement's snapshot was established.
  const winner = await privateAttachmentBoundary("database_race_replay", () =>
    input.repository.findCompleted(reservation.commandId),
  );
  if (winner) return { ...winner, replayed: true };
  throw new ApiError(403, "forbidden", "The selected workspace is unavailable.");
}

function vercelBlobStorage(): AttachmentStorage {
  return {
    async put(input) {
      const stored = await put(input.pathname, input.bytes, {
        access: "private",
        addRandomSuffix: !input.deterministic,
        ...(input.deterministic ? { allowOverwrite: true } : {}),
        contentType: input.mediaType,
      });
      return { pathname: stored.pathname, url: stored.url };
    },
    async delete(input) {
      await del(input.url);
    },
  };
}

async function extractAttachmentText(file: ValidatedAttachmentFile) {
  // PDFs and images are handed to supported models natively rather than extracted here.
  if (!isTextExtractableChatAttachment(file.format)) {
    return null;
  }
  try {
    const { markdown } = await extractDocumentMarkdown({
      bytes: file.bytes,
      filename: file.filename,
      mediaType: file.mediaType,
      maxOutputBytes: EXTRACTED_TEXT_MAX_BYTES,
    });
    return markdown || null;
  } catch {
    // Extraction is best effort. The private file still remains available to supported models.
    return null;
  }
}

function attachmentRequestHash(file: ValidatedAttachmentFile) {
  const contentHash = createHash("sha256").update(file.bytes).digest("hex");
  return createHash("sha256")
    .update(
      JSON.stringify({
        operation: UPLOAD_FINGERPRINT_VERSION,
        filename: file.filename,
        mediaType: file.mediaType,
        sizeBytes: file.bytes.byteLength,
        contentHash,
      }),
    )
    .digest("hex");
}

function deterministicId(prefix: string, actor: Actor, key: string) {
  const digest = createHash("sha256")
    .update([prefix, actor.userId, actor.workspaceId, key].join("\n"))
    .digest("hex")
    .slice(0, 32);
  return `${prefix}_${digest}`;
}

function assertIdempotencyKey(value: string) {
  if (!/^[\x21-\x7e]{1,200}$/u.test(value)) {
    throw new ApiError(400, "invalid_request", "A valid Idempotency-Key is required.");
  }
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

async function privateAttachmentBoundary<T>(operation: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    logger.error("Private attachment operation failed", {
      event: "opencompany.chat_attachment_private_operation_failed",
      operation,
      error_name: error instanceof Error ? error.name : typeof error,
    });
    throw new ApiError(
      503,
      "unavailable",
      "Attachment storage is temporarily unavailable. Retry the upload.",
      true,
    );
  }
}
