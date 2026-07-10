import { randomUUID } from "node:crypto";
import type { AgentModelId } from "@opencompany/agent-runtime/types";
import { getDb } from "@opencompany/db/client";
import {
  type GoatChatMessage,
  type GoatChatMessageDebugTrace,
  type GoatChatRole,
  type GoatChatSession,
  goatChatMessages,
  goatChatSessions,
  goatTasks,
} from "@opencompany/db/goat-schema";
import { and, asc, desc, eq, gte, isNull } from "drizzle-orm";
import { currentGoatUser } from "@/lib/auth";
import {
  compareGoatChatMessageOrder,
  type GoatChatSessionView,
  type GoatChatSummaryView,
  type GoatStoredChatMessage,
  toGoatChatUiMessage,
} from "@/lib/chat-ui";
import { goatHomeActivityCutoff } from "@/lib/home-activity";
import { toGoatTaskTitle } from "@/lib/task-display";

const GOAT_RECENT_CHAT_LIMIT = 8;
const GOAT_CHAT_PREVIEW_MAX_LENGTH = 96;

export type {
  GoatChatMessageMetadata,
  GoatChatSessionView,
  GoatChatSummaryView,
  GoatChatUiMessage,
  GoatStoredChatMessage,
  StartTaskToolOutput,
} from "@/lib/chat-ui";
export {
  textFromGoatChatUiMessage,
  toGoatChatMessageMetadata,
  toGoatChatUiMessage,
} from "@/lib/chat-ui";

export type GoatChatStore = {
  findOpenSession(input: {
    userWorkosId: string;
    sessionId?: string | null;
  }): Promise<GoatChatSession | null>;
  listOpenSessions(input: {
    userWorkosId: string;
    limit: number;
    updatedAfter?: Date;
  }): Promise<GoatChatSession[]>;
  createSession(input: {
    userWorkosId: string;
    model: AgentModelId;
    title: string;
  }): Promise<GoatChatSession>;
  listMessages(sessionId: string): Promise<GoatStoredChatMessage[]>;
  insertMessage(input: {
    id?: string;
    sessionId: string;
    role: GoatChatRole;
    content: string;
    taskId?: string | null;
    debugTrace?: GoatChatMessageDebugTrace | null;
  }): Promise<GoatChatMessage>;
  touchSession(input: { sessionId: string; now: Date }): Promise<void>;
  closeSession(input: { userWorkosId: string; sessionId: string; now: Date }): Promise<boolean>;
};

export async function loadCurrentGoatChatSession(): Promise<GoatChatSessionView | null> {
  const { user } = await currentGoatUser();
  const store = createDbGoatChatStore();
  const session = await store.findOpenSession({ userWorkosId: user.workosUserId });
  if (!session) return null;

  const messages = await store.listMessages(session.id);
  return toChatSessionView(session, messages);
}

export async function loadCurrentGoatChatSessionById(
  sessionId: string | null | undefined,
): Promise<GoatChatSessionView | null> {
  const trimmed = sessionId?.trim();
  if (!trimmed) return null;

  const { user } = await currentGoatUser();
  return loadGoatChatSessionByIdForUser({
    userWorkosId: user.workosUserId,
    sessionId: trimmed,
  });
}

export async function loadGoatChatSessionByIdForUser(
  input: { userWorkosId: string; sessionId: string },
  store: GoatChatStore = createDbGoatChatStore(),
): Promise<GoatChatSessionView | null> {
  const session = await store.findOpenSession({
    userWorkosId: input.userWorkosId,
    sessionId: input.sessionId,
  });
  if (!session) return null;

  const messages = await store.listMessages(session.id);
  return toChatSessionView(session, messages);
}

export async function listCurrentUserRecentGoatChats(
  limit = GOAT_RECENT_CHAT_LIMIT,
): Promise<GoatChatSummaryView[]> {
  const { user } = await currentGoatUser();
  const store = createDbGoatChatStore();
  return listRecentGoatChatsForUser({ userWorkosId: user.workosUserId, limit }, store);
}

