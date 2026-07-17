import type {
  GoatChatSession,
  GoatCodexChatTurnSettings,
  GoatTaskStatus,
} from "@opencompany/db/goat-schema";
import { drizzle } from "drizzle-orm/neon-http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeGoatChatSessionForUser,
  createDbGoatChatStore,
  createGoatChatUserTurn,
  type GoatChatStore,
  listRecentGoatChatsForUser,
  loadGoatChatSessionByIdForUser,
  persistGoatChatAssistantMessage,
  setGoatChatSessionPinnedForUser,
  textFromGoatChatUiMessage,
} from "@/lib/chat";
import { OPENCOMPANY_CHAT_DEBUG_SCHEMA_VERSION } from "@/lib/chat-agent";
import {
  GOAT_PINNED_CHAT_LIMIT,
  type GoatCodexRuntimeView,
  START_TASK_TOOL_NAME,
} from "@/lib/chat-ui";
import { DEFAULT_GOAT_MODEL } from "@/lib/model-options";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  currentGoatUser: vi.fn(),
}));

type StoredChatMessage = Awaited<ReturnType<GoatChatStore["listMessages"]>>[number];

describe("createDbGoatChatStore", () => {
  it("loads active Codex sessions outside the recent-chat limit", async () => {
    const query = vi.fn(async (...[statement, params]: [string, unknown[], object]) => {
      void statement;
      void params;
      return { rows: [] };
    });
    const client = Object.assign(query, {
      transaction: vi.fn(async (queries: Promise<unknown>[]) => Promise.all(queries)),
    });
    const store = createDbGoatChatStore(drizzle(client as never) as never);

    await store.listOpenSessions({
      userWorkosId: "user_1",
      limit: 8,
      updatedAfter: new Date("2026-07-16T12:00:00.000Z"),
    });

    const activeQuery = query.mock.calls.find(([statement]) =>
      statement.includes('"goat"."codex_chat_sessions"'),
    );
    expect(activeQuery).toBeDefined();
    expect(activeQuery?.[0]).toContain("exists");
    expect(activeQuery?.[0]).not.toContain("limit");
    expect(activeQuery?.[1]).toEqual(expect.arrayContaining(["user_1", "starting", "running"]));
  });

  it.each([
    { pinned: true, expectedPinnedAt: "2026-07-14T17:15:00.000Z", checksCapacity: true },
    { pinned: false, expectedPinnedAt: null, checksCapacity: false },
  ])("persists pinned=$pinned through a neon-http transactional batch", async ({
    pinned,
    expectedPinnedAt,
    checksCapacity,
  }) => {
    const transaction = vi.fn(async (queries: Promise<unknown>[]) => Promise.all(queries));
    const query = vi.fn(async (...[statement]: [string, unknown[], object]) => ({
      rows: statement.startsWith("select") ? [["user_1"]] : [["chat_1"]],
    }));
    const client = Object.assign(query, { transaction });
    const db = drizzle(client as never);
    const store = createDbGoatChatStore(db as never);

    await expect(
      store.setSessionPinned({
        userWorkosId: "user_1",
        sessionId: "chat_1",
        pinned,
        now: new Date("2026-07-14T17:15:00.000Z"),
      }),
    ).resolves.toBe(true);

    expect(transaction).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledTimes(2);
    const [lockStatement] = query.mock.calls[0]!;
    const [updateStatement, updateParams] = query.mock.calls[1]!;
    expect(lockStatement).toContain('from "goat"."users"');
    expect(lockStatement).toContain("for update");
    expect(updateStatement).toContain('update "goat"."chat_sessions"');
    expect(updateStatement.includes("count(*)::integer")).toBe(checksCapacity);
    expect(updateParams).toEqual(expect.arrayContaining([expectedPinnedAt, "chat_1", "user_1"]));
  });

  it("returns false when the batch does not update the requested chat", async () => {
    const transaction = vi.fn(async (queries: Promise<unknown>[]) => Promise.all(queries));
    const query = vi.fn(async (...[statement]: [string, unknown[], object]) => ({
      rows: statement.startsWith("select") ? [["user_1"]] : [],
    }));
    const client = Object.assign(query, { transaction });
    const store = createDbGoatChatStore(drizzle(client as never) as never);

    await expect(
      store.setSessionPinned({
        userWorkosId: "user_1",
        sessionId: "missing_chat",
        pinned: true,
        now: new Date("2026-07-14T17:15:00.000Z"),
      }),
    ).resolves.toBe(false);
  });
});

