import { randomUUID } from "node:crypto";
import type { AgentModelId } from "@opencompany/agent-runtime/types";
import { getDb } from "@opencompany/db/client";
import {
  type GoatChatMessage,
  type GoatChatMessageAttachment,
  type GoatChatMessageDebugTrace,
  type GoatChatRole,
  type GoatChatSession,
  type GoatCodexChatTurnSettings,
  goatChatMessages,
  goatChatSessions,
  goatCodexChatTurns,
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
import { codexComposerSettingsFromTurnSettings } from "@/lib/codex-chat-settings";
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
  loadLatestCodexTurnSettings?(input: {
    userWorkosId: string;
    sessionId: string;
  }): Promise<GoatCodexChatTurnSettings | null>;
  listMessages(sessionId: string): Promise<GoatStoredChatMessage[]>;
  insertMessage(input: {
    id?: string;
    sessionId: string;
    role: GoatChatRole;
    content: string;
    taskId?: string | null;
    debugTrace?: GoatChatMessageDebugTrace | null;
    attachments?: GoatChatMessageAttachment[] | null;
    attachmentTexts?: Record<string, string> | null;
  }): Promise<GoatChatMessage>;
  touchSession(input: { sessionId: string; now: Date }): Promise<void>;
  closeSession(input: { userWorkosId: string; sessionId: string; now: Date }): Promise<boolean>;
};

export async function loadCurrentGoatChatSession(): Promise<GoatChatSessionView | null> {
  const { user } = await currentGoatUser();
  const store = createDbGoatChatStore();
  const session = await store.findOpenSession({ userWorkosId: user.workosUserId });
  if (!session) return null;

  const [messages, codexComposerSettings] = await Promise.all([
    store.listMessages(session.id),
    loadCodexComposerSettingsForChatSession({
      store,
      userWorkosId: user.workosUserId,
      session,
    }),
  ]);
  return toChatSessionView(session, messages, codexComposerSettings);
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

  const [messages, codexComposerSettings] = await Promise.all([
    store.listMessages(session.id),
    loadCodexComposerSettingsForChatSession({
      store,
      userWorkosId: input.userWorkosId,
      session,
    }),
  ]);
  return toChatSessionView(session, messages, codexComposerSettings);
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
      const [messages, codexComposerSettings] = await Promise.all([
        store.listMessages(session.id),
        loadCodexComposerSettingsForChatSession({
          store,
          userWorkosId: input.userWorkosId,
          session,
        }),
      ]);
      return toChatSummaryView(session, messages, codexComposerSettings);
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
    attachments?: GoatChatMessageAttachment[] | null;
    attachmentTexts?: Record<string, string> | null;
  },
  store: GoatChatStore = createDbGoatChatStore(),
) {
  const session = await findOrCreateOpenSession({
    store,
    userWorkosId: input.userWorkosId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    model: input.model,
    prompt: input.prompt,
    firstAttachmentName: input.attachments?.[0]?.filename ?? null,
  });
  const previousMessages = await store.listMessages(session.id);
  const userMessage = await store.insertMessage({
    ...(input.messageId ? { id: input.messageId } : {}),
    sessionId: session.id,
    role: "user",
    content: input.prompt,
    attachments: input.attachments ?? null,
    attachmentTexts: input.attachmentTexts ?? null,
  });
  const now = new Date();
  await store.touchSession({ sessionId: session.id, now });

  const storedMessages = [...previousMessages, toStoredChatMessage(userMessage)];
  return {
    session,
    userMessage,
    storedMessages,
    messages: storedMessages.map((message) => toGoatChatUiMessage(message)),
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

    async loadLatestCodexTurnSettings(input) {
      const [turn] = await getDb()
        .select({ settings: goatCodexChatTurns.settings })
        .from(goatCodexChatTurns)
        .where(
          and(
            eq(goatCodexChatTurns.userWorkosId, input.userWorkosId),
            eq(goatCodexChatTurns.chatSessionId, input.sessionId),
          ),
        )
        .orderBy(desc(goatCodexChatTurns.createdAt))
        .limit(1);
      return turn?.settings ?? null;
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
          attachments: input.attachments ?? null,
          attachmentTexts: input.attachmentTexts ?? null,
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
  codexComposerSettings: ReturnType<typeof codexComposerSettingsFromTurnSettings> | null = null,
): GoatChatSessionView {
  return {
    id: session.id,
    title: session.title,
    model: session.model,
    engine: session.engine,
    codexComposerSettings,
    messages: messages.map(toGoatChatUiMessage),
  };
}

function toChatSummaryView(
  session: GoatChatSession,
  messages: readonly GoatStoredChatMessage[],
  codexComposerSettings: ReturnType<typeof codexComposerSettingsFromTurnSettings> | null = null,
): GoatChatSummaryView {
  return {
    id: session.id,
    title: session.title,
    model: session.model,
    engine: session.engine,
    codexComposerSettings,
    preview: previewFromMessages(messages),
    updatedAt: session.updatedAt.toISOString(),
  };
}

async function loadCodexComposerSettingsForChatSession(input: {
  store: GoatChatStore;
  userWorkosId: string;
  session: GoatChatSession;
}) {
  if (input.session.engine !== "codex") return null;
  const settings = await input.store.loadLatestCodexTurnSettings?.({
    userWorkosId: input.userWorkosId,
    sessionId: input.session.id,
  });
  return settings ? codexComposerSettingsFromTurnSettings(settings) : null;
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
  firstAttachmentName?: string | null;
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
    title: titleFromPrompt(input.prompt, input.firstAttachmentName ?? null),
  });
}

function titleFromPrompt(prompt: string, firstAttachmentName: string | null = null) {
  const title = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return toGoatTaskTitle(title ?? firstAttachmentName ?? "New chat");
}

function toStoredChatMessage(message: GoatChatMessage): GoatStoredChatMessage {
  return {
    id: message.id,
    sessionId: message.sessionId,
    role: message.role,
    content: message.content,
    taskId: message.taskId,
    debugTrace: message.debugTrace,
    attachments: message.attachments,
    attachmentTexts: message.attachmentTexts,
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
