import { randomUUID } from "node:crypto";
import {
  chatScreenshotBlobPath,
  safeScreenshotFilename,
} from "@opencompany/agent/chat-screenshot-storage";
import {
  compareChatMessageOrder,
  type StoredChatMessage,
  toChatUiMessage,
} from "@opencompany/agent/chat-ui";
import type { Actor } from "@opencompany/core";
import {
  type ChatArtifactVersion,
  type ChatMessageAttachment,
  chatArtifacts,
  chatArtifactVersions,
  chatMessages,
  chatSessions,
  chatShares,
  codexChatSessions,
  tasks,
} from "@opencompany/db/product-schema";
import { createLogger } from "@opencompany/observability";
import {
  PublicChatMessageSchema,
  type PublicChatShareDto,
  type PublicChatShareMetadataDto,
} from "@opencompany/protocol";
import { del, get } from "@vercel/blob";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
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
  listArtifactVersions(
    actor: Actor,
    artifactId: string,
  ): Promise<{
    artifactId: string;
    currentVersion: number;
    versions: Array<{
      artifactVersionId: string;
      version: number;
      title: string;
      description?: string;
      filename: string;
      mediaType: string;
      sizeBytes: number;
      createdAt: string;
    }>;
  }>;
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
        .select({ id: chatShares.id })
        .from(chatShares)
        .where(eq(chatShares.chatSessionId, sessionId))
        .limit(1);
      return share?.id ?? null;
    },

    async ensureShare(actor, conversationId) {
      const sessionId = await authorizeShareableConversation(input.db, actor, conversationId);
      await input.db
        .insert(chatShares)
        .values({ id: id(), chatSessionId: sessionId })
        .onConflictDoNothing({ target: chatShares.chatSessionId });
      const [share] = await input.db
        .select({ id: chatShares.id })
        .from(chatShares)
        .where(eq(chatShares.chatSessionId, sessionId))
        .limit(1);
      if (!share) throw new ApiError(500, "internal_error", "The Chat share could not be created.");
      return share.id;
    },

    async revokeShare(actor, conversationId) {
      const sessionId = await authorizeShareableConversation(input.db, actor, conversationId);
      await input.db.delete(chatShares).where(eq(chatShares.chatSessionId, sessionId));
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
          id: chatArtifacts.id,
          chatSessionId: chatArtifacts.chatSessionId,
          archivedAt: chatArtifacts.archivedAt,
        })
        .from(chatArtifacts)
        .where(
          and(
            eq(chatArtifacts.id, artifactId),
            eq(chatArtifacts.userWorkosId, actor.userId),
            eq(chatArtifacts.workspaceId, actor.workspaceId),
          ),
        )
        .limit(1);
      if (!artifact) throw notFound("Chat artifact not found.");
      if (artifact.archivedAt) return;

      const deletedAt = now();
      await input.db
        .update(chatArtifacts)
        .set({ archivedAt: deletedAt, updatedAt: deletedAt })
        .where(
          and(
            eq(chatArtifacts.id, artifact.id),
            eq(chatArtifacts.userWorkosId, actor.userId),
            eq(chatArtifacts.workspaceId, actor.workspaceId),
          ),
        );
      const versions = await input.db
        .select({ blobPathname: chatArtifactVersions.blobPathname })
        .from(chatArtifactVersions)
        .where(eq(chatArtifactVersions.artifactId, artifact.id));
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

    async listArtifactVersions(actor, artifactId) {
      const [artifact] = await input.db
        .select({ id: chatArtifacts.id, currentVersion: chatArtifacts.currentVersion })
        .from(chatArtifacts)
        .where(
          and(
            eq(chatArtifacts.id, artifactId),
            eq(chatArtifacts.userWorkosId, actor.userId),
            eq(chatArtifacts.workspaceId, actor.workspaceId),
            isNull(chatArtifacts.archivedAt),
          ),
        )
        .limit(1);
      if (!artifact || artifact.currentVersion < 1) throw notFound("Chat artifact not found.");
      const versions = await input.db
        .select({
          artifactVersionId: chatArtifactVersions.id,
          version: chatArtifactVersions.version,
          title: chatArtifactVersions.title,
          description: chatArtifactVersions.description,
          filename: chatArtifactVersions.filename,
          mediaType: chatArtifactVersions.mediaType,
          sizeBytes: chatArtifactVersions.sizeBytes,
          createdAt: chatArtifactVersions.createdAt,
        })
        .from(chatArtifactVersions)
        .where(eq(chatArtifactVersions.artifactId, artifact.id))
        .orderBy(desc(chatArtifactVersions.version));
      return {
        artifactId: artifact.id,
        currentVersion: artifact.currentVersion,
        versions: versions.map(
          (version: {
            artifactVersionId: string;
            version: number;
            title: string;
            description: string | null;
            filename: string;
            mediaType: string;
            sizeBytes: number;
            createdAt: Date;
          }) => ({
            artifactVersionId: version.artifactVersionId,
            version: version.version,
            title: version.title,
            ...(version.description ? { description: version.description } : {}),
            filename: version.filename,
            mediaType: version.mediaType,
            sizeBytes: version.sizeBytes,
            createdAt: version.createdAt.toISOString(),
          }),
        ),
      };
    },

    async downloadArtifact(command) {
      const [row] = await input.db
        .select({ version: chatArtifactVersions })
        .from(chatArtifactVersions)
        .innerJoin(chatArtifacts, eq(chatArtifactVersions.artifactId, chatArtifacts.id))
        .where(
          and(
            eq(chatArtifacts.id, command.artifactId),
            eq(chatArtifactVersions.id, command.versionId),
            eq(chatArtifacts.userWorkosId, command.actor.userId),
            eq(chatArtifacts.workspaceId, command.actor.workspaceId),
            isNull(chatArtifacts.archivedAt),
          ),
        )
        .limit(1);
      if (!row) throw notFound("Chat artifact version not found.");
      return artifactDownload(storage, row.version, command.download);
    },

    async downloadAttachment(command) {
      const [row] = await input.db
        .select({ attachments: chatMessages.attachments })
        .from(chatMessages)
        .innerJoin(chatSessions, eq(chatMessages.sessionId, chatSessions.id))
        .leftJoin(tasks, eq(tasks.sessionId, chatSessions.id))
        .leftJoin(codexChatSessions, eq(codexChatSessions.chatSessionId, chatSessions.id))
        .where(
          and(eq(chatMessages.id, command.messageId), conversationAccessCondition(command.actor)),
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
        .select({ id: chatSessions.id, userWorkosId: chatSessions.userWorkosId })
        .from(chatSessions)
        .leftJoin(tasks, eq(tasks.sessionId, chatSessions.id))
        .leftJoin(codexChatSessions, eq(codexChatSessions.chatSessionId, chatSessions.id))
        .where(
          and(
            eq(chatSessions.id, command.conversationId),
            conversationAccessCondition(command.actor),
          ),
        )
        .limit(1);
      if (!session) throw notFound("Chat screenshot not found.");
      const stream = await storage.get(
        chatScreenshotBlobPath({
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
        .select({ attachments: chatMessages.attachments })
        .from(chatMessages)
        .innerJoin(chatShares, eq(chatMessages.sessionId, chatShares.chatSessionId))
        .where(and(eq(chatShares.id, command.shareId), eq(chatMessages.id, command.messageId)))
        .limit(1);
      const attachment = findAttachment(row?.attachments, command.attachmentId);
      if (!attachment) throw notFound("Shared Chat attachment not found.");
      return attachmentDownload(storage, attachment);
    },

    async downloadPublicArtifact(command) {
      const [row] = await input.db
        .select({ version: chatArtifactVersions })
        .from(chatArtifactVersions)
        .innerJoin(chatArtifacts, eq(chatArtifactVersions.artifactId, chatArtifacts.id))
        .innerJoin(chatShares, eq(chatArtifacts.chatSessionId, chatShares.chatSessionId))
        .where(
          and(
            eq(chatShares.id, command.shareId),
            eq(chatArtifacts.id, command.artifactId),
            eq(chatArtifactVersions.id, command.versionId),
            isNull(chatArtifacts.archivedAt),
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
    .select({ id: chatSessions.id })
    .from(chatSessions)
    .leftJoin(tasks, eq(tasks.sessionId, chatSessions.id))
    .leftJoin(codexChatSessions, eq(codexChatSessions.chatSessionId, chatSessions.id))
    .where(
      and(
        eq(chatSessions.id, conversationId),
        inArray(chatSessions.kind, SHAREABLE_SESSION_KINDS),
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
      ${chatSessions.userWorkosId} = ${actor.userId}
      OR (
        ${chatSessions.kind} = 'task'
        AND ${tasks.workspaceId} = ${actor.workspaceId}
      )
    )`,
    or(
      isNull(codexChatSessions.id),
      isNull(codexChatSessions.workspaceId),
      eq(codexChatSessions.workspaceId, actor.workspaceId),
    ),
  );
}

async function findPublicShare(
  db: ChatResourceDb,
  shareId: string,
): Promise<PublicChatShareMetadataDto & { conversationId: string }> {
  const [row] = await db
    .select({
      shareId: chatShares.id,
      conversationId: chatSessions.id,
      title: sql<string>`CASE
        WHEN ${chatSessions.kind} = 'task'
        THEN COALESCE(NULLIF(${tasks.name}, ''), ${chatSessions.title})
        ELSE ${chatSessions.title}
      END`,
      kind: chatSessions.kind,
      engine: chatSessions.engine,
    })
    .from(chatShares)
    .innerJoin(chatSessions, eq(chatShares.chatSessionId, chatSessions.id))
    .leftJoin(tasks, eq(tasks.sessionId, chatSessions.id))
    .where(and(eq(chatShares.id, shareId), inArray(chatSessions.kind, SHAREABLE_SESSION_KINDS)))
    .limit(1);
  if (!row) throw notFound("Chat share not found.");
  return row;
}

async function listStoredMessages(db: ChatResourceDb, conversationId: string) {
  const messages: StoredChatMessage[] = await db
    .select({
      id: chatMessages.id,
      sessionId: chatMessages.sessionId,
      role: chatMessages.role,
      content: chatMessages.content,
      taskId: chatMessages.taskId,
      debugTrace: chatMessages.debugTrace,
      attachments: chatMessages.attachments,
      attachmentTexts: chatMessages.attachmentTexts,
      createdAt: chatMessages.createdAt,
      updatedAt: chatMessages.updatedAt,
      taskDisplayId: tasks.displayId,
      taskName: tasks.name,
      taskPrompt: tasks.prompt,
      taskStatus: tasks.status,
    })
    .from(chatMessages)
    .leftJoin(tasks, eq(chatMessages.taskId, tasks.id))
    .where(eq(chatMessages.sessionId, conversationId))
    .orderBy(asc(chatMessages.createdAt));
  return messages.toSorted(compareChatMessageOrder);
}

function toPublicChatMessage(message: StoredChatMessage) {
  const uiMessage = toChatUiMessage(message);
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
  attachments: readonly ChatMessageAttachment[] | null | undefined,
  attachmentId: string,
) {
  return attachments?.find((attachment) => attachment.id === attachmentId) ?? null;
}

async function artifactDownload(
  storage: ChatResourceStorage,
  version: Pick<ChatArtifactVersion, "blobPathname" | "filename" | "mediaType" | "sizeBytes">,
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
  attachment: ChatMessageAttachment,
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
