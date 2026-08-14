import { randomUUID } from "node:crypto";
import type { Actor } from "@opencompany/core";
import {
  type GoatChatArtifactVersion,
  type GoatChatMessageAttachment,
  goatChatArtifacts,
  goatChatArtifactVersions,
  goatChatMessages,
  goatChatSessions,
  goatChatShares,
  goatCodexChatSessions,
  goatTasks,
} from "@opencompany/db/goat-schema";
import {
  goatChatScreenshotBlobPath,
  safeScreenshotFilename,
} from "@opencompany/goat-agent/chat-screenshot-storage";
import {
  compareGoatChatMessageOrder,
  type GoatStoredChatMessage,
  toGoatChatUiMessage,
} from "@opencompany/goat-agent/chat-ui";
import { createLogger } from "@opencompany/observability";
import {
  PublicChatMessageSchema,
  type PublicChatShareDto,
  type PublicChatShareMetadataDto,
} from "@opencompany/protocol";
import { del, get } from "@vercel/blob";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { ApiError } from "./errors";

const SHAREABLE_SESSION_KINDS = ["chat", "task"] as const;
const INLINE_MEDIA_TYPES = new Set([
  "application/json",
  "application/pdf",
  "application/x-subrip",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/csv",
  "text/markdown",
  "text/plain",
  "text/tab-separated-values",
]);

const logger = createLogger({ service: "opencompany-api", runtime: "chat-resources" });

type ChatResourceDb = any;

export type ChatResourceDownload = {
  stream: ReadableStream<Uint8Array>;
  mediaType: string;
  filename: string;
  sizeBytes: number | null;
  inline: boolean;
  cacheControl: string;
  sandbox: boolean;
};

export type ChatResourceService = {
  findShare(actor: Actor, conversationId: string): Promise<string | null>;
  ensureShare(actor: Actor, conversationId: string): Promise<string>;
  revokeShare(actor: Actor, conversationId: string): Promise<void>;
  loadPublicShare(shareId: string): Promise<PublicChatShareDto>;
  loadPublicShareMetadata(shareId: string): Promise<PublicChatShareMetadataDto>;
  deleteArtifact(actor: Actor, artifactId: string): Promise<void>;
  downloadArtifact(input: {
    actor: Actor;
    artifactId: string;
    versionId: string;
    download: boolean;
  }): Promise<ChatResourceDownload>;
  downloadAttachment(input: {
    actor: Actor;
    messageId: string;
    attachmentId: string;
  }): Promise<ChatResourceDownload>;
  downloadScreenshot(input: {
    actor: Actor;
    conversationId: string;
    filename: string;
  }): Promise<ChatResourceDownload>;
  downloadPublicAttachment(input: {
    shareId: string;
    messageId: string;
    attachmentId: string;
  }): Promise<ChatResourceDownload>;
  downloadPublicArtifact(input: {
    shareId: string;
    artifactId: string;
    versionId: string;
    download: boolean;
  }): Promise<ChatResourceDownload>;
};

export type ChatResourceStorage = {
  get(pathname: string): Promise<ReadableStream<Uint8Array> | null>;
  delete(pathnames: readonly string[]): Promise<void>;
};

