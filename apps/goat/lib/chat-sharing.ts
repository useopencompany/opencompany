import { randomUUID } from "node:crypto";
import { getDb } from "@opencompany/db/client";
import {
  type GoatChatSessionKind,
  type GoatChatShare,
  goatChatSessions,
  goatChatShares,
  goatTasks,
} from "@opencompany/db/goat-schema";
import { and, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import { createDbGoatChatStore, type GoatChatStore } from "@/lib/chat";
import {
  type GoatChatSessionView,
  type GoatChatUiMessage,
  type GoatStoredChatMessage,
  toGoatChatUiMessage,
} from "@/lib/chat-ui";

const GOAT_CHAT_SHARE_ID_PATTERN =
  /^goat_chat_share_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHAREABLE_GOAT_CHAT_SESSION_KINDS: GoatChatSessionKind[] = ["chat", "task"];

export type PublicGoatChatView = Pick<GoatChatSessionView, "title" | "messages"> & {
  shareId: string;
  kind: GoatChatSessionKind;
};

export type PublicGoatChatMetadata = Pick<PublicGoatChatView, "shareId" | "title" | "kind">;

type PublicGoatChatSessionRecord = Pick<GoatChatSessionView, "id" | "title"> & {
  kind: GoatChatSessionKind;
};

export type GoatChatShareStore = {
  ensureShare(input: {
    id: string;
    userWorkosId: string;
    workspaceId?: string | null;
    chatSessionId: string;
  }): Promise<GoatChatShare | null>;
  findShareForUser(input: {
    userWorkosId: string;
    workspaceId?: string | null;
    chatSessionId: string;
  }): Promise<GoatChatShare | null>;
  revokeShare(input: {
    userWorkosId: string;
    workspaceId?: string | null;
    chatSessionId: string;
  }): Promise<boolean>;
  findShare(
    shareId: string,
  ): Promise<{ share: GoatChatShare; chatSession: PublicGoatChatSessionRecord } | null>;
  listMessages(chatSessionId: string): Promise<GoatStoredChatMessage[]>;
};

export function newGoatChatShareId() {
  return `goat_chat_share_${randomUUID()}`;
}

export function isGoatChatShareId(value: string) {
  return GOAT_CHAT_SHARE_ID_PATTERN.test(value);
}

export async function ensureGoatChatShareForUser(
  input: { userWorkosId: string; workspaceId?: string | null; chatSessionId: string },
  store: GoatChatShareStore = createDbGoatChatShareStore(),
): Promise<GoatChatShare | null> {
  const chatSessionId = input.chatSessionId.trim();
  if (!chatSessionId) return null;

  return store.ensureShare({
    id: newGoatChatShareId(),
    userWorkosId: input.userWorkosId,
    workspaceId: input.workspaceId ?? null,
    chatSessionId,
  });
}

export async function findGoatChatShareForUser(
  input: { userWorkosId: string; workspaceId?: string | null; chatSessionId: string },
  store: GoatChatShareStore = createDbGoatChatShareStore(),
): Promise<GoatChatShare | null> {
  const chatSessionId = input.chatSessionId.trim();
  if (!chatSessionId) return null;

  return store.findShareForUser({
    userWorkosId: input.userWorkosId,
    workspaceId: input.workspaceId ?? null,
    chatSessionId,
  });
}

export async function revokeGoatChatShareForUser(
  input: { userWorkosId: string; workspaceId?: string | null; chatSessionId: string },
  store: GoatChatShareStore = createDbGoatChatShareStore(),
): Promise<boolean> {
  const chatSessionId = input.chatSessionId.trim();
  if (!chatSessionId) return false;

  return store.revokeShare({
    userWorkosId: input.userWorkosId,
    workspaceId: input.workspaceId ?? null,
    chatSessionId,
  });
}

export async function loadPublicGoatChat(
  shareIdInput: string,
  store: GoatChatShareStore = createDbGoatChatShareStore(),
): Promise<PublicGoatChatView | null> {
  const result = await findPublicGoatChat(shareIdInput, store);
  if (!result) return null;

  const messages = await store.listMessages(result.chatSession.id);
  return {
    shareId: result.share.id,
    title: result.chatSession.title,
    kind: result.chatSession.kind,
    messages: messages.map(toPublicGoatChatUiMessage),
  };
}

export async function loadPublicGoatChatMetadata(
  shareIdInput: string,
  store: GoatChatShareStore = createDbGoatChatShareStore(),
): Promise<PublicGoatChatMetadata | null> {
  const result = await findPublicGoatChat(shareIdInput, store);
  if (!result) return null;

  return {
    shareId: result.share.id,
    title: result.chatSession.title,
    kind: result.chatSession.kind,
  };
}

type GoatChatDb = ReturnType<typeof getDb>;

export function createDbGoatChatShareStore(
  db: GoatChatDb = getDb(),
  chatStore: GoatChatStore = createDbGoatChatStore(db),
): GoatChatShareStore {
  return {
    async ensureShare(input) {
      const [ownedSession] = await db
        .select({ id: goatChatSessions.id })
        .from(goatChatSessions)
        .leftJoin(goatTasks, eq(goatTasks.sessionId, goatChatSessions.id))
        .where(
          and(
            eq(goatChatSessions.id, input.chatSessionId),
            shareableChatSessionAccessCondition(input),
          ),
        )
        .limit(1);
      if (!ownedSession) return null;

      await db
        .insert(goatChatShares)
        .values({ id: input.id, chatSessionId: ownedSession.id })
        .onConflictDoNothing({ target: goatChatShares.chatSessionId });

      const [share] = await db
        .select()
        .from(goatChatShares)
        .where(eq(goatChatShares.chatSessionId, ownedSession.id))
        .limit(1);
      return share ?? null;
    },

    async findShareForUser(input) {
      const [share] = await db
        .select({ share: goatChatShares })
        .from(goatChatShares)
        .innerJoin(goatChatSessions, eq(goatChatShares.chatSessionId, goatChatSessions.id))
        .leftJoin(goatTasks, eq(goatTasks.sessionId, goatChatSessions.id))
        .where(
          and(
            eq(goatChatShares.chatSessionId, input.chatSessionId),
            shareableChatSessionAccessCondition(input),
          ),
        )
        .limit(1);
      return share?.share ?? null;
    },

    async revokeShare(input) {
      const [ownedSession] = await db
        .select({ id: goatChatSessions.id })
        .from(goatChatSessions)
        .leftJoin(goatTasks, eq(goatTasks.sessionId, goatChatSessions.id))
        .where(
          and(
            eq(goatChatSessions.id, input.chatSessionId),
            shareableChatSessionAccessCondition(input),
          ),
        )
        .limit(1);
      if (!ownedSession) return false;

      await db.delete(goatChatShares).where(eq(goatChatShares.chatSessionId, ownedSession.id));
      return true;
    },

    async findShare(shareId) {
      const [result] = await db
        .select({
          share: goatChatShares,
          chatSession: {
            id: goatChatSessions.id,
            title: sql<string>`CASE
              WHEN ${goatChatSessions.kind} = 'task'
              THEN COALESCE(NULLIF(${goatTasks.name}, ''), ${goatChatSessions.title})
              ELSE ${goatChatSessions.title}
            END`,
            kind: goatChatSessions.kind,
          },
        })
        .from(goatChatShares)
        .innerJoin(goatChatSessions, eq(goatChatShares.chatSessionId, goatChatSessions.id))
        .leftJoin(goatTasks, eq(goatTasks.sessionId, goatChatSessions.id))
        .where(
          and(
            eq(goatChatShares.id, shareId),
            inArray(goatChatSessions.kind, SHAREABLE_GOAT_CHAT_SESSION_KINDS),
          ),
        )
        .limit(1);
      return result ?? null;
    },

    listMessages(chatSessionId) {
      return chatStore.listMessages(chatSessionId);
    },
  };
}

async function findPublicGoatChat(shareIdInput: string, store: GoatChatShareStore) {
  const shareId = shareIdInput.trim();
  if (!isGoatChatShareId(shareId)) return null;
  return store.findShare(shareId);
}

function toPublicGoatChatUiMessage(message: GoatStoredChatMessage): GoatChatUiMessage {
  const uiMessage = toGoatChatUiMessage(message);
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
    eq(goatChatSessions.userWorkosId, input.userWorkosId),
    inArray(goatChatSessions.kind, SHAREABLE_GOAT_CHAT_SESSION_KINDS),
  );
  const workspaceTaskSession = input.workspaceId?.trim()
    ? and(eq(goatChatSessions.kind, "task"), eq(goatTasks.workspaceId, input.workspaceId.trim()))
    : undefined;
  return (workspaceTaskSession ? or(ownedSession, workspaceTaskSession) : ownedSession) as SQL;
}
