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
  goatCodexChatSessions,
  goatCodexChatTurns,
  goatTasks,
  goatUsers,
} from "@opencompany/db/goat-schema";
import { and, asc, desc, eq, exists, gte, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { currentGoatUser } from "@/lib/auth";
import {
  applyApprovalResponsesToStoredParts,
  compareGoatChatMessageOrder,
  dismissPendingApprovalsInStoredParts,
  GOAT_PINNED_CHAT_LIMIT,
  type GoatChatSessionView,
  type GoatChatSummaryView,
  type GoatChatUiMessage,
  type GoatCodexRuntimeView,
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
    id?: string;
    userWorkosId: string;
    model: AgentModelId;
    title: string;
  }): Promise<GoatChatSession>;
  loadLatestCodexTurnSettings?(input: {
    userWorkosId: string;
    sessionId: string;
  }): Promise<GoatCodexChatTurnSettings | null>;
  loadCodexRuntime?(input: {
    userWorkosId: string;
    sessionId: string;
  }): Promise<GoatCodexRuntimeView | null>;
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
  reopenSession(input: { userWorkosId: string; sessionId: string; now: Date }): Promise<boolean>;
  setSessionPinned(input: {
    userWorkosId: string;
    sessionId: string;
    pinned: boolean;
    now: Date;
  }): Promise<boolean>;
};

export async function loadCurrentGoatChatSession(): Promise<GoatChatSessionView | null> {
  const { user } = await currentGoatUser();
  const store = createDbGoatChatStore();
  const session = await store.findOpenSession({ userWorkosId: user.workosUserId });
  if (!session) return null;

  const [messages, codexComposerSettings, codexRuntime] = await Promise.all([
    store.listMessages(session.id),
    loadCodexComposerSettingsForChatSession({
      store,
      userWorkosId: user.workosUserId,
      session,
    }),
    loadCodexRuntimeForChatSession({
      store,
      userWorkosId: user.workosUserId,
      session,
    }),
  ]);
  return toChatSessionView(session, messages, codexComposerSettings, codexRuntime);
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

  const [messages, codexComposerSettings, codexRuntime] = await Promise.all([
    store.listMessages(session.id),
    loadCodexComposerSettingsForChatSession({
      store,
      userWorkosId: input.userWorkosId,
      session,
    }),
    loadCodexRuntimeForChatSession({
      store,
      userWorkosId: input.userWorkosId,
      session,
    }),
  ]);
  return toChatSessionView(session, messages, codexComposerSettings, codexRuntime);
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
      const [messages, codexComposerSettings, codexRuntime] = await Promise.all([
        store.listMessages(session.id),
        loadCodexComposerSettingsForChatSession({
          store,
          userWorkosId: input.userWorkosId,
          session,
        }),
        loadCodexRuntimeForChatSession({
          store,
          userWorkosId: input.userWorkosId,
          session,
        }),
      ]);
      return toChatSummaryView(session, messages, codexComposerSettings, codexRuntime);
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
    newSessionId?: string | null;
    messageId?: string | null;
    attachments?: GoatChatMessageAttachment[] | null;
    attachmentTexts?: Record<string, string> | null;
  },
  store: GoatChatStore = createDbGoatChatStore(),
) {
  const { session, created: sessionCreated } = await findOrCreateOpenSession({
    store,
    userWorkosId: input.userWorkosId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.newSessionId ? { newSessionId: input.newSessionId } : {}),
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
    sessionCreated,
    userMessage,
    storedMessages,
    messages: storedMessages.map((message) => toGoatChatUiMessage(message)),
  };
}

// Continues the latest assistant message after the user answered its tool
// approval request(s). No user message is inserted: the client re-sends the
// assistant message carrying approval decisions, which are merged into the
// stored copy (never trusting client-supplied inputs/outputs) and persisted so
// the decided state survives a crash before the continuation stream lands.
export async function createGoatChatApprovalContinuationTurn(
  input: { userWorkosId: string; sessionId: string; message: GoatChatUiMessage },
  store: GoatChatStore = createDbGoatChatStore(),
): Promise<
  | {
      ok: true;
      session: GoatChatSession;
      lastUserMessage: GoatStoredChatMessage | null;
      storedMessages: GoatStoredChatMessage[];
      messages: GoatChatUiMessage[];
      respondedApprovalIds: string[];
    }
  | { ok: false; error: string }