describe("createGoatChatUserTurn", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("creates a chat session and persists the user message immediately", async () => {
    const { store, sessions, messages } = createInMemoryChatStore();

    const result = await createGoatChatUserTurn(
      {
        userWorkosId: "user_1",
        prompt: "what do you think of x?",
        model: DEFAULT_GOAT_MODEL,
        messageId: "ui_user_1",
      },
      store,
    );

    expect(result.session.id).toBe(sessions[0]?.id);
    expect(sessions).toHaveLength(1);
    expect(messages.map((message) => [message.id, message.role, message.content])).toEqual([
      ["ui_user_1", "user", "what do you think of x?"],
    ]);
    expect(
      result.messages.map((message) => [message.role, textFromGoatChatUiMessage(message)]),
    ).toEqual([["user", "what do you think of x?"]]);
  });

  it("reuses an existing open session when a session id is provided", async () => {
    const { store, sessions, messages } = createInMemoryChatStore();

    const first = await createGoatChatUserTurn(
      { userWorkosId: "user_1", prompt: "hello", model: DEFAULT_GOAT_MODEL },
      store,
    );
    const second = await createGoatChatUserTurn(
      {
        userWorkosId: "user_1",
        prompt: "continue",
        model: DEFAULT_GOAT_MODEL,
        sessionId: first.session.id,
      },
      store,
    );

    expect(sessions).toHaveLength(1);
    expect(second.session.id).toBe(first.session.id);
    expect(messages.map((message) => [message.sessionId, message.role, message.content])).toEqual([
      [first.session.id, "user", "hello"],
      [first.session.id, "user", "continue"],
    ]);
    expect(second.messages.map((message) => textFromGoatChatUiMessage(message))).toEqual([
      "hello",
      "continue",
    ]);
  });

  it("creates a new session when no session id is provided", async () => {
    const { store, sessions } = createInMemoryChatStore();

    const first = await createGoatChatUserTurn(
      { userWorkosId: "user_1", prompt: "hello", model: DEFAULT_GOAT_MODEL },
      store,
    );
    const second = await createGoatChatUserTurn(
      { userWorkosId: "user_1", prompt: "new topic", model: DEFAULT_GOAT_MODEL },
      store,
    );

    expect(sessions).toHaveLength(2);
    expect(second.session.id).not.toBe(first.session.id);
  });

  it("creates a new session after the current session is closed", async () => {
    const { store, sessions } = createInMemoryChatStore();

    const first = await createGoatChatUserTurn(
      { userWorkosId: "user_1", prompt: "hello", model: DEFAULT_GOAT_MODEL },
      store,
    );
    const closed = await closeGoatChatSessionForUser(
      { userWorkosId: "user_1", sessionId: first.session.id },
      store,
    );
    const second = await createGoatChatUserTurn(
      { userWorkosId: "user_1", prompt: "new thread", model: DEFAULT_GOAT_MODEL },
      store,
    );

    expect(closed).toBe(true);
    expect(sessions).toHaveLength(2);
    expect(second.session.id).not.toBe(first.session.id);
    expect(sessions.find((session) => session.id === first.session.id)?.closedAt).toBeInstanceOf(
      Date,
    );
  });
});

describe("persistGoatChatAssistantMessage", () => {
  it("stores final assistant text, task linkage, and debug metadata", async () => {
    const { store, messages } = createInMemoryChatStore({
      tasks: {
        task_1: {
          displayId: "TASK-1",
          name: "Market research for x",
          prompt: "Research the market for x",
          status: "running",
        },
      },
    });
    const turn = await createGoatChatUserTurn(
      {
        userWorkosId: "user_1",
        prompt: "research x",
        model: DEFAULT_GOAT_MODEL,
      },
      store,
    );

    await persistGoatChatAssistantMessage(
      {
        sessionId: turn.session.id,
        messageId: "assistant_1",
        content: "I started a task and added it to Results.",
        taskId: "task_1",
        debugTrace: {
          schemaVersion: OPENCOMPANY_CHAT_DEBUG_SCHEMA_VERSION,
          model: DEFAULT_GOAT_MODEL,
          finishReason: "stop",
          toolCalls: [{ toolName: START_TASK_TOOL_NAME }],
          toolResults: [{ taskId: "task_1" }],
        },
      },
      store,
    );

    expect(messages.at(-1)).toMatchObject({
      id: "assistant_1",
      role: "assistant",
      content: "I started a task and added it to Results.",
      taskId: "task_1",
      taskDisplayId: "TASK-1",
      taskName: "Market research for x",
      taskStatus: "running",
      debugTrace: {
        schemaVersion: OPENCOMPANY_CHAT_DEBUG_SCHEMA_VERSION,
        model: DEFAULT_GOAT_MODEL,
        finishReason: "stop",
      },
    });
  });
});

