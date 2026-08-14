import { createHash } from "node:crypto";
import {
  BRAIN_ASSET_MAX_BYTES,
  brainAssetUploadPrefix,
  createBrainAssetForUser,
  replaceBrainAssetForUser,
  validateBrainAssetFile,
  validateBrainAssetFolderPath,
} from "@opencompany/agent/brain-assets";
import { type BrainDocumentView, documentViewFromFileRow } from "@opencompany/agent/brain-files";
import type { Actor, BrainDocument, KnowledgeApplicationService } from "@opencompany/core";
import { getBrainFile, getBrainFileById } from "@opencompany/db/brain-files";
import {
  type BrainDocument as BrainDocumentRow,
  type KnowledgeCommandOperation,
  knowledgeCommandIdempotency,
} from "@opencompany/db/product-schema";
import { createLogger } from "@opencompany/observability";
import { del, get, put } from "@vercel/blob";
import { and, eq } from "drizzle-orm";
import { ApiError } from "./errors";

const MAX_FILENAME_LENGTH = 200;
const logger = createLogger({ service: "opencompany-api", runtime: "brain-assets" });

export type BrainAssetStorage = {
  put(input: { pathname: string; bytes: Buffer; mediaType: string }): Promise<{ url: string }>;
  get(input: { url: string }): Promise<{
    statusCode: number;
    stream: ReadableStream<Uint8Array> | null;
  } | null>;
  delete(input: { url: string }): Promise<void>;
};

export type BrainAssetMutation = {
  document: BrainDocument;
  quotaPaused: boolean;
  replayed: boolean;
};

export type BrainAssetDownload = {
  stream: ReadableStream<Uint8Array>;
  mediaType: string;
  filename: string;
  sizeBytes: number | null;
};

export type BrainAssetService = {
  upload(input: {
    actor: Actor;
    brainId: string;
    folderPath: string;
    idempotencyKey: string;
    file: File;
  }): Promise<BrainAssetMutation>;
  replace(input: {
    actor: Actor;
    brainId: string;
    documentId: string;
    idempotencyKey: string;
    file: File;
  }): Promise<BrainAssetMutation>;
  download(input: { actor: Actor; documentId: string }): Promise<BrainAssetDownload>;
};