export function createChatResourceService(input: {
  db: ChatResourceDb;
  storage?: ChatResourceStorage;
  id?: () => string;
  now?: () => Date;
}): ChatResourceService {
  const storage = input.storage ?? vercelBlobStorage();
  const id = input.id ?? (() => `goat_chat_share_${randomUUID()}`);
  const now = input.now ?? (() => new Date());

  return {
    async findShare(actor, conversationId) {
      const sessionId = await authorizeShareableConversation(input.db, actor, conversationId);
      const [share] = await input.db
        .select({ id: goatChatShares.id })
        .from(goatChatShares)
        .where(eq(goatChatShares.chatSessionId, sessionId))
        .limit(1);
      return share?.id ?? null;
    },

    async ensureShare(actor, conversationId) {
      const sessionId = await authorizeShareableConversation(input.db, actor, conversationId);
      await input.db
        .insert(goatChatShares)
        .values({ id: id(), chatSessionId: sessionId })
        .onConflictDoNothing({ target: goatChatShares.chatSessionId });
      const [share] = await input.db
        .select({ id: goatChatShares.id })
        .from(goatChatShares)
        .where(eq(goatChatShares.chatSessionId, sessionId))
        .limit(1);
      if (!share) throw new ApiError(500, "internal_error", "The Chat share could not be created.");
      return share.id;
    },

    async revokeShare(actor, conversationId) {
      const sessionId = await authorizeShareableConversation(input.db, actor, conversationId);
      await input.db.delete(goatChatShares).where(eq(goatChatShares.chatSessionId, sessionId));
    },

    async loadPublicShare(shareId) {
      const shared = await findPublicShare(input.db, shareId);
      const messages = await listStoredMessages(input.db, shared.conversationId);
      const { conversationId: _conversationId, ...view } = shared;
      return {
        ...view,
        messages: messages.map(toPublicChatMessage),
      };
    },

    async loadPublicShareMetadata(shareId) {
      const { conversationId: _conversationId, ...view } = await findPublicShare(input.db, shareId);
      return view;
    },

    async deleteArtifact(actor, artifactId) {
      const [artifact] = await input.db
        .select({
          id: goatChatArtifacts.id,
          chatSessionId: goatChatArtifacts.chatSessionId,
          archivedAt: goatChatArtifacts.archivedAt,
        })
        .from(goatChatArtifacts)
        .where(
          and(
            eq(goatChatArtifacts.id, artifactId),
            eq(goatChatArtifacts.userWorkosId, actor.userId),
            eq(goatChatArtifacts.workspaceId, actor.workspaceId),
          ),
        )
        .limit(1);
      if (!artifact) throw notFound("Chat artifact not found.");
      if (artifact.archivedAt) return;

      const deletedAt = now();
      await input.db
        .update(goatChatArtifacts)
        .set({ archivedAt: deletedAt, updatedAt: deletedAt })
        .where(
          and(
            eq(goatChatArtifacts.id, artifact.id),
            eq(goatChatArtifacts.userWorkosId, actor.userId),
            eq(goatChatArtifacts.workspaceId, actor.workspaceId),
          ),
        );
      const versions = await input.db
        .select({ blobPathname: goatChatArtifactVersions.blobPathname })
        .from(goatChatArtifactVersions)
        .where(eq(goatChatArtifactVersions.artifactId, artifact.id));
      await input.db.execute(sql`
        UPDATE goat.chat_messages AS message
        SET debug_trace = jsonb_set(
              message.debug_trace,
              '{uiMessageParts}',
              COALESCE((
                SELECT jsonb_agg(
                  CASE
                    WHEN part.value->>'type' = 'data-artifact-file'
                      AND part.value#>>'{data,artifactId}' = ${artifact.id}
                    THEN jsonb_set(part.value, '{data,state}', '"deleted"'::jsonb, true)
                    ELSE part.value
                  END
                  ORDER BY part.ordinality
                )
                FROM jsonb_array_elements(
                  COALESCE(message.debug_trace->'uiMessageParts', '[]'::jsonb)
                ) WITH ORDINALITY AS part(value, ordinality)
              ), '[]'::jsonb),
              true
            ),
            updated_at = ${deletedAt}
        WHERE message.session_id = ${artifact.chatSessionId}
          AND message.debug_trace IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(
              COALESCE(message.debug_trace->'uiMessageParts', '[]'::jsonb)
            ) AS candidate(value)
            WHERE candidate.value->>'type' = 'data-artifact-file'
              AND candidate.value#>>'{data,artifactId}' = ${artifact.id}
          )
      `);

      const pathnames = versions.map((version: { blobPathname: string }) => version.blobPathname);
      if (pathnames.length > 0) {
        await storage.delete(pathnames).catch((error) => {
          logger.warn("Failed to remove archived Chat artifact blobs", {
            event: "opencompany.chat_artifact_blob_delete_failed",
            artifact_id: artifact.id,
            error_name: error instanceof Error ? error.name : typeof error,
          });
        });
      }
      logger.info("Generated Chat artifact deleted", {
        event: "opencompany.chat_artifact_deleted",
        artifact_id: artifact.id,
        version_count: pathnames.length,
      });
    },

    async downloadArtifact(command) {
      const [row] = await input.db
        .select({ version: goatChatArtifactVersions })
        .from(goatChatArtifactVersions)
        .innerJoin(goatChatArtifacts, eq(goatChatArtifactVersions.artifactId, goatChatArtifacts.id))
        .where(
          and(
            eq(goatChatArtifacts.id, command.artifactId),
            eq(goatChatArtifactVersions.id, command.versionId),
            eq(goatChatArtifacts.userWorkosId, command.actor.userId),
            eq(goatChatArtifacts.workspaceId, command.actor.workspaceId),
            isNull(goatChatArtifacts.archivedAt),
          ),
        )
        .limit(1);
      if (!row) throw notFound("Chat artifact version not found.");
      return artifactDownload(storage, row.version, command.download);
    },

    async downloadAttachment(command) {
      const [row] = await input.db
        .select({ attachments: goatChatMessages.attachments })
        .from(goatChatMessages)
        .innerJoin(goatChatSessions, eq(goatChatMessages.sessionId, goatChatSessions.id))
        .leftJoin(goatTasks, eq(goatTasks.sessionId, goatChatSessions.id))
        .leftJoin(
          goatCodexChatSessions,
          eq(goatCodexChatSessions.chatSessionId, goatChatSessions.id),
        )
        .where(
          and(
            eq(goatChatMessages.id, command.messageId),
            conversationAccessCondition(command.actor),
          ),
        )
        .limit(1);
      const attachment = findAttachment(row?.attachments, command.attachmentId);
      if (!attachment) throw notFound("Chat attachment not found.");
      return attachmentDownload(storage, attachment);
    },

    async downloadScreenshot(command) {
      let filename: string;
      try {
        filename = safeScreenshotFilename(command.filename);
      } catch {
        throw notFound("Chat screenshot not found.");
      }
      const [session] = await input.db
        .select({ id: goatChatSessions.id, userWorkosId: goatChatSessions.userWorkosId })
        .from(goatChatSessions)
        .leftJoin(goatTasks, eq(goatTasks.sessionId, goatChatSessions.id))
        .leftJoin(
          goatCodexChatSessions,
          eq(goatCodexChatSessions.chatSessionId, goatChatSessions.id),
        )
        .where(
          and(
            eq(goatChatSessions.id, command.conversationId),
            conversationAccessCondition(command.actor),
          ),
        )
        .limit(1);
      if (!session) throw notFound("Chat screenshot not found.");
      const stream = await storage.get(
        goatChatScreenshotBlobPath({
          userWorkosId: session.userWorkosId,
          chatSessionId: session.id,
          filename,
        }),
      );
      if (!stream) throw notFound("Chat screenshot not found.");
      return {
        stream,
        mediaType: "image/png",
        filename,
        sizeBytes: null,
        inline: true,
        cacheControl: "private, max-age=86400, immutable",
        sandbox: false,
      };
    },

    async downloadPublicAttachment(command) {
      const [row] = await input.db
        .select({ attachments: goatChatMessages.attachments })
        .from(goatChatMessages)
        .innerJoin(goatChatShares, eq(goatChatMessages.sessionId, goatChatShares.chatSessionId))
        .where(
          and(eq(goatChatShares.id, command.shareId), eq(goatChatMessages.id, command.messageId)),
        )
        .limit(1);
      const attachment = findAttachment(row?.attachments, command.attachmentId);
      if (!attachment) throw notFound("Shared Chat attachment not found.");
      return attachmentDownload(storage, attachment);
    },

    async downloadPublicArtifact(command) {
      const [row] = await input.db
        .select({ version: goatChatArtifactVersions })
        .from(goatChatArtifactVersions)
        .innerJoin(goatChatArtifacts, eq(goatChatArtifactVersions.artifactId, goatChatArtifacts.id))
        .innerJoin(
          goatChatShares,
          eq(goatChatArtifacts.chatSessionId, goatChatShares.chatSessionId),
        )
        .where(
          and(
            eq(goatChatShares.id, command.shareId),
            eq(goatChatArtifacts.id, command.artifactId),
            eq(goatChatArtifactVersions.id, command.versionId),
            isNull(goatChatArtifacts.archivedAt),
          ),
        )
        .limit(1);
      if (!row) throw notFound("Shared Chat artifact version not found.");
      return artifactDownload(storage, row.version, command.download);
    },
  };
}

