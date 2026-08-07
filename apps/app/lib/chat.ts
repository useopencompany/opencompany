import { randomUUID } from "node:crypto";
import type { AgentModelId } from "@opencompany/agent-runtime/types";
import { getDb } from "@opencompany/db/client";
import {
  type ChatMessage,
  type ChatMessageAttachment,
  type ChatMessageDebugTrace,
  type ChatRole,
  type ChatSession,
  type ChatSessionKind,
  type CodexChatTurnSettings,
  chatMessages,
  chatSessions,
  codexChatSessions,
  codexChatTurns,
  tasks,
  users,
} from "@opencompany/db/schema";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gte,
  inArray,
  isNotNull,
  isNull,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { currentUser } from "@/lib/auth";
import {
  applyApprovalResponsesToStoredParts,
  type ChatSessionView,
  type ChatSummaryView,
  type ChatUiMessage,
  type CodexRuntimeView,
  compareChatMessageOrder,
  deriveChatState,
  dismissPendingApprovalsInStoredParts,
  PINNED_CHAT_LIMIT,
  type StoredChatMessage,
  settleIncompleteToolCallsInStoredParts,
  toChatUiMessage,
} from "@/lib/chat-ui";
import { DEFAULT_CLAUDE_CHAT_REASONING_EFFORT } from "@/lib/claude-chat-settings";
import { codexComposerSettingsFromTurnSettings } from "@/lib/codex-chat-settings";
import { homeActivityCutoff } from "@/lib/home-activity";
import { toTaskTitle } from "@/lib/task-display";

const RECENT_CHAT_LIMIT = 8;
const CHAT_PREVIEW_MAX_LENGTH = 96;

export type {
  ChatMessageMetadata,
  ChatSessionView,
  ChatSummaryView,
  ChatUiMessage,
  StartTaskToolOutput,
  StoredChatMessage,
} from "@/lib/chat-ui";
export {
  textFromChatUiMessage,
  toChatMessageMetadata,
  toChatUiMessage,
} from "@/lib/chat-ui";

export type ChatStore = {
  findOpenSession(input: {
    userWorkosId: string;
    sessionId?: string | null;
    kind?: ChatSessionKind;
  }): Promise<ChatSession | null>;
  listOpenSessions(input: {
    userWorkosId: string;
    limit: number;
    updatedAfter?: Date;
  }): Promise<ChatSession[]>;
  createSession(input: {
    id?: string;
    userWorkosId: string;
    model: AgentModelId;
    title: string;
  }): Promise<ChatSession>;
  loadLatestCodexTurnSettings?(input: {
    userWorkosId: string;
    sessionId: string;
  }): Promise<CodexChatTurnSettings | null>;
  loadCodexRuntime?(input: {
    userWorkosId: string;
    sessionId: string;
  }): Promise<CodexRuntimeView | null>;
  listMessages(sessionId: string): Promise<StoredChatMessage[]>;
  insertMessage(input: {
    id?: string;
    sessionId: string;
    role: ChatRole;
    content: string;
    taskId?: string | null;
    debugTrace?: ChatMessageDebugTrace | null;
    attachments?: ChatMessageAttachment[] | null;
    attachmentTexts?: Record<string, string> | null;
  }): Promise<ChatMessage>;
  touchSession(input: { sessionId: string; now: Date }): Promise<void>;
  markSessionSeen(input: {
    userWorkosId: string;
    sessionId: string;
    seenAt: Date;
  }): Promise<boolean>;
  closeSession(input: { userWorkosId: string; sessionId: string; now: Date }): Promise<boolean>;
  reopenSession(input: { userWorkosId: string; sessionId: string; now: Date }): Promise<boolean>;
  setSessionPinned(input: {
    userWorkosId: string;
    sessionId: string;
    pinned: boolean;
    now: Date;
  }): Promise<boolean>;
};