> {
  const session = await store.findOpenSession({
    userWorkosId: input.userWorkosId,
    sessionId: input.sessionId,
  });
  if (!session) return { ok: false, error: "Chat session not found." };

  const stored = await store.listMessages(session.id);
  const lastStored = stored.at(-1);
  if (
    !lastStored ||
    lastStored.role !== "assistant" ||
    lastStored.id !== input.message.id ||
    !lastStored.debugTrace
  ) {
    return {
      ok: false,
      error: "Approval responses can only continue the latest assistant message.",
    };
  }

  const { parts, respondedApprovalIds } = applyApprovalResponsesToStoredParts(
    lastStored.debugTrace.uiMessageParts,
    input.message.parts,
  );
  if (respondedApprovalIds.length === 0) {
    return { ok: false, error: "No pending approvals to respond to." };
  }

  const mergedTrace = { ...lastStored.debugTrace, uiMessageParts: parts };
  await persistGoatChatAssistantMessage(
    {
      sessionId: session.id,
      messageId: lastStored.id,
      content: lastStored.content,
      taskId: lastStored.taskId,
      debugTrace: mergedTrace,
    },
    store,
  );

  const storedMessages = stored.map((message) =>
    message.id === lastStored.id ? { ...message, debugTrace: mergedTrace } : message,
  );
  const lastUserMessage =
    [...storedMessages].reverse().find((message) => message.role === "user") ?? null;
  return {
    ok: true,
    session,
    lastUserMessage,
    storedMessages,
    messages: storedMessages.map((message) => toGoatChatUiMessage(message)),
    respondedApprovalIds,
  };
}