async function authorizeShareableConversation(
  db: ChatResourceDb,
  actor: Actor,
  conversationId: string,
) {
  const [session] = await db
    .select({ id: goatChatSessions.id })
    .from(goatChatSessions)
    .leftJoin(goatTasks, eq(goatTasks.sessionId, goatChatSessions.id))
    .leftJoin(goatCodexChatSessions, eq(goatCodexChatSessions.chatSessionId, goatChatSessions.id))
    .where(
      and(
        eq(goatChatSessions.id, conversationId),
        inArray(goatChatSessions.kind, SHAREABLE_SESSION_KINDS),
        conversationAccessCondition(actor),
      ),
    )
    .limit(1);
  if (!session) throw notFound("Conversation not found.");
  return session.id;
}

function conversationAccessCondition(actor: Actor) {
  return and(
    sql`(
      ${goatChatSessions.userWorkosId} = ${actor.userId}
      OR (
        ${goatChatSessions.kind} = 'task'
        AND ${goatTasks.workspaceId} = ${actor.workspaceId}
      )
    )`,
    or(
      isNull(goatCodexChatSessions.id),
      isNull(goatCodexChatSessions.workspaceId),
      eq(goatCodexChatSessions.workspaceId, actor.workspaceId),
    ),
  );
}

async function findPublicShare(
  db: ChatResourceDb,
  shareId: string,
): Promise<PublicChatShareMetadataDto & { conversationId: string }> {
  const [row] = await db
    .select({
      shareId: goatChatShares.id,
      conversationId: goatChatSessions.id,
      title: sql<string>`CASE
        WHEN ${goatChatSessions.kind} = 'task'
        THEN COALESCE(NULLIF(${goatTasks.name}, ''), ${goatChatSessions.title})
        ELSE ${goatChatSessions.title}
      END`,
      kind: goatChatSessions.kind,
      engine: goatChatSessions.engine,
    })
    .from(goatChatShares)
    .innerJoin(goatChatSessions, eq(goatChatShares.chatSessionId, goatChatSessions.id))
    .leftJoin(goatTasks, eq(goatTasks.sessionId, goatChatSessions.id))
    .where(
      and(eq(goatChatShares.id, shareId), inArray(goatChatSessions.kind, SHAREABLE_SESSION_KINDS)),
    )
    .limit(1);
  if (!row) throw notFound("Chat share not found.");
  return row;
}