describe("Goat chat history helpers", () => {
  it("lists recent open chats for one user and excludes closed sessions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-04T12:30:00.000Z"));
    const { store, sessions } = createInMemoryChatStore();
    try {
      const first = await createGoatChatUserTurn(
        { userWorkosId: "user_1", prompt: "first chat", model: DEFAULT_GOAT_MODEL },
        store,
      );
      const second = await createGoatChatUserTurn(
        { userWorkosId: "user_1", prompt: "second chat", model: DEFAULT_GOAT_MODEL },
        store,
      );
      const old = await createGoatChatUserTurn(
        { userWorkosId: "user_1", prompt: "old chat", model: DEFAULT_GOAT_MODEL },
        store,
      );
      await createGoatChatUserTurn(
        { userWorkosId: "user_2", prompt: "other user chat", model: DEFAULT_GOAT_MODEL },
        store,
      );
      await closeGoatChatSessionForUser(
        { userWorkosId: "user_1", sessionId: first.session.id },
        store,
      );
      sessions.find((session) => session.id === second.session.id)!.updatedAt = new Date(
        "2026-07-04T12:00:00.000Z",
      );
      sessions.find((session) => session.id === old.session.id)!.updatedAt = new Date(
        "2026-07-02T12:00:00.000Z",
      );

      const summaries = await listRecentGoatChatsForUser(
        { userWorkosId: "user_1", limit: 8 },
        store,
      );

      expect(summaries.map((summary) => summary.id)).toEqual([second.session.id]);
      expect(summaries[0]).toMatchObject({
        title: "Second chat",
        preview: "second chat",
        updatedAt: "2026-07-04T12:00:00.000Z",
        pinnedAt: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps pinned chats listed even outside the recency window until unpinned", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-04T12:30:00.000Z"));
    const { store, sessions } = createInMemoryChatStore();
    try {
      const recent = await createGoatChatUserTurn(
        { userWorkosId: "user_1", prompt: "recent chat", model: DEFAULT_GOAT_MODEL },
        store,
      );
      const old = await createGoatChatUserTurn(
        { userWorkosId: "user_1", prompt: "old pinned chat", model: DEFAULT_GOAT_MODEL },
        store,
      );
      sessions.find((session) => session.id === old.session.id)!.updatedAt = new Date(
        "2026-07-01T12:00:00.000Z",
      );

      await expect(
        setGoatChatSessionPinnedForUser(
          { userWorkosId: "user_1", sessionId: old.session.id, pinned: true },
          store,
        ),
      ).resolves.toBe(true);

      const summaries = await listRecentGoatChatsForUser(
        { userWorkosId: "user_1", limit: 8 },
        store,
      );
      expect(summaries.map((summary) => summary.id)).toEqual([old.session.id, recent.session.id]);
      expect(summaries[0]).toMatchObject({
        title: "Old pinned chat",
        pinnedAt: "2026-07-04T12:30:00.000Z",
      });

      await expect(
        setGoatChatSessionPinnedForUser(
          { userWorkosId: "user_1", sessionId: old.session.id, pinned: false },
          store,
        ),
      ).resolves.toBe(true);
      const afterUnpin = await listRecentGoatChatsForUser(
        { userWorkosId: "user_1", limit: 8 },
        store,
      );
      expect(afterUnpin.map((summary) => summary.id)).toEqual([recent.session.id]);

      // Other users' sessions are not pinnable.
      await expect(
        setGoatChatSessionPinnedForUser(
          { userWorkosId: "user_2", sessionId: old.session.id, pinned: true },
          store,
        ),
      ).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds pinned chat hydration and rejects pins beyond the limit", async () => {
    const { store, sessions } = createInMemoryChatStore();
    const candidate = await createGoatChatUserTurn(
      { userWorkosId: "user_1", prompt: "candidate", model: DEFAULT_GOAT_MODEL },
      store,
    );
    const now = new Date();
    for (let index = 0; index < GOAT_PINNED_CHAT_LIMIT + 1; index += 1) {
      sessions.push({
        ...candidate.session,
        id: `pinned_${index}`,
        title: `Pinned ${index}`,
        pinnedAt: new Date(now.getTime() + index),
      });
    }

    const summaries = await listRecentGoatChatsForUser({ userWorkosId: "user_1", limit: 8 }, store);
    expect(summaries.filter((summary) => summary.pinnedAt)).toHaveLength(GOAT_PINNED_CHAT_LIMIT);
    await expect(
      setGoatChatSessionPinnedForUser(
        { userWorkosId: "user_1", sessionId: candidate.session.id, pinned: true },
        store,
      ),
    ).resolves.toBe(false);
  });

  it("keeps concurrent pin requests within the per-user limit", async () => {
    const { store, sessions } = createInMemoryChatStore();
    const first = await createGoatChatUserTurn(
      { userWorkosId: "user_1", prompt: "first candidate", model: DEFAULT_GOAT_MODEL },
      store,
    );
    const second = await createGoatChatUserTurn(
      { userWorkosId: "user_1", prompt: "second candidate", model: DEFAULT_GOAT_MODEL },
      store,
    );
    const now = new Date();
    for (let index = 0; index < GOAT_PINNED_CHAT_LIMIT - 1; index += 1) {
      sessions.push({
        ...first.session,
        id: `existing_pin_${index}`,
        title: `Existing pin ${index}`,
        pinnedAt: new Date(now.getTime() + index),
      });
    }

    const results = await Promise.all([
      setGoatChatSessionPinnedForUser(
        { userWorkosId: "user_1", sessionId: first.session.id, pinned: true },
        store,
      ),
      setGoatChatSessionPinnedForUser(
        { userWorkosId: "user_1", sessionId: second.session.id, pinned: true },
        store,
      ),
    ]);

    expect(results).toEqual([true, false]);
    expect(sessions.filter((session) => session.pinnedAt)).toHaveLength(GOAT_PINNED_CHAT_LIMIT);
    await expect(
      setGoatChatSessionPinnedForUser(
        { userWorkosId: "user_1", sessionId: first.session.id, pinned: true },
        store,
      ),
    ).resolves.toBe(true);
  });

  it("loads only the requested user's open chat", async () => {
    const { store } = createInMemoryChatStore();
    const own = await createGoatChatUserTurn(
      { userWorkosId: "user_1", prompt: "mine", model: DEFAULT_GOAT_MODEL },
      store,
    );
    const other = await createGoatChatUserTurn(
      { userWorkosId: "user_2", prompt: "not mine", model: DEFAULT_GOAT_MODEL },
      store,
    );

    await expect(
      loadGoatChatSessionByIdForUser({ userWorkosId: "user_1", sessionId: own.session.id }, store),
    ).resolves.toMatchObject({ id: own.session.id });
    await expect(
      loadGoatChatSessionByIdForUser(
        { userWorkosId: "user_1", sessionId: other.session.id },
        store,
      ),
    ).resolves.toBeNull();
  });

  it("includes latest Codex composer settings on loaded and recent chats", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-04T12:30:00.000Z"));
    const { store, sessions } = createInMemoryChatStore({
      codexSettingsBySessionId: {
        goat_chat_codex_1: {
          reasoningEffort: "high",
          planModeReasoningEffort: "high",
          goalMode: { objective: "Ship the fix", tokenBudget: 200000 },
        },
      },
      codexRuntimeBySessionId: {
        goat_chat_codex_1: {
          status: "idle",
          error: null,
          updatedAt: "2026-07-04T12:15:00.000Z",
        },
      },
    });
    try {
      const now = new Date("2026-07-04T12:00:00.000Z");
      sessions.push({
        id: "goat_chat_codex_1",
        userWorkosId: "user_1",
        title: "Codex chat",
        model: DEFAULT_GOAT_MODEL,
        engine: "codex",
        closedAt: null,
        pinnedAt: null,
        createdAt: now,
        updatedAt: now,
      });

      await expect(
        loadGoatChatSessionByIdForUser(
          { userWorkosId: "user_1", sessionId: "goat_chat_codex_1" },
          store,
        ),
      ).resolves.toMatchObject({
        codexComposerSettings: {
          reasoningEffort: "high",
          planModeEnabled: true,
          goalMode: { objective: "Ship the fix", tokenBudget: 200000 },
        },
        codexRuntime: {
          status: "idle",
          error: null,
          updatedAt: "2026-07-04T12:15:00.000Z",
        },
      });

      const summaries = await listRecentGoatChatsForUser(
        { userWorkosId: "user_1", limit: 8 },
        store,
      );
      expect(summaries[0]).toMatchObject({
        id: "goat_chat_codex_1",
        codexComposerSettings: {
          reasoningEffort: "high",
          planModeEnabled: true,
          goalMode: { objective: "Ship the fix", tokenBudget: 200000 },
        },
        codexRuntime: {
          status: "idle",
          error: null,
          updatedAt: "2026-07-04T12:15:00.000Z",
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

function createInMemoryChatStore(
  options: {
    tasks?: Record<
      string,
      { displayId: string; name: string; prompt: string; status: GoatTaskStatus }
    >;
    codexSettingsBySessionId?: Record<string, GoatCodexChatTurnSettings | null>;
    codexRuntimeBySessionId?: Record<string, GoatCodexRuntimeView | null>;
  } = {},
) {
  const sessions: GoatChatSession[] = [];
  const messages: StoredChatMessage[] = [];
  let sessionCount = 0;
  let messageCount = 0;

  const store: GoatChatStore = {
    async findOpenSession(input) {
      const openSessions = sessions.filter(
        (session) => session.userWorkosId === input.userWorkosId && !session.closedAt,
      );
      if (input.sessionId) {
        return openSessions.find((session) => session.id === input.sessionId) ?? null;
      }
      return (
        openSessions.toSorted((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0] ?? null
      );
    },

    async listOpenSessions(input) {
      const open = sessions.filter(
        (session) => session.userWorkosId === input.userWorkosId && !session.closedAt,
      );
      const pinned = open
        .filter((session) => session.pinnedAt)
        .toSorted((a, b) => (b.pinnedAt?.getTime() ?? 0) - (a.pinnedAt?.getTime() ?? 0))
        .slice(0, GOAT_PINNED_CHAT_LIMIT);
      const recent = open
        .filter((session) => !session.pinnedAt)
        .filter((session) =>
          input.updatedAfter ? session.updatedAt.getTime() >= input.updatedAfter.getTime() : true,
        )
        .toSorted((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
        .slice(0, input.limit);
      return [...pinned, ...recent];
    },

    async createSession(input) {
      const now = new Date();
      const session: GoatChatSession = {
        id: `session_${++sessionCount}`,
        userWorkosId: input.userWorkosId,
        title: input.title,
        model: input.model,
        engine: "opencompany",
        closedAt: null,
        pinnedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      sessions.push(session);
      return session;
    },

    async loadLatestCodexTurnSettings(input) {
      return options.codexSettingsBySessionId?.[input.sessionId] ?? null;
    },

    async loadCodexRuntime(input) {
      return options.codexRuntimeBySessionId?.[input.sessionId] ?? null;
    },

    async listMessages(sessionId) {
      return messages.filter((message) => message.sessionId === sessionId);
    },

    async insertMessage(input) {
      const now = new Date();
      const task = options.tasks?.[input.taskId ?? ""];
      const message: StoredChatMessage = {
        id: input.id ?? `message_${++messageCount}`,
        sessionId: input.sessionId,
        role: input.role,
        content: input.content,
        taskId: input.taskId ?? null,
        debugTrace: input.debugTrace ?? null,
        attachments: input.attachments ?? null,
        attachmentTexts: input.attachmentTexts ?? null,
        createdAt: now,
        updatedAt: now,
        taskDisplayId: task?.displayId ?? null,
        taskName: task?.name ?? null,
        taskPrompt: task?.prompt ?? null,
        taskStatus: task?.status ?? null,
      };
      messages.push(message);
      return message;
    },

    async touchSession(input) {
      const session = sessions.find((item) => item.id === input.sessionId);
      if (session) {
        session.updatedAt = input.now;
      }
    },

    async closeSession(input) {
      const session = sessions.find(
        (item) =>
          item.id === input.sessionId && item.userWorkosId === input.userWorkosId && !item.closedAt,
      );
      if (!session) return false;
      session.closedAt = input.now;
      session.updatedAt = input.now;
      return true;
    },

    async setSessionPinned(input) {
      const session = sessions.find(
        (item) =>
          item.id === input.sessionId && item.userWorkosId === input.userWorkosId && !item.closedAt,
      );
      if (!session) return false;
      if (
        input.pinned &&
        !session.pinnedAt &&
        sessions.filter(
          (item) =>
            item.userWorkosId === input.userWorkosId && !item.closedAt && Boolean(item.pinnedAt),
        ).length >= GOAT_PINNED_CHAT_LIMIT
      ) {
        return false;
      }
      session.pinnedAt = input.pinned ? input.now : null;
      return true;
    },
  };

  return { store, sessions, messages };
}