export function createBrainAssetService(input: {
  db: any;
  knowledge: KnowledgeApplicationService;
  storage?: BrainAssetStorage;
}): BrainAssetService {
  const storage = input.storage ?? vercelBlobStorage();

  return {
    async upload(command) {
      const brainId = await input.knowledge.authorizeBrainWrite(command.actor, command.brainId);
      const folderPath = validFolderPath(command.folderPath);
      const file = await validatedFile(command.file);
      const idempotencyKey = validIdempotencyKey(command.idempotencyKey);
      const request = {
        brainId,
        folderPath,
        filename: file.filename,
        mediaType: file.mediaType,
        sizeBytes: file.bytes.byteLength,
        contentSha256: file.contentSha256,
      };
      const proposedDocumentId = deterministicResourceId(
        "goat_brain_doc",
        command.actor,
        idempotencyKey,
      );
      const reservation = await reserveCommand(input.db, {
        actor: command.actor,
        idempotencyKey,
        operation: "brain_asset.create",
        request,
        proposedResourceId: proposedDocumentId,
      });
      const existing = await getBrainFileById({ fileId: reservation.resourceId }, { db: input.db });
      if (existing && reservation.completed) return mutationFromRow(existing, true);
      if (existing) {
        if (!matchesAsset(existing, request)) throw idempotencyConflict();
        await completeCommand(input.db, reservation.commandId);
        return mutationFromRow(existing, true);
      }
      if (reservation.completed) {
        throw new ApiError(409, "conflict", "The uploaded Brain asset no longer exists.");
      }

      const stored = await storage.put({
        pathname: `${brainAssetUploadPrefix(brainId)}${reservation.commandId}/${safePathSegment(file.filename)}`,
        bytes: file.bytes,
        mediaType: file.mediaType,
      });
      let result: Awaited<ReturnType<typeof createBrainAssetForUser>>;
      try {
        result = await input.db.transaction((tx: any) =>
          createBrainAssetForUser(
            {
              brainRef: brainId,
              userWorkosId: command.actor.userId,
              folderPath,
              blobUrl: stored.url,
              originalFileName: file.filename,
              mimeType: file.mediaType,
              sizeBytes: file.bytes.byteLength,
              contentSha256: file.contentSha256,
            },
            { db: tx, documentId: reservation.resourceId },
          ),
        );
        if (!result.ok || !result.document) {
          throw new ApiError(
            400,
            "invalid_request",
            result.ok ? "The Brain asset could not be created." : result.message,
          );
        }
      } catch (error) {
        const winner = await getBrainFileById({ fileId: reservation.resourceId }, { db: input.db });
        if (winner && matchesAsset(winner, request)) {
          if (winner.assetStorageKey !== stored.url) {
            await cleanupStoredAsset(storage, stored.url, "upload_race_loser");
          }
          await completeCommand(input.db, reservation.commandId);
          return mutationFromRow(winner, true);
        }
        await cleanupStoredAsset(storage, stored.url, "upload_rollback");
        throw error;
      }
      await completeCommand(input.db, reservation.commandId);
      return {
        document: canonicalDocument(result.document),
        quotaPaused: Boolean(result.quotaPaused),
        replayed: false,
      };
    },

    async replace(command) {
      const brainId = await input.knowledge.authorizeBrainWrite(command.actor, command.brainId);
      const current = await getBrainFile(
        { brainRef: brainId, fileId: command.documentId },
        { db: input.db },
      );
      if (!current || !current.assetStorageKey || current.format === "markdown") {
        throw new ApiError(404, "not_found", "Brain asset not found.");
      }
      const file = await validatedFile(command.file);
      const idempotencyKey = validIdempotencyKey(command.idempotencyKey);
      const request = {
        brainId,
        documentId: current.id,
        filename: file.filename,
        mediaType: file.mediaType,
        sizeBytes: file.bytes.byteLength,
        contentSha256: file.contentSha256,
      };
      const reservation = await reserveCommand(input.db, {
        actor: command.actor,
        idempotencyKey,
        operation: "brain_asset.replace",
        request,
        proposedResourceId: current.id,
        initialStateHash: assetStateHash(current.assetStorageKey),
      });
      const latest = await getBrainFile(
        { brainRef: brainId, fileId: current.id },
        { db: input.db },
      );
      if (!latest?.assetStorageKey || latest.format === "markdown") {
        throw new ApiError(404, "not_found", "Brain asset not found.");
      }
      const expectedStorageKey = latest.assetStorageKey;
      if (reservation.completed) return mutationFromRow(latest, true);
      if (matchesAsset(latest, request)) {
        await completeCommand(input.db, reservation.commandId);
        return mutationFromRow(latest, true);
      }
      if (assetStateHash(expectedStorageKey) !== reservation.initialStateHash) {
        throw new ApiError(409, "conflict", "The Brain asset changed after this command began.");
      }

      const stored = await storage.put({
        pathname: `${brainAssetUploadPrefix(brainId)}${reservation.commandId}/${safePathSegment(file.filename)}`,
        bytes: file.bytes,
        mediaType: file.mediaType,
      });
      let replacedStorageKey: string | null = null;
      let result: Awaited<ReturnType<typeof replaceBrainAssetForUser>>;
      try {
        result = await input.db.transaction((tx: any) =>
          replaceBrainAssetForUser(
            {
              brainRef: brainId,
              userWorkosId: command.actor.userId,
              documentId: latest.id,
              expectedAssetContentHash: latest.assetContentHash,
              expectedAssetStorageKey: expectedStorageKey,
              folderPath: latest.folderPath,
              blobUrl: stored.url,
              originalFileName: file.filename,
              mimeType: file.mediaType,
              sizeBytes: file.bytes.byteLength,
              contentSha256: file.contentSha256,
            },
            {
              db: tx,
              cleanupReplacedBlob: async (storageKey) => {
                replacedStorageKey = storageKey;
              },
            },
          ),
        );
        if (!result.ok || !result.document) {
          throw new ApiError(
            result.ok ? 500 : 400,
            result.ok ? "internal_error" : "invalid_request",
            result.ok ? "The Brain asset could not be replaced." : result.message,
          );
        }
      } catch (error) {
        const winner = await getBrainFile(
          { brainRef: brainId, fileId: latest.id },
          { db: input.db },
        );
        if (winner && matchesAsset(winner, request)) {
          if (winner.assetStorageKey !== stored.url) {
            await cleanupStoredAsset(storage, stored.url, "replace_race_loser");
          } else if (replacedStorageKey) {
            await cleanupStoredAsset(storage, replacedStorageKey, "replace_retention");
          }
          await completeCommand(input.db, reservation.commandId);
          return mutationFromRow(winner, true);
        }
        await cleanupStoredAsset(storage, stored.url, "replace_rollback");
        if (
          error instanceof ApiError &&
          error.status === 400 &&
          error.message === "Brain asset changed before its file could be replaced."
        ) {
          throw new ApiError(409, "conflict", error.message);
        }
        throw error;
      }
      if (replacedStorageKey) {
        await cleanupStoredAsset(storage, replacedStorageKey, "replace_retention");
      }
      await completeCommand(input.db, reservation.commandId);
      return {
        document: canonicalDocument(result.document),
        quotaPaused: Boolean(result.quotaPaused),
        replayed: false,
      };
    },

    async download(command) {
      const row = await getBrainFileById({ fileId: command.documentId }, { db: input.db });
      if (!row?.assetStorageKey) throw new ApiError(404, "not_found", "Brain asset not found.");
      await input.knowledge.authorizeBrainRead(command.actor, row.brainRef);
      const blob = await storage.get({ url: row.assetStorageKey });
      if (!blob || blob.statusCode !== 200 || !blob.stream) {
        throw new ApiError(404, "not_found", "Brain asset not found.");
      }
      return {
        stream: blob.stream,
        mediaType: safeMediaType(row.mimeType),
        filename: normalizedFilename(row.originalFileName ?? "file"),
        sizeBytes:
          Number.isSafeInteger(row.assetSizeBytes) && (row.assetSizeBytes ?? -1) >= 0
            ? row.assetSizeBytes
            : null,
      };
    },
  };
}

