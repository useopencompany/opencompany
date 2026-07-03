import type { GoatChatSession } from "@opencompany/db/goat-schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeGoatChatSessionForUser,
  createGoatChatUserTurn,
  type GoatChatStore,
  persistGoatChatAssistantMessage,
  textFromGoatChatUiMessage,
} from "@/lib/chat";
import { OPENCOMPANY_CHAT_DEBUG_SCHEMA_VERSION } from "@/lib/chat-agent";
import { START_TASK_TOOL_NAME } from "@/lib/chat-ui";
import { DEFAULT_GOAT_MODEL } from "@/lib/model-options";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  currentGoatUser: vi.fn(),
}));

type StoredChatMessage = Awaited<ReturnType<GoatChatStore["listMessages"]>>[number];

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
      debugTrace: {
        schemaVersion: OPENCOMPANY_CHAT_DEBUG_SCHEMA_VERSION,
        model: DEFAULT_GOAT_MODEL,
        finishReason: "stop",
      },
    });
  });
});

function createInMemoryChatStore(
  options: { tasks?: Record<string, { displayId: string; name: string; prompt: string }> } = {},
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

    async createSession(input) {
      const now = new Date();
      const session: GoatChatSession = {
        id: `session_${++sessionCount}`,
        userWorkosId: input.userWorkosId,
        title: input.title,
        model: input.model,
        closedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      sessions.push(session);
      return session;
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
        createdAt: now,
        updatedAt: now,
        taskDisplayId: task?.displayId ?? null,
        taskName: task?.name ?? null,
        taskPrompt: task?.prompt ?? null,
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
  };

  return { store, sessions, messages };
}
