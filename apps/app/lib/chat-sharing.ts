import { randomUUID } from "node:crypto";
import { getDb } from "@opencompany/db/client";
import {
  type ChatSessionKind,
  type ChatShare,
  chatSessions,
  chatShares,
  tasks,
} from "@opencompany/db/schema";
import { and, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import { type ChatStore, createDbChatStore } from "@/lib/chat";
import {
  type ChatSessionView,
  type ChatUiMessage,
  type StoredChatMessage,
  toChatUiMessage,
} from "@/lib/chat-ui";

const CHAT_SHARE_ID_PATTERN =
  /^goat_chat_share_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHAREABLE_CHAT_SESSION_KINDS: ChatSessionKind[] = ["chat", "task"];

export type PublicChatView = Pick<ChatSessionView, "title" | "messages"> & {
  shareId: string;
  kind: ChatSessionKind;
  engine: ChatSessionView["engine"];
};

export type PublicChatMetadata = Pick<PublicChatView, "shareId" | "title" | "kind" | "engine">;

type PublicChatSessionRecord = Pick<ChatSessionView, "id" | "title"> & {
  kind: ChatSessionKind;
  engine: ChatSessionView["engine"];
};

export type ChatShareStore = {
  ensureShare(input: {
    id: string;
    userWorkosId: string;
    workspaceId?: string | null;
    chatSessionId: string;
  }): Promise<ChatShare | null>;
  findShareForUser(input: {
    userWorkosId: string;
    workspaceId?: string | null;
    chatSessionId: string;
  }): Promise<ChatShare | null>;
  revokeShare(input: {
    userWorkosId: string;
    workspaceId?: string | null;
    chatSessionId: string;
  }): Promise<boolean>;
  findShare(
    shareId: string,
  ): Promise<{ share: ChatShare; chatSession: PublicChatSessionRecord } | null>;
  listMessages(chatSessionId: string): Promise<StoredChatMessage[]>;
};

export function newChatShareId() {
  return `goat_chat_share_${randomUUID()}`;
}

export function isChatShareId(value: string) {
  return CHAT_SHARE_ID_PATTERN.test(value);
}

export async function ensureChatShareForUser(
  input: { userWorkosId: string; workspaceId?: string | null; chatSessionId: string },
  store: ChatShareStore = createDbChatShareStore(),
): Promise<ChatShare | null> {
  const chatSessionId = input.chatSessionId.trim();
  if (!chatSessionId) return null;

  return store.ensureShare({
    id: newChatShareId(),
    userWorkosId: input.userWorkosId,
    workspaceId: input.workspaceId ?? null,
    chatSessionId,
  });
}

export async function findChatShareForUser(
  input: { userWorkosId: string; workspaceId?: string | null; chatSessionId: string },
  store: ChatShareStore = createDbChatShareStore(),
): Promise<ChatShare | null> {
  const chatSessionId = input.chatSessionId.trim();
  if (!chatSessionId) return null;

  return store.findShareForUser({
    userWorkosId: input.userWorkosId,
    workspaceId: input.workspaceId ?? null,
    chatSessionId,
  });
}

export async function revokeChatShareForUser(
  input: { userWorkosId: string; workspaceId?: string | null; chatSessionId: string },
  store: ChatShareStore = createDbChatShareStore(),
): Promise<boolean> {
  const chatSessionId = input.chatSessionId.trim();
  if (!chatSessionId) return false;

  return store.revokeShare({
    userWorkosId: input.userWorkosId,
    workspaceId: input.workspaceId ?? null,
    chatSessionId,
  });
}

export async function loadPublicChat(
  shareIdInput: string,
  store: ChatShareStore = createDbChatShareStore(),
): Promise<PublicChatView | null> {
  const result = await findPublicChat(shareIdInput, store);
  if (!result) return null;

  const messages = await store.listMessages(result.chatSession.id);
  return {
    shareId: result.share.id,
    title: result.chatSession.title,
    kind: result.chatSession.kind,
    engine: result.chatSession.engine,
    messages: messages.map(toPublicChatUiMessage),
  };
}

export async function loadPublicChatMetadata(
  shareIdInput: string,
  store: ChatShareStore = createDbChatShareStore(),
): Promise<PublicChatMetadata | null> {
  const result = await findPublicChat(shareIdInput, store);
  if (!result) return null;

  return {
    shareId: result.share.id,
    title: result.chatSession.title,
    kind: result.chatSession.kind,
    engine: result.chatSession.engine,
  };
}

type ChatDb = ReturnType<typeof getDb>;

export function createDbChatShareStore(
  db: ChatDb = getDb(),
  chatStore: ChatStore = createDbChatStore(db),
): ChatShareStore {
  return {
    async ensureShare(input) {
      const [ownedSession] = await db
        .select({ id: chatSessions.id })
        .from(chatSessions)
        .leftJoin(tasks, eq(tasks.sessionId, chatSessions.id))
        .where(
          and(eq(chatSessions.id, input.chatSessionId), shareableChatSessionAccessCondition(input)),
        )
        .limit(1);
      if (!ownedSession) return null;

      await db
        .insert(chatShares)
        .values({ id: input.id, chatSessionId: ownedSession.id })
        .onConflictDoNothing({ target: chatShares.chatSessionId });

      const [share] = await db
        .select()
        .from(chatShares)
        .where(eq(chatShares.chatSessionId, ownedSession.id))
        .limit(1);
      return share ?? null;
    },

    async findShareForUser(input) {
      const [share] = await db
        .select({ share: chatShares })
        .from(chatShares)
        .innerJoin(chatSessions, eq(chatShares.chatSessionId, chatSessions.id))
        .leftJoin(tasks, eq(tasks.sessionId, chatSessions.id))
        .where(
          and(
            eq(chatShares.chatSessionId, input.chatSessionId),
            shareableChatSessionAccessCondition(input),
          ),
        )
        .limit(1);
      return share?.share ?? null;
    },

    async revokeShare(input) {
      const [ownedSession] = await db
        .select({ id: chatSessions.id })
        .from(chatSessions)
        .leftJoin(tasks, eq(tasks.sessionId, chatSessions.id))
        .where(
          and(eq(chatSessions.id, input.chatSessionId), shareableChatSessionAccessCondition(input)),
        )
        .limit(1);
      if (!ownedSession) return false;

      await db.delete(chatShares).where(eq(chatShares.chatSessionId, ownedSession.id));
      return true;
    },

    async findShare(shareId) {
      const [result] = await db
        .select({
          share: chatShares,
          chatSession: {
            id: chatSessions.id,
            title: sql<string>`CASE
              WHEN ${chatSessions.kind} = 'task'
              THEN COALESCE(NULLIF(${tasks.name}, ''), ${chatSessions.title})
              ELSE ${chatSessions.title}
            END`,
            kind: chatSessions.kind,
            engine: chatSessions.engine,
          },
        })
        .from(chatShares)
        .innerJoin(chatSessions, eq(chatShares.chatSessionId, chatSessions.id))
        .leftJoin(tasks, eq(tasks.sessionId, chatSessions.id))
        .where(
          and(eq(chatShares.id, shareId), inArray(chatSessions.kind, SHAREABLE_CHAT_SESSION_KINDS)),
        )
        .limit(1);
      return result ?? null;
    },

    listMessages(chatSessionId) {
      return chatStore.listMessages(chatSessionId);
    },
  };
}

async function findPublicChat(shareIdInput: string, store: ChatShareStore) {
  const shareId = shareIdInput.trim();
  if (!isChatShareId(shareId)) return null;
  return store.findShare(shareId);
}

function toPublicChatUiMessage(message: StoredChatMessage): ChatUiMessage {
  const uiMessage = toChatUiMessage(message);
  if (!uiMessage.metadata) return uiMessage;

  const metadata = { ...uiMessage.metadata };
  delete metadata.sessionId;
  delete metadata.contextTokens;
  const durationMs = metadata.timing?.durationMs;
  if (typeof durationMs === "number") {
    metadata.timing = { durationMs };
  } else {
    delete metadata.timing;
  }

  if (Object.keys(metadata).length === 0) {
    const publicMessage = { ...uiMessage };
    delete publicMessage.metadata;
    return publicMessage;
  }

  return {
    ...uiMessage,
    metadata,
  };
}

function shareableChatSessionAccessCondition(input: {
  userWorkosId: string;
  workspaceId?: string | null;
}): SQL {
  const ownedSession = and(
    eq(chatSessions.userWorkosId, input.userWorkosId),
    inArray(chatSessions.kind, SHAREABLE_CHAT_SESSION_KINDS),
  );
  const workspaceTaskSession = input.workspaceId?.trim()
    ? and(eq(chatSessions.kind, "task"), eq(tasks.workspaceId, input.workspaceId.trim()))
    : undefined;
  return (workspaceTaskSession ? or(ownedSession, workspaceTaskSession) : ownedSession) as SQL;
}