export async function loadCurrentChatSession(): Promise<ChatSessionView | null> {
  const { user } = await currentUser();
  const store = createDbChatStore();
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

export async function loadCurrentChatSessionById(
  sessionId: string | null | undefined,
): Promise<ChatSessionView | null> {
  const trimmed = sessionId?.trim();
  if (!trimmed) return null;

  const { user } = await currentUser();
  return loadChatSessionByIdForUser({
    userWorkosId: user.workosUserId,
    sessionId: trimmed,
  });
}

export async function loadChatSessionByIdForUser(
  input: { userWorkosId: string; sessionId: string; kind?: ChatSessionKind },
  store: ChatStore = createDbChatStore(),
): Promise<ChatSessionView | null> {
  const session = await store.findOpenSession({
    userWorkosId: input.userWorkosId,
    sessionId: input.sessionId,
    kind: input.kind ?? "chat",
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

export async function loadTaskChatSessionByIdForWorkspace(
  input: { workspaceId: string; sessionId: string },
  store: ChatStore = createDbChatStore(),
): Promise<ChatSessionView | null> {
  const [row] = await getDb()
    .select({ session: chatSessions })
    .from(chatSessions)
    .innerJoin(
      codexChatSessions,
      and(
        eq(codexChatSessions.chatSessionId, chatSessions.id),
        eq(codexChatSessions.userWorkosId, chatSessions.userWorkosId),
      ),
    )
    .where(
      and(
        eq(chatSessions.id, input.sessionId),
        eq(chatSessions.kind, "task"),
        isNull(chatSessions.closedAt),
        eq(codexChatSessions.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);
  const session = row?.session ?? null;
  if (!session) return null;

  const [messages, codexComposerSettings, codexRuntime] = await Promise.all([
    store.listMessages(session.id),
    loadCodexComposerSettingsForChatSession({
      store,
      userWorkosId: session.userWorkosId,
      session,
    }),
    loadCodexRuntimeForChatSession({
      store,
      userWorkosId: session.userWorkosId,
      session,
    }),
  ]);
  return toChatSessionView(session, messages, codexComposerSettings, codexRuntime);
}

export async function listCurrentUserRecentChats(
  limit = RECENT_CHAT_LIMIT,
): Promise<ChatSummaryView[]> {
  const { user } = await currentUser();
  const store = createDbChatStore();
  return listRecentChatsForUser({ userWorkosId: user.workosUserId, limit }, store);
}

export async function listRecentChatsForUser(
  input: { userWorkosId: string; limit?: number },
  store: ChatStore = createDbChatStore(),
): Promise<ChatSummaryView[]> {
  const limit = Math.max(1, Math.min(input.limit ?? RECENT_CHAT_LIMIT, RECENT_CHAT_LIMIT));
  const sessions = await store.listOpenSessions({
    userWorkosId: input.userWorkosId,
    limit,
    updatedAfter: homeActivityCutoff(),
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

export async function createChatUserTurn(
  input: {
    userWorkosId: string;
    prompt: string;
    model: AgentModelId;
    sessionId?: string | null;
    newSessionId?: string | null;
    messageId?: string | null;
    attachments?: ChatMessageAttachment[] | null;
    attachmentTexts?: Record<string, string> | null;
  },
  store: ChatStore = createDbChatStore(),
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
    messages: storedMessages.map((message) => toChatUiMessage(message)),
  };
}

// Continues the latest assistant message after the user answered its tool
// approval request(s). No user message is inserted: the client re-sends the
// assistant message carrying approval decisions, which are merged into the
// stored copy (never trusting client-supplied inputs/outputs) and persisted so
// the decided state survives a crash before the continuation stream lands.
export async function createChatApprovalContinuationTurn(
  input: { userWorkosId: string; sessionId: string; message: ChatUiMessage },
  store: ChatStore = createDbChatStore(),
): Promise<
  | {
      ok: true;
      session: ChatSession;
      lastUserMessage: StoredChatMessage | null;
      storedMessages: StoredChatMessage[];
      messages: ChatUiMessage[];
      respondedApprovals: Array<{
        approvalId: string;
        toolCallId: string;
        action: string;
        approved: boolean;
      }>;
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

  const { parts, respondedApprovals } = applyApprovalResponsesToStoredParts(
    lastStored.debugTrace.uiMessageParts,
    input.message.parts,
  );
  if (respondedApprovals.length === 0) {
    return { ok: false, error: "No pending approvals to respond to." };
  }

  const mergedTrace = { ...lastStored.debugTrace, uiMessageParts: parts };
  await persistChatAssistantMessage(
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
    messages: storedMessages.map((message) => toChatUiMessage(message)),
    respondedApprovals,
  };
}

// Called on normal user turns before the history goes to the model. Approval
// requests the user talked past are denied, and incomplete calls left by a
// stopped or failed stream are settled. Both otherwise create tool calls with
// no result, which model conversion rejects. Persist the repair so the UI and
// every later turn share the same terminal state.
export async function settleStaleChatToolCalls(
  turn: { storedMessages: StoredChatMessage[] },
  store: ChatStore = createDbChatStore(),
): Promise<{ changed: boolean; messages: ChatUiMessage[]; toolCallIds: string[] }> {
  let changedAny = false;
  const toolCallIds = new Set<string>();
  const storedMessages = await Promise.all(
    turn.storedMessages.map(async (message) => {
      if (message.role !== "assistant" || !message.debugTrace?.uiMessageParts) return message;
      const dismissed = dismissPendingApprovalsInStoredParts(message.debugTrace.uiMessageParts);
      const settled = settleIncompleteToolCallsInStoredParts(dismissed.parts);
      if (!dismissed.changed && !settled.changed) return message;
      changedAny = true;
      for (const toolCallId of [...dismissed.toolCallIds, ...settled.toolCallIds]) {
        toolCallIds.add(toolCallId);
      }
      const debugTrace = { ...message.debugTrace, uiMessageParts: settled.parts };
      await persistChatAssistantMessage(
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
    messages: storedMessages.map((message) => toChatUiMessage(message)),
    toolCallIds: [...toolCallIds],
  };
}

export async function persistChatAssistantMessage(
  input: {
    sessionId: string;
    messageId?: string | null;
    content: string;
    taskId?: string | null;
    debugTrace?: ChatMessageDebugTrace | null;
  },
  store: ChatStore = createDbChatStore(),
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

export async function closeChatSessionForUser(
  input: { userWorkosId: string; sessionId: string },
  store: ChatStore = createDbChatStore(),
) {
  return store.closeSession({
    userWorkosId: input.userWorkosId,
    sessionId: input.sessionId,
    now: new Date(),
  });
}

export async function reopenChatSessionForUser(
  input: { userWorkosId: string; sessionId: string },
  store: ChatStore = createDbChatStore(),
) {
  return store.reopenSession({
    userWorkosId: input.userWorkosId,
    sessionId: input.sessionId,
    now: new Date(),
  });
}

export async function setChatSessionPinnedForUser(
  input: { userWorkosId: string; sessionId: string; pinned: boolean },
  store: ChatStore = createDbChatStore(),
) {
  return store.setSessionPinned({
    userWorkosId: input.userWorkosId,
    sessionId: input.sessionId,
    pinned: input.pinned,
    now: new Date(),
  });
}

export async function markChatSessionSeenForUser(
  input: { userWorkosId: string; sessionId: string },
  store: ChatStore = createDbChatStore(),
) {
  return store.markSessionSeen({
    userWorkosId: input.userWorkosId,
    sessionId: input.sessionId,
    seenAt: new Date(),
  });
}

type ChatDb = ReturnType<typeof getDb>;

export function createDbChatStore(db: ChatDb = getDb()): ChatStore {
  return {
    async findOpenSession(input) {
      const where = input.sessionId?.trim()
        ? and(
            eq(chatSessions.id, input.sessionId.trim()),
            eq(chatSessions.userWorkosId, input.userWorkosId),
            isNull(chatSessions.closedAt),
            eq(chatSessions.kind, input.kind ?? "chat"),
          )
        : and(
            eq(chatSessions.userWorkosId, input.userWorkosId),
            isNull(chatSessions.closedAt),
            eq(chatSessions.kind, input.kind ?? "chat"),
          );

      const [session] = await db
        .select()
        .from(chatSessions)
        .where(where)
        .orderBy(desc(chatSessions.updatedAt))
        .limit(1);

      return session ?? null;
    },

    async listOpenSessions(input) {
      // Pinned sessions surface regardless of the recency window, with separate
      // caps for pinned and unpinned hydration.
      const [pinned, activeCodex, recent] = await Promise.all([
        db
          .select()
          .from(chatSessions)
          .where(
            and(
              eq(chatSessions.userWorkosId, input.userWorkosId),
              isNull(chatSessions.closedAt),
              eq(chatSessions.kind, "chat"),
              isNotNull(chatSessions.pinnedAt),
            ),
          )
          .orderBy(desc(chatSessions.pinnedAt))
          .limit(PINNED_CHAT_LIMIT),
        db
          .select()
          .from(chatSessions)
          .where(
            and(
              eq(chatSessions.userWorkosId, input.userWorkosId),
              isNull(chatSessions.closedAt),
              eq(chatSessions.kind, "chat"),
              isNull(chatSessions.pinnedAt),
              exists(
                db
                  .select({ id: codexChatSessions.id })
                  .from(codexChatSessions)
                  .where(
                    and(
                      eq(codexChatSessions.chatSessionId, chatSessions.id),
                      eq(codexChatSessions.userWorkosId, input.userWorkosId),
                      or(
                        inArray(codexChatSessions.status, ["queued", "starting", "running"]),
                        and(
                          isNotNull(codexChatSessions.activeTurnId),
                          notInArray(codexChatSessions.status, ["failed", "interrupted", "closed"]),
                        ),
                      ),
                    ),
                  ),
              ),
            ),
          )
          .orderBy(desc(chatSessions.updatedAt)),
        db
          .select()
          .from(chatSessions)
          .where(
            and(
              eq(chatSessions.userWorkosId, input.userWorkosId),
              isNull(chatSessions.closedAt),
              eq(chatSessions.kind, "chat"),
              isNull(chatSessions.pinnedAt),
              ...(input.updatedAfter ? [gte(chatSessions.updatedAt, input.updatedAfter)] : []),
            ),
          )
          .orderBy(desc(chatSessions.updatedAt))
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
        .insert(chatSessions)
        .values({
          id: input.id ?? newChatSessionId(),
          userWorkosId: input.userWorkosId,
          title: input.title,
          model: input.model,
          lastSeenAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!session) throw new Error("Unable to create chat session.");
      return session;
    },

    async loadLatestCodexTurnSettings(input) {
      const [turn] = await db
        .select({ settings: codexChatTurns.settings })
        .from(codexChatTurns)
        .where(
          and(
            eq(codexChatTurns.userWorkosId, input.userWorkosId),
            eq(codexChatTurns.chatSessionId, input.sessionId),
          ),
        )
        .orderBy(desc(codexChatTurns.createdAt))
        .limit(1);
      return turn?.settings ?? null;
    },

    async loadCodexRuntime(input) {
      const [runtime] = await db
        .select({
          status: codexChatSessions.status,
          activeTurnId: codexChatSessions.activeTurnId,
          error: codexChatSessions.error,
          updatedAt: codexChatSessions.updatedAt,
        })
        .from(codexChatSessions)
        .where(
          and(
            eq(codexChatSessions.userWorkosId, input.userWorkosId),
            eq(codexChatSessions.chatSessionId, input.sessionId),
          ),
        )
        .limit(1);
      return runtime
        ? {
            status: runtime.status,
            activeTurnId: runtime.activeTurnId,
            error: runtime.error,
            updatedAt: runtime.updatedAt.toISOString(),
          }
        : null;
    },

    async listMessages(sessionId) {
      const messages = await db
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
        .where(eq(chatMessages.sessionId, sessionId))
        .orderBy(asc(chatMessages.createdAt));
      return messages.toSorted(compareChatMessageOrder);
    },

    async insertMessage(input) {
      const now = new Date();
      const insert = db.insert(chatMessages).values({
        id: input.id ?? newChatMessageId(),
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
            target: chatMessages.id,
            set: {
              content: input.content,
              taskId: input.taskId ?? null,
              debugTrace: input.debugTrace ?? null,
              updatedAt: now,
            },
            setWhere: sql`${chatMessages.sessionId} = ${input.sessionId} and ${chatMessages.role} = 'assistant'`,
          })
        : insert
      ).returning();
      if (!message) throw new Error("Unable to create chat message.");
      return message;
    },

    async touchSession(input) {
      await db
        .update(chatSessions)
        .set({ updatedAt: input.now })
        .where(eq(chatSessions.id, input.sessionId));
    },

    async markSessionSeen(input) {
      const [session] = await db
        .update(chatSessions)
        .set({
          lastSeenAt: sql`GREATEST(COALESCE(${chatSessions.lastSeenAt}, '-infinity'::timestamptz), ${input.seenAt})`,
        })
        .where(
          and(
            eq(chatSessions.id, input.sessionId),
            eq(chatSessions.userWorkosId, input.userWorkosId),
            eq(chatSessions.kind, "chat"),
            isNull(chatSessions.closedAt),
          ),
        )
        .returning({ id: chatSessions.id });
      return Boolean(session);
    },

    async closeSession(input) {
      const [session] = await db
        .update(chatSessions)
        .set({ closedAt: input.now, updatedAt: input.now })
        .where(
          and(
            eq(chatSessions.id, input.sessionId),
            eq(chatSessions.userWorkosId, input.userWorkosId),
            eq(chatSessions.kind, "chat"),
            isNull(chatSessions.closedAt),
          ),
        )
        .returning({ id: chatSessions.id });
      return Boolean(session);
    },

    async reopenSession(input) {
      const [session] = await db
        .update(chatSessions)
        .set({ closedAt: null, updatedAt: input.now })
        .where(
          and(
            eq(chatSessions.id, input.sessionId),
            eq(chatSessions.userWorkosId, input.userWorkosId),
            eq(chatSessions.kind, "chat"),
            isNotNull(chatSessions.closedAt),
          ),
        )
        .returning({ id: chatSessions.id });
      return Boolean(session);
    },

    async setSessionPinned(input) {
      const pinCount = db
        .select({ count: sql<number>`count(*)::integer` })
        .from(chatSessions)
        .where(
          and(
            eq(chatSessions.userWorkosId, input.userWorkosId),
            eq(chatSessions.kind, "chat"),
            ne(chatSessions.id, input.sessionId),
            isNull(chatSessions.closedAt),
            isNotNull(chatSessions.pinnedAt),
          ),
        );
      const pinCapacity = sql`(${pinCount}) < ${PINNED_CHAT_LIMIT}`;

      // The web app uses neon-http, which cannot hold an interactive transaction
      // open across a callback. Its batch API still executes these statements in
      // one transaction. Locking the owner serializes concurrent cap checks.
      const [owners, sessions] = await db.batch([
        db
          .select({ workosUserId: users.workosUserId })
          .from(users)
          .where(eq(users.workosUserId, input.userWorkosId))
          .limit(1)
          .for("update"),
        db
          .update(chatSessions)
          .set({ pinnedAt: input.pinned ? input.now : null })
          .where(
            and(
              eq(chatSessions.id, input.sessionId),
              eq(chatSessions.userWorkosId, input.userWorkosId),
              eq(chatSessions.kind, "chat"),
              isNull(chatSessions.closedAt),
              ...(input.pinned ? [pinCapacity] : []),
            ),
          )
          .returning({ id: chatSessions.id }),
      ] as const);

      return Boolean(owners[0] && sessions[0]);
    },
  };
}

export function newChatMessageId() {
  return `goat_chat_msg_${randomUUID()}`;
}

function toChatSessionView(
  session: ChatSession,
  messages: readonly StoredChatMessage[],
  codexComposerSettings: ReturnType<typeof codexComposerSettingsFromTurnSettings> | null = null,
  codexRuntime: CodexRuntimeView | null = null,
): ChatSessionView {
  return {
    id: session.id,
    title: session.title,
    model: session.model,
    engine: session.engine,
    codexComposerSettings,
    codexRuntime,
    messages: messages.map(toChatUiMessage),
  };
}

function toChatSummaryView(
  session: ChatSession,
  messages: readonly StoredChatMessage[],
  codexComposerSettings: ReturnType<typeof codexComposerSettingsFromTurnSettings> | null = null,
  codexRuntime: CodexRuntimeView | null = null,
): ChatSummaryView {
  return {
    id: session.id,
    title: session.title,
    model: session.model,
    engine: session.engine,
    codexComposerSettings,
    codexRuntime,
    preview: previewFromMessages(messages),
    updatedAt: session.updatedAt.toISOString(),
    lastSeenAt: session.lastSeenAt?.toISOString() ?? null,
    state: deriveChatState({
      updatedAt: session.updatedAt.toISOString(),
      lastSeenAt: session.lastSeenAt?.toISOString() ?? null,
      codexRuntime,
    }),
    pinnedAt: session.pinnedAt?.toISOString() ?? null,
  };
}

async function loadCodexComposerSettingsForChatSession(input: {
  store: ChatStore;
  userWorkosId: string;
  session: ChatSession;
}) {
  if (input.session.engine !== "codex" && input.session.engine !== "claude_code") return null;
  const settings = await input.store.loadLatestCodexTurnSettings?.({
    userWorkosId: input.userWorkosId,
    sessionId: input.session.id,
  });
  return settings
    ? codexComposerSettingsFromTurnSettings(
        settings,
        input.session.engine === "claude_code" ? DEFAULT_CLAUDE_CHAT_REASONING_EFFORT : undefined,
      )
    : null;
}

async function loadCodexRuntimeForChatSession(input: {
  store: ChatStore;
  userWorkosId: string;
  session: ChatSession;
}) {
  return (
    (await input.store.loadCodexRuntime?.({
      userWorkosId: input.userWorkosId,
      sessionId: input.session.id,
    })) ?? null
  );
}

function previewFromMessages(messages: readonly Pick<StoredChatMessage, "content">[]) {
  const content =
    messages
      .toReversed()
      .map((message) => message.content.replace(/\s+/g, " ").trim())
      .find(Boolean) ?? "No messages yet.";

  if (content.length <= CHAT_PREVIEW_MAX_LENGTH) return content;
  return `${content.slice(0, CHAT_PREVIEW_MAX_LENGTH - 1).trimEnd()}...`;
}

async function findOrCreateOpenSession(input: {
  store: ChatStore;
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
  return toTaskTitle(title ?? firstAttachmentName ?? "New chat");
}

function toStoredChatMessage(message: ChatMessage): StoredChatMessage {
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

function newChatSessionId() {
  return `goat_chat_${randomUUID()}`;
}