// Called on normal user turns before the history goes to the model: approval
// requests the user talked past get denied as dismissed (an unresolved
// approval request is a tool call with no result, which the model conversion
// rejects). Changes are persisted so the chat UI resolves the stale card.
export async function dismissStaleGoatChatApprovals(
  turn: { storedMessages: GoatStoredChatMessage[] },
  store: GoatChatStore = createDbGoatChatStore(),
): Promise<{ changed: boolean; messages: GoatChatUiMessage[] }> {
  let changedAny = false;
  const storedMessages = await Promise.all(
    turn.storedMessages.map(async (message) => {
      if (message.role !== "assistant" || !message.debugTrace?.uiMessageParts) return message;
      const { parts, changed } = dismissPendingApprovalsInStoredParts(
        message.debugTrace.uiMessageParts,
      );
      if (!changed) return message;
      changedAny = true;
      const debugTrace = { ...message.debugTrace, uiMessageParts: parts };
      await persistGoatChatAssistantMessage(
        {
          sessionId: message.sessionId,
          messageId: message.id,
          content: message.content,
          taskId: message.taskId,
          debugTrace,
        },
        store,
      );
      return { ...message, debugTrace };
    }),
  );
  return {
    changed: changedAny,
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

export async function reopenGoatChatSessionForUser(
  input: { userWorkosId: string; sessionId: string },
  store: GoatChatStore = createDbGoatChatStore(),
) {
  return store.reopenSession({
    userWorkosId: input.userWorkosId,
    sessionId: input.sessionId,
    now: new Date(),
  });
}

export async function setGoatChatSessionPinnedForUser(
  input: { userWorkosId: string; sessionId: string; pinned: boolean },
  store: GoatChatStore = createDbGoatChatStore(),
) {
  return store.setSessionPinned({
    userWorkosId: input.userWorkosId,
    sessionId: input.sessionId,
    pinned: input.pinned,
    now: new Date(),
  });
}

type GoatChatDb = ReturnType<typeof getDb>;

export function createDbGoatChatStore(db: GoatChatDb = getDb()): GoatChatStore {
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

      const [session] = await db
        .select()
        .from(goatChatSessions)
        .where(where)
        .orderBy(desc(goatChatSessions.updatedAt))
        .limit(1);

      return session ?? null;
    },

    async listOpenSessions(input) {
      // Pinned sessions surface regardless of the recency window, with separate
      // caps for pinned and unpinned hydration.
      const [pinned, activeCodex, recent] = await Promise.all([
        db
          .select()
          .from(goatChatSessions)
          .where(
            and(
              eq(goatChatSessions.userWorkosId, input.userWorkosId),
              isNull(goatChatSessions.closedAt),
              isNotNull(goatChatSessions.pinnedAt),
            ),
          )
          .orderBy(desc(goatChatSessions.pinnedAt))
          .limit(GOAT_PINNED_CHAT_LIMIT),
        db
          .select()
          .from(goatChatSessions)
          .where(
            and(
              eq(goatChatSessions.userWorkosId, input.userWorkosId),
              isNull(goatChatSessions.closedAt),
              isNull(goatChatSessions.pinnedAt),
              exists(
                db
                  .select({ id: goatCodexChatSessions.id })
                  .from(goatCodexChatSessions)
                  .where(
                    and(
                      eq(goatCodexChatSessions.chatSessionId, goatChatSessions.id),
                      eq(goatCodexChatSessions.userWorkosId, input.userWorkosId),
                      inArray(goatCodexChatSessions.status, ["queued", "starting", "running"]),
                    ),
                  ),
              ),
            ),
          )
          .orderBy(desc(goatChatSessions.updatedAt)),
        db
          .select()
          .from(goatChatSessions)
          .where(
            and(
              eq(goatChatSessions.userWorkosId, input.userWorkosId),
              isNull(goatChatSessions.closedAt),
              isNull(goatChatSessions.pinnedAt),
              ...(input.updatedAfter ? [gte(goatChatSessions.updatedAt, input.updatedAfter)] : []),
            ),
          )
          .orderBy(desc(goatChatSessions.updatedAt))
          .limit(input.limit),
      ]);
      const seen = new Set<string>();
      return [...pinned, ...activeCodex, ...recent].filter((session) => {
        if (seen.has(session.id)) return false;
        seen.add(session.id);
        return true;
      });
    },

    async createSession(input) {
      const now = new Date();
      const [session] = await db
        .insert(goatChatSessions)
        .values({
          id: input.id ?? newGoatChatSessionId(),
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
      const [turn] = await db
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

    async loadCodexRuntime(input) {
      const [runtime] = await db
        .select({
          status: goatCodexChatSessions.status,
          error: goatCodexChatSessions.error,
          updatedAt: goatCodexChatSessions.updatedAt,
        })
        .from(goatCodexChatSessions)
        .where(
          and(
            eq(goatCodexChatSessions.userWorkosId, input.userWorkosId),
            eq(goatCodexChatSessions.chatSessionId, input.sessionId),
          ),
        )
        .limit(1);
      return runtime
        ? {
            status: runtime.status,
            error: runtime.error,
            updatedAt: runtime.updatedAt.toISOString(),
          }
        : null;
    },

    async listMessages(sessionId) {
      const messages = await db
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
      const insert = db.insert(goatChatMessages).values({
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
      });
      // Assistant messages are upserts: an approval continuation finishes the
      // stream under the same message id the paused turn already persisted.
      // The guard keeps a colliding id from ever rewriting another session's
      // (or a user's) message — the update is skipped and the throw below
      // surfaces the conflict like the plain insert used to.
      const [message] = await (input.role === "assistant"
        ? insert.onConflictDoUpdate({
            target: goatChatMessages.id,
            set: {
              content: input.content,
              taskId: input.taskId ?? null,
              debugTrace: input.debugTrace ?? null,
              updatedAt: now,
            },
            setWhere: sql`${goatChatMessages.sessionId} = ${input.sessionId} and ${goatChatMessages.role} = 'assistant'`,
          })
        : insert
      ).returning();
      if (!message) throw new Error("Unable to create Goat chat message.");
      return message;
    },

    async touchSession(input) {
      await db
        .update(goatChatSessions)
        .set({ updatedAt: input.now })
        .where(eq(goatChatSessions.id, input.sessionId));
    },

    async closeSession(input) {
      const [session] = await db
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

    async reopenSession(input) {
      const [session] = await db
        .update(goatChatSessions)
        .set({ closedAt: null, updatedAt: input.now })
        .where(
          and(
            eq(goatChatSessions.id, input.sessionId),
            eq(goatChatSessions.userWorkosId, input.userWorkosId),
            isNotNull(goatChatSessions.closedAt),
          ),
        )
        .returning({ id: goatChatSessions.id });
      return Boolean(session);
    },

    async setSessionPinned(input) {
      const pinCount = db
        .select({ count: sql<number>`count(*)::integer` })
        .from(goatChatSessions)
        .where(
          and(
            eq(goatChatSessions.userWorkosId, input.userWorkosId),
            ne(goatChatSessions.id, input.sessionId),
            isNull(goatChatSessions.closedAt),
            isNotNull(goatChatSessions.pinnedAt),
          ),
        );
      const pinCapacity = sql`(${pinCount}) < ${GOAT_PINNED_CHAT_LIMIT}`;

      // The web app uses neon-http, which cannot hold an interactive transaction
      // open across a callback. Its batch API still executes these statements in
      // one transaction. Locking the owner serializes concurrent cap checks.
      const [owners, sessions] = await db.batch([
        db
          .select({ workosUserId: goatUsers.workosUserId })
          .from(goatUsers)
          .where(eq(goatUsers.workosUserId, input.userWorkosId))
          .limit(1)
          .for("update"),
        db
          .update(goatChatSessions)
          .set({ pinnedAt: input.pinned ? input.now : null })
          .where(
            and(
              eq(goatChatSessions.id, input.sessionId),
              eq(goatChatSessions.userWorkosId, input.userWorkosId),
              isNull(goatChatSessions.closedAt),
              ...(input.pinned ? [pinCapacity] : []),
            ),
          )
          .returning({ id: goatChatSessions.id }),
      ] as const);

      return Boolean(owners[0] && sessions[0]);
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
  codexRuntime: GoatCodexRuntimeView | null = null,
): GoatChatSessionView {
  return {
    id: session.id,
    title: session.title,
    model: session.model,
    engine: session.engine,
    codexComposerSettings,
    codexRuntime,
    messages: messages.map(toGoatChatUiMessage),
  };
}

function toChatSummaryView(
  session: GoatChatSession,
  messages: readonly GoatStoredChatMessage[],
  codexComposerSettings: ReturnType<typeof codexComposerSettingsFromTurnSettings> | null = null,
  codexRuntime: GoatCodexRuntimeView | null = null,
): GoatChatSummaryView {
  return {
    id: session.id,
    title: session.title,
    model: session.model,
    engine: session.engine,
    codexComposerSettings,
    codexRuntime,
    preview: previewFromMessages(messages),
    updatedAt: session.updatedAt.toISOString(),
    pinnedAt: session.pinnedAt?.toISOString() ?? null,
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

async function loadCodexRuntimeForChatSession(input: {
  store: GoatChatStore;
  userWorkosId: string;
  session: GoatChatSession;
}) {
  if (input.session.engine !== "codex") return null;
  return (
    (await input.store.loadCodexRuntime?.({
      userWorkosId: input.userWorkosId,
      sessionId: input.session.id,
    })) ?? null
  );
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
  newSessionId?: string | null;
  model: AgentModelId;
  prompt: string;
  firstAttachmentName?: string | null;
}) {
  if (input.sessionId) {
    const existing = await input.store.findOpenSession({
      userWorkosId: input.userWorkosId,
      sessionId: input.sessionId,
    });
    if (existing) return { session: existing, created: false };
  }

  if (input.newSessionId) {
    const existing = await input.store.findOpenSession({
      userWorkosId: input.userWorkosId,
      sessionId: input.newSessionId,
    });
    if (existing) return { session: existing, created: false };
  }

  const session = await input.store.createSession({
    ...(input.newSessionId ? { id: input.newSessionId } : {}),
    userWorkosId: input.userWorkosId,
    model: input.model,
    title: titleFromPrompt(input.prompt, input.firstAttachmentName ?? null),
  });
  return { session, created: true };
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