async function validatedFile(file: File) {
  const filename = normalizedFilename(file.name);
  const validation = validateBrainAssetFile({
    originalFileName: filename,
    mimeType: file.type,
    sizeBytes: file.size,
  });
  if (!validation.ok) throw new ApiError(400, "invalid_request", validation.message);
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.byteLength > BRAIN_ASSET_MAX_BYTES || bytes.byteLength !== file.size) {
    throw new ApiError(400, "invalid_request", "The uploaded file size is invalid.");
  }
  return {
    filename,
    mediaType: validation.mediaType,
    bytes,
    contentSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function validFolderPath(value: string) {
  const validation = validateBrainAssetFolderPath(value);
  if (!validation.ok) throw new ApiError(400, "invalid_request", validation.message);
  return validation.folderPath;
}

function validIdempotencyKey(value: string) {
  const key = value.trim();
  if (!key || key.length > 200 || /[^\x21-\x7e]/u.test(key)) {
    throw new ApiError(400, "invalid_request", "A valid Idempotency-Key is required.");
  }
  return key;
}

async function reserveCommand(
  db: any,
  input: {
    actor: Actor;
    idempotencyKey: string;
    operation: Extract<KnowledgeCommandOperation, "brain_asset.create" | "brain_asset.replace">;
    request: unknown;
    proposedResourceId: string;
    initialStateHash?: string;
  },
) {
  const commandId = deterministicResourceId(
    "goat_knowledge_command",
    input.actor,
    input.idempotencyKey,
  );
  const requestHash = commandHash(input.operation, input.request);
  const inserted = await db
    .insert(knowledgeCommandIdempotency)
    .values({
      commandId,
      userWorkosId: input.actor.userId,
      workspaceId: input.actor.workspaceId,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      operation: input.operation,
      resourceId: input.proposedResourceId,
      ...(input.initialStateHash ? { initialStateHash: input.initialStateHash } : {}),
    })
    .onConflictDoNothing()
    .returning({
      commandId: knowledgeCommandIdempotency.commandId,
      resourceId: knowledgeCommandIdempotency.resourceId,
      completedAt: knowledgeCommandIdempotency.completedAt,
      initialStateHash: knowledgeCommandIdempotency.initialStateHash,
    });
  const reservation =
    inserted[0] ??
    (
      await db
        .select({
          commandId: knowledgeCommandIdempotency.commandId,
          requestHash: knowledgeCommandIdempotency.requestHash,
          operation: knowledgeCommandIdempotency.operation,
          resourceId: knowledgeCommandIdempotency.resourceId,
          completedAt: knowledgeCommandIdempotency.completedAt,
          initialStateHash: knowledgeCommandIdempotency.initialStateHash,
        })
        .from(knowledgeCommandIdempotency)
        .where(
          and(
            eq(knowledgeCommandIdempotency.userWorkosId, input.actor.userId),
            eq(knowledgeCommandIdempotency.workspaceId, input.actor.workspaceId),
            eq(knowledgeCommandIdempotency.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1)
    )[0];
  if (!reservation) throw new ApiError(409, "conflict", "Could not reserve the command.");
  if (
    "requestHash" in reservation &&
    (reservation.requestHash !== requestHash || reservation.operation !== input.operation)
  ) {
    throw idempotencyConflict();
  }
  return {
    commandId: reservation.commandId,
    resourceId: reservation.resourceId,
    completed: Boolean(reservation.completedAt),
    initialStateHash: reservation.initialStateHash,
  };
}

async function completeCommand(db: any, commandId: string) {
  await db
    .update(knowledgeCommandIdempotency)
    .set({ completedAt: new Date(), touchedAt: new Date() })
    .where(eq(knowledgeCommandIdempotency.commandId, commandId));
}

function matchesAsset(
  row: BrainDocumentRow,
  request: {
    brainId: string;
    folderPath?: string;
    filename: string;
    mediaType: string;
    sizeBytes: number;
    contentSha256: string;
  },
) {
  return (
    row.brainRef === request.brainId &&
    (request.folderPath === undefined || row.folderPath === request.folderPath) &&
    row.originalFileName === request.filename &&
    row.mimeType === request.mediaType &&
    row.assetSizeBytes === request.sizeBytes &&
    row.assetContentHash === request.contentSha256
  );
}

function mutationFromRow(row: BrainDocumentRow, replayed: boolean): BrainAssetMutation {
  return {
    document: canonicalDocumentRow(row),
    quotaPaused: false,
    replayed,
  };
}

function canonicalDocument(document: BrainDocumentView): BrainDocument {
  return {
    id: document.id,
    brainId: document.brainId,
    folderPath: document.folderPath,
    path: document.path,
    title: document.title,
    ...(document.description ? { description: document.description } : {}),
    content: document.content,
    body: document.body,
    timeline: document.timeline,
    format: document.format,
    mimeType: document.mimeType,
    originalFileName: document.originalFileName ?? null,
    assetSizeBytes: document.assetSizeBytes ?? null,
    relations: document.relations,
    sources: document.sources,
    kind: document.kind,
    type: document.type,
    status: document.status,
    aliases: document.aliases,
    contentHash: document.contentHash,
    sizeBytes: document.sizeBytes,
    createdByActorId: document.createdByWorkosId ?? null,
    createdAt: new Date(document.createdAt),
    updatedAt: new Date(document.updatedAt),
  };
}

function canonicalDocumentRow(row: BrainDocumentRow) {
  return canonicalDocument(documentViewFromFileRow(row));
}

function normalizedFilename(value: string) {
  const filename = value
    .trim()
    .replaceAll(/[\u0000-\u001f\u007f]/gu, "")
    .slice(0, MAX_FILENAME_LENGTH);
  return filename || "upload";
}

function safeMediaType(value: string | null) {
  const mediaType = value?.trim().toLowerCase() ?? "";
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mediaType)
    ? mediaType
    : "application/octet-stream";
}

function safePathSegment(filename: string) {
  return filename.replaceAll(/[^a-zA-Z0-9._-]+/gu, "-").replaceAll(/^-+|-+$/gu, "") || "upload";
}

function deterministicResourceId(prefix: string, actor: Actor, key: string) {
  const digest = createHash("sha256")
    .update([prefix, actor.userId, actor.workspaceId, key].join("\n"))
    .digest("hex")
    .slice(0, 32);
  return `${prefix}_${digest}`;
}

function commandHash(operation: string, request: unknown) {
  return createHash("sha256").update(stableJson({ operation, request })).digest("hex");
}

function assetStateHash(storageKey: string) {
  return createHash("sha256").update(storageKey).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function idempotencyConflict() {
  return new ApiError(
    409,
    "idempotency_conflict",
    "The Idempotency-Key was already used for another command.",
  );
}

async function cleanupStoredAsset(storage: BrainAssetStorage, url: string, reason: string) {
  try {
    await storage.delete({ url });
  } catch (error) {
    logger.warn("Private Brain asset cleanup failed", {
      event: "opencompany.brain_asset_cleanup_failed",
      reason,
      error_name: error instanceof Error ? error.name : typeof error,
    });
  }
}

function vercelBlobStorage(): BrainAssetStorage {
  return {
    async put(input) {
      const stored = await put(input.pathname, input.bytes, {
        access: "private",
        addRandomSuffix: true,
        contentType: input.mediaType,
      });
      return { url: stored.url };
    },
    async get(input) {
      const result = await get(input.url, { access: "private", useCache: false });
      return result
        ? { statusCode: result.statusCode, stream: result.stream as ReadableStream<Uint8Array> }
        : null;
    },
    async delete(input) {
      await del(input.url);
    },
  };
}