export async function listRecentGoatChatsForUser(
  input: { userWorkosId: string; limit?: number },
  store: GoatChatStore = createDbGoatChatStore(),
): Promise<GoatChatSummaryView[]> {
  const limit = Math.max(
    1,
    Math.min(input.limit ?? GOAT_RECENT_CHAT_LIMIT, GOAT_RECENT_CHAT_LIMIT),
  );
  const sessions = await store.listOpenSessions({
    userWorkosId: input.userWorkosId,
    limit,
    updatedAfter: goatHomeActivityCutoff(),
  });
  const summaries = await Promise.all(
    sessions.map(async (session) => {
      const messages = await store.listMessages(session.id);
      return toChatSummaryView(session, messages);
    }),
  );
  return summaries;
}

export async function createGoatChatUserTurn(
  input: {
    userWorkosId: string;
    prompt: string;
    model: AgentModelId;
    sessionId?: string | null;
    messageId?: string | null;
  },
  store: GoatChatStore = createDbGoatChatStore(),
) {
  const session = await findOrCreateOpenSession({
    store,
    userWorkosId: input.userWorkosId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    model: input.model,
    prompt: input.prompt,
  });
  const previousMessages = await store.listMessages(session.id);
  const userMessage = await store.insertMessage({
    ...(input.messageId ? { id: input.messageId } : {}),
    sessionId: session.id,
    role: "user",
    content: input.prompt,
  });
  const now = new Date();
  await store.touchSession({ sessionId: session.id, now });

  return {
    session,
    userMessage,
    messages: [
      ...previousMessages.map((message) => toGoatChatUiMessage(message)),
      toGoatChatUiMessage(toStoredChatMessage(userMessage)),
    ],
  };
}

export async function persistGoatChatAssistantMessage(
  input: {
    sessionId: string;
    messageId?: string | null;
    content: string;
    taskId?: string | null;
    debugTrace?: GoatChatMessageDebugTrace | null;
  },
  store: GoatChatStore = createDbGoatChatStore(),
) {
  const assistantMessage = await store.insertMessage({
    ...(input.messageId ? { id: input.messageId } : {}),
    sessionId: input.sessionId,
    role: "assistant",
    content: input.content,
    taskId: input.taskId ?? null,
    debugTrace: input.debugTrace ?? null,
  });
  await store.touchSession({ sessionId: input.sessionId, now: new Date() });
  return assistantMessage;
}

export async function closeGoatChatSessionForUser(
  input: { userWorkosId: string; sessionId: string },
  store: GoatChatStore = createDbGoatChatStore(),
) {
  return store.closeSession({
    userWorkosId: input.userWorkosId,
    sessionId: input.sessionId,
    now: new Date(),
  });
}