async function listStoredMessages(db: ChatResourceDb, conversationId: string) {
  const messages: GoatStoredChatMessage[] = await db
    .select({
      id: goatChatMessages.id,
      sessionId: goatChatMessages.sessionId,
      role: goatChatMessages.role,
      content: goatChatMessages.content,
      taskId: goatChatMessages.taskId,
      debugTrace: goatChatMessages.debugTrace,
      attachments: goatChatMessages.attachments,
      attachmentTexts: goatChatMessages.attachmentTexts,
      createdAt: goatChatMessages.createdAt,
      updatedAt: goatChatMessages.updatedAt,
      taskDisplayId: goatTasks.displayId,
      taskName: goatTasks.name,
      taskPrompt: goatTasks.prompt,
      taskStatus: goatTasks.status,
    })
    .from(goatChatMessages)
    .leftJoin(goatTasks, eq(goatChatMessages.taskId, goatTasks.id))
    .where(eq(goatChatMessages.sessionId, conversationId))
    .orderBy(asc(goatChatMessages.createdAt));
  return messages.toSorted(compareGoatChatMessageOrder);
}

function toPublicChatMessage(message: GoatStoredChatMessage) {
  const uiMessage = toGoatChatUiMessage(message);
  if (uiMessage.metadata) {
    const metadata = { ...uiMessage.metadata };
    delete metadata.sessionId;
    delete metadata.contextTokens;
    const durationMs = metadata.timing?.durationMs;
    if (typeof durationMs === "number") metadata.timing = { durationMs };
    else delete metadata.timing;
    if (Object.keys(metadata).length === 0) delete uiMessage.metadata;
    else uiMessage.metadata = metadata;
  }
  return PublicChatMessageSchema.parse(uiMessage);
}

function findAttachment(
  attachments: readonly GoatChatMessageAttachment[] | null | undefined,
  attachmentId: string,
) {
  return attachments?.find((attachment) => attachment.id === attachmentId) ?? null;
}

async function artifactDownload(
  storage: ChatResourceStorage,
  version: Pick<GoatChatArtifactVersion, "blobPathname" | "filename" | "mediaType" | "sizeBytes">,
  download: boolean,
): Promise<ChatResourceDownload> {
  const stream = await storage.get(version.blobPathname);
  if (!stream) throw notFound("Chat artifact bytes not found.");
  const inline = !download && INLINE_MEDIA_TYPES.has(version.mediaType);
  return {
    stream,
    mediaType: version.mediaType || "application/octet-stream",
    filename: version.filename,
    sizeBytes: version.sizeBytes,
    inline,
    cacheControl: "private, no-store",
    sandbox: inline,
  };
}

async function attachmentDownload(
  storage: ChatResourceStorage,
  attachment: GoatChatMessageAttachment,
): Promise<ChatResourceDownload> {
  const stream = await storage.get(attachment.blobUrl);
  if (!stream) throw notFound("Chat attachment bytes not found.");
  return {
    stream,
    mediaType: attachment.mediaType || "application/octet-stream",
    filename: attachment.filename,
    sizeBytes: attachment.sizeBytes,
    inline: true,
    cacheControl: "private, max-age=86400, immutable",
    sandbox: false,
  };
}

function vercelBlobStorage(): ChatResourceStorage {
  return {
    async get(pathname) {
      const result = await get(pathname, { access: "private", useCache: false });
      return result?.statusCode === 200 ? (result.stream ?? null) : null;
    },
    async delete(pathnames) {
      await del([...pathnames]);
    },
  };
}

function notFound(message: string) {
  return new ApiError(404, "not_found", message);
}