export function createDbGoatChatStore(): GoatChatStore {
  return {
    async findOpenSession(input) {
      const where = input.sessionId?.trim()
        ? and(
            eq(goatChatSessions.id, input.sessionId.trim()),
            eq(goatChatSessions.userWorkosId, input.userWorkosId),
            isNull(goatChatSessions.closedAt),
          )
        : and(
            eq(goatChatSessions.userWorkosId, input.userWorkosId),
            isNull(goatChatSessions.closedAt),
          );

      const [session] = await getDb()
        .select()
        .from(goatChatSessions)
        .where(where)
        .orderBy(desc(goatChatSessions.updatedAt))
        .limit(1);

      return session ?? null;
    },

    async listOpenSessions(input) {
      return getDb()
        .select()
        .from(goatChatSessions)
        .where(
          and(
            eq(goatChatSessions.userWorkosId, input.userWorkosId),
            isNull(goatChatSessions.closedAt),
            ...(input.updatedAfter ? [gte(goatChatSessions.updatedAt, input.updatedAfter)] : []),
          ),
        )
        .orderBy(desc(goatChatSessions.updatedAt))
        .limit(input.limit);
    },

    async createSession(input) {
      const now = new Date();
      const [session] = await getDb()
        .insert(goatChatSessions)
        .values({
          id: newGoatChatSessionId(),
          userWorkosId: input.userWorkosId,
          title: input.title,
          model: input.model,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!session) throw new Error("Unable to create Goat chat session.");
      return session;
    },

    async listMessages(sessionId) {
      const messages = await getDb()
        .select({
          id: goatChatMessages.id,
          sessionId: goatChatMessages.sessionId,
          role: goatChatMessages.role,
          content: goatChatMessages.content,
          taskId: goatChatMessages.taskId,
          debugTrace: goatChatMessages.debugTrace,
          createdAt: goatChatMessages.createdAt,
          updatedAt: goatChatMessages.updatedAt,
          taskDisplayId: goatTasks.displayId,
          taskName: goatTasks.name,
          taskPrompt: goatTasks.prompt,
          taskStatus: goatTasks.status,
        })
        .from(goatChatMessages)
        .leftJoin(goatTasks, eq(goatChatMessages.taskId, goatTasks.id))
        .where(eq(goatChatMessages.sessionId, sessionId))
        .orderBy(asc(goatChatMessages.createdAt));
      return messages.toSorted(compareGoatChatMessageOrder);
    },

    async insertMessage(input) {
      const now = new Date();
      const [message] = await getDb()
        .insert(goatChatMessages)
        .values({
          id: input.id ?? newGoatChatMessageId(),
          sessionId: input.sessionId,
          role: input.role,
          content: input.content,
          taskId: input.taskId ?? null,
          debugTrace: input.debugTrace ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!message) throw new Error("Unable to create Goat chat message.");
      return message;
    },

    async touchSession(input) {
      await getDb()
        .update(goatChatSessions)
        .set({ updatedAt: input.now })
        .where(eq(goatChatSessions.id, input.sessionId));
    },

    async closeSession(input) {
      const [session] = await getDb()
        .update(goatChatSessions)
        .set({ closedAt: input.now, updatedAt: input.now })
        .where(
          and(
            eq(goatChatSessions.id, input.sessionId),
            eq(goatChatSessions.userWorkosId, input.userWorkosId),
            isNull(goatChatSessions.closedAt),
          ),
        )
        .returning({ id: goatChatSessions.id });
      return Boolean(session);
    },
  };
}

export function newGoatChatMessageId() {
  return `goat_chat_msg_${randomUUID()}`;
}

function toChatSessionView(
  session: GoatChatSession,
  messages: readonly GoatStoredChatMessage[],
): GoatChatSessionView {
  return {
    id: session.id,
    title: session.title,
    model: session.model,
    engine: session.engine,
    messages: messages.map(toGoatChatUiMessage),
  };
}

function toChatSummaryView(
  session: GoatChatSession,
  messages: readonly GoatStoredChatMessage[],
): GoatChatSummaryView {
  return {
    id: session.id,
    title: session.title,
    model: session.model,
    engine: session.engine,
    preview: previewFromMessages(messages),
    updatedAt: session.updatedAt.toISOString(),
  };
}

function previewFromMessages(messages: readonly Pick<GoatStoredChatMessage, "content">[]) {
  const content =
    messages
      .toReversed()
      .map((message) => message.content.replace(/\s+/g, " ").trim())
      .find(Boolean) ?? "No messages yet.";

  if (content.length <= GOAT_CHAT_PREVIEW_MAX_LENGTH) return content;
  return `${content.slice(0, GOAT_CHAT_PREVIEW_MAX_LENGTH - 1).trimEnd()}...`;
}

async function findOrCreateOpenSession(input: {
  store: GoatChatStore;
  userWorkosId: string;
  sessionId?: string | null;
  model: AgentModelId;
  prompt: string;
}) {
  if (input.sessionId) {
    const existing = await input.store.findOpenSession({
      userWorkosId: input.userWorkosId,
      sessionId: input.sessionId,
    });
    if (existing) return existing;
  }

  return input.store.createSession({
    userWorkosId: input.userWorkosId,
    model: input.model,
    title: titleFromPrompt(input.prompt),
  });
}

function titleFromPrompt(prompt: string) {
  const title = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return toGoatTaskTitle(title ?? "New chat");
}

function toStoredChatMessage(message: GoatChatMessage): GoatStoredChatMessage {
  return {
    id: message.id,
    sessionId: message.sessionId,
    role: message.role,
    content: message.content,
    taskId: message.taskId,
    debugTrace: message.debugTrace,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    taskDisplayId: null,
    taskName: null,
    taskPrompt: null,
    taskStatus: null,
  };
}

function newGoatChatSessionId() {
  return `goat_chat_${randomUUID()}`;
}
