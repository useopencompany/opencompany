import type {
  GoatChatMessageAttachment,
  GoatChatMessageDebugTrace,
  GoatChatSession,
  GoatCodexChatTurnSettings,
  GoatTaskStatus,
} from "@opencompany/db/goat-schema";
import { convertToModelMessages } from "ai";
import { drizzle } from "drizzle-orm/neon-http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeGoatChatSessionForUser,
  createDbGoatChatStore,
  createGoatChatApprovalContinuationTurn,
  createGoatChatUserTurn,
  type GoatChatStore,
  type GoatChatUiMessage,
  listRecentGoatChatsForUser,
  loadGoatChatSessionByIdForUser,
  markGoatChatSessionSeenForUser,
  persistGoatChatAssistantMessage,
  setGoatChatSessionPinnedForUser,
  settleStaleGoatChatToolCalls,
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
    expect(activeQuery?.[0]).toContain('"active_turn_id" is not null');
    expect(activeQuery?.[0]).not.toContain("limit");
    expect(activeQuery?.[1]).toEqual(
      expect.arrayContaining([
        "user_1",
        "queued",
        "starting",
        "running",
        "failed",
        "interrupted",
        "closed",
      ]),
    );
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

  it("persists a client-reserved id for an optimistic new-chat route", async () => {
    const { store, sessions } = createInMemoryChatStore();
    const newSessionId = "goat_chat_123e4567-e89b-42d3-a456-426614174000";

    const result = await createGoatChatUserTurn(
      {
        userWorkosId: "user_1",
        prompt: "open this chat immediately",
        model: DEFAULT_GOAT_MODEL,
        newSessionId,
      },
      store,
    );

    expect(result.session.id).toBe(newSessionId);
    expect(sessions[0]?.id).toBe(newSessionId);
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

  it("preserves the stored model and attachment context across a follow-up", async () => {
    const { store, messages } = createInMemoryChatStore();
    const attachment: GoatChatMessageAttachment = {
      id: "attachment_1",
      kind: "pdf",
      mediaType: "application/pdf",
      filename: "launch-plan.pdf",
      sizeBytes: 2048,
      blobPathname: "private/launch-plan.pdf",
      blobUrl: "https://blob.invalid/launch-plan.pdf",
    };
    const first = await createGoatChatUserTurn(
      {
        userWorkosId: "user_1",
        prompt: "Review this plan",
        model: DEFAULT_GOAT_MODEL,
        attachments: [attachment],
        attachmentTexts: { attachment_1: "Private extracted launch context" },
      },
      store,
    );

    const followUp = await createGoatChatUserTurn(
      {
        userWorkosId: "user_1",
        sessionId: first.session.id,
        prompt: "What is the biggest risk?",
        model: "openai/gpt-5.5",
      },
      store,
    );

    expect(followUp.session.model).toBe(DEFAULT_GOAT_MODEL);
    expect(messages[0]).toMatchObject({
      attachments: [attachment],
      attachmentTexts: { attachment_1: "Private extracted launch context" },
    });
    expect(followUp.messages.map((message) => textFromGoatChatUiMessage(message))).toEqual([
      "Review this plan",
      "What is the biggest risk?",
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

function pendingApprovalPart(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "tool-use_action",
    toolCallId: "call_1",
    state: "approval-requested",
    input: { action: "google_calendar.create_event", params: { summary: "Sync" } },
    approval: { id: "appr_1" },
    ...overrides,
  };
}

function assistantApprovalTrace(parts: unknown[]): GoatChatMessageDebugTrace {
  return {
    schemaVersion: OPENCOMPANY_CHAT_DEBUG_SCHEMA_VERSION,
    model: DEFAULT_GOAT_MODEL,
    uiMessageParts: parts,
  };
}

async function seedTurnAwaitingApproval(store: GoatChatStore, parts: unknown[]) {
  const turn = await createGoatChatUserTurn(
    { userWorkosId: "user_1", prompt: "add my sync", model: DEFAULT_GOAT_MODEL },
    store,
  );
  const assistant = await persistGoatChatAssistantMessage(
    {
      sessionId: turn.session.id,
      messageId: "assistant_1",
      content: "",
      debugTrace: assistantApprovalTrace(parts),
    },
    store,
  );
  return { turn, assistant };
}

describe("createGoatChatApprovalContinuationTurn", () => {
  it("merges only the approval decision, denies unanswered requests, and persists", async () => {
    const { store, messages } = createInMemoryChatStore();
    const { turn } = await seedTurnAwaitingApproval(store, [
      pendingApprovalPart(),
      pendingApprovalPart({ toolCallId: "call_2", approval: { id: "appr_2" } }),
    ]);

    const result = await createGoatChatApprovalContinuationTurn(
      {
        userWorkosId: "user_1",
        sessionId: turn.session.id,
        message: {
          id: "assistant_1",
          role: "assistant",
          parts: [
            pendingApprovalPart({
              state: "approval-responded",
              approval: { id: "appr_1", approved: true },
              // A tampered client input must not survive the merge.
              input: { action: "google_calendar.create_event", params: { summary: "HACKED" } },
            }),
          ],
        } as unknown as GoatChatUiMessage,
      },
      store,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.respondedApprovals).toEqual([
      {
        approvalId: "appr_1",
        toolCallId: "call_1",
        action: "google_calendar.create_event",
        approved: true,
      },
    ]);
    expect(result.lastUserMessage?.content).toBe("add my sync");

    const persisted = messages.find((message) => message.id === "assistant_1");
    const parts = persisted?.debugTrace?.uiMessageParts as Array<Record<string, unknown>>;
    expect(parts[0]).toMatchObject({
      state: "approval-responded",
      approval: { id: "appr_1", approved: true },
      input: { params: { summary: "Sync" } },
    });
    expect(parts[1]).toMatchObject({
      state: "output-denied",
      approval: { id: "appr_2", approved: false },
    });
  });

  it("only continues the latest assistant message", async () => {
    const { store, turnFollowUp } = await (async () => {
      const memory = createInMemoryChatStore();
      const { turn } = await seedTurnAwaitingApproval(memory.store, [pendingApprovalPart()]);
      // A newer user message makes assistant_1 stale.
      const followUp = await createGoatChatUserTurn(
        {
          userWorkosId: "user_1",
          prompt: "actually nevermind",
          model: DEFAULT_GOAT_MODEL,
          sessionId: turn.session.id,
        },
        memory.store,
      );
      return { store: memory.store, turnFollowUp: followUp };
    })();

    const result = await createGoatChatApprovalContinuationTurn(
      {
        userWorkosId: "user_1",
        sessionId: turnFollowUp.session.id,
        message: {
          id: "assistant_1",
          role: "assistant",
          parts: [],
        } as unknown as GoatChatUiMessage,
      },
      store,
    );
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("latest") });
  });

  it("rejects when there is nothing pending and when the session is unknown", async () => {
    const { store } = createInMemoryChatStore();
    const { turn } = await seedTurnAwaitingApproval(store, [
      pendingApprovalPart({ state: "output-available", output: { ok: true } }),
    ]);

    const noPending = await createGoatChatApprovalContinuationTurn(
      {
        userWorkosId: "user_1",
        sessionId: turn.session.id,
        message: {
          id: "assistant_1",
          role: "assistant",
          parts: [],
        } as unknown as GoatChatUiMessage,
      },
      store,
    );
    expect(noPending).toMatchObject({ ok: false, error: expect.stringContaining("pending") });

    const wrongSession = await createGoatChatApprovalContinuationTurn(
      {
        userWorkosId: "user_1",
        sessionId: "missing",
        message: {
          id: "assistant_1",
          role: "assistant",
          parts: [],
        } as unknown as GoatChatUiMessage,
      },
      store,
    );
    expect(wrongSession).toMatchObject({ ok: false, error: expect.stringContaining("not found") });
  });
});

describe("settleStaleGoatChatToolCalls", () => {
  it("denies pending approvals the user talked past and persists the rewrite", async () => {
    const { store, messages } = createInMemoryChatStore();
    const { turn } = await seedTurnAwaitingApproval(store, [pendingApprovalPart()]);
    const followUp = await createGoatChatUserTurn(
      {
        userWorkosId: "user_1",
        prompt: "different question",
        model: DEFAULT_GOAT_MODEL,
        sessionId: turn.session.id,
      },
      store,
    );

    const result = await settleStaleGoatChatToolCalls(followUp, store);
    expect(result.changed).toBe(true);
    expect(result.toolCallIds).toEqual(["call_1"]);

    const persisted = messages.find((message) => message.id === "assistant_1");
    const parts = persisted?.debugTrace?.uiMessageParts as Array<Record<string, unknown>>;
    expect(parts[0]).toMatchObject({
      state: "output-denied",
      approval: {
        id: "appr_1",
        approved: false,
        reason: expect.stringContaining("did not respond"),
      },
    });
  });

  it("repairs an interrupted tool call before the next model turn", async () => {
    const { store, messages } = createInMemoryChatStore();
    const { turn } = await seedTurnAwaitingApproval(store, [
      {
        type: "tool-browser_open",
        toolCallId: "browser_open_12",
        state: "input-available",
        input: { url: "https://example.com" },
      },
    ]);
    const failedFollowUp = await createGoatChatUserTurn(
      {
        userWorkosId: "user_1",
        prompt: "give me results",
        model: DEFAULT_GOAT_MODEL,
        sessionId: turn.session.id,
      },
      store,
    );
    await persistGoatChatAssistantMessage(
      {
        sessionId: turn.session.id,
        messageId: "assistant_failed_1",
        content: "I could not produce a response. Try sending that again.",
        debugTrace: {
          schemaVersion: OPENCOMPANY_CHAT_DEBUG_SCHEMA_VERSION,
          model: DEFAULT_GOAT_MODEL,
          error: "Tool result is missing for tool call browser_open_12.",
        },
      },
      store,
    );
    const followUp = await createGoatChatUserTurn(
      {
        userWorkosId: "user_1",
        prompt: "go",
        model: DEFAULT_GOAT_MODEL,
        sessionId: failedFollowUp.session.id,
      },
      store,
    );

    const result = await settleStaleGoatChatToolCalls(followUp, store);

    expect(result.changed).toBe(true);
    expect(result.toolCallIds).toEqual(["browser_open_12"]);
    const persisted = messages.find((message) => message.id === "assistant_1");
    expect(persisted?.debugTrace?.uiMessageParts).toEqual([
      expect.objectContaining({
        type: "tool-browser_open",
        toolCallId: "browser_open_12",
        state: "output-error",
        input: { url: "https://example.com" },
        errorText: expect.stringContaining("outcome is unknown"),
      }),
    ]);
    const modelMessages = await convertToModelMessages(result.messages);
    expect(modelMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          content: [
            expect.objectContaining({
              type: "tool-result",
              toolCallId: "browser_open_12",
            }),
          ],
        }),
      ]),
    );
  });

  it("drops a partial tool input that cannot be replayed safely", async () => {
    const { store, messages } = createInMemoryChatStore();
    const { turn } = await seedTurnAwaitingApproval(store, [
      {
        type: "tool-browser_open",
        toolCallId: "browser_open_partial",
        state: "input-streaming",
      },
    ]);
    const followUp = await createGoatChatUserTurn(
      {
        userWorkosId: "user_1",
        prompt: "continue",
        model: DEFAULT_GOAT_MODEL,
        sessionId: turn.session.id,
      },
      store,
    );

    const result = await settleStaleGoatChatToolCalls(followUp, store);

    expect(result.changed).toBe(true);
    expect(result.toolCallIds).toEqual(["browser_open_partial"]);
    const persisted = messages.find((message) => message.id === "assistant_1");
    expect(persisted?.debugTrace?.uiMessageParts).toEqual([]);
    await expect(convertToModelMessages(result.messages)).resolves.toBeDefined();
  });

  it("leaves resolved histories untouched", async () => {
    const { store } = createInMemoryChatStore();
    const { turn } = await seedTurnAwaitingApproval(store, [
      pendingApprovalPart({ state: "output-available", output: { ok: true } }),
    ]);
    const result = await settleStaleGoatChatToolCalls(turn, store);
    expect(result.changed).toBe(false);
    expect(result.toolCallIds).toEqual([]);
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

  it("derives done unseen and done seen from the session seen marker", async () => {
    vi.useFakeTimers();
    const { store } = createInMemoryChatStore();
    try {
      vi.setSystemTime(new Date("2026-07-04T12:00:00.000Z"));
      const turn = await createGoatChatUserTurn(
        { userWorkosId: "user_1", prompt: "hello", model: DEFAULT_GOAT_MODEL },
        store,
      );

      vi.setSystemTime(new Date("2026-07-04T12:01:00.000Z"));
      await persistGoatChatAssistantMessage(
        {
          sessionId: turn.session.id,
          content: "Done.",
        },
        store,
      );

      const unseen = await listRecentGoatChatsForUser({ userWorkosId: "user_1", limit: 8 }, store);
      expect(unseen[0]).toMatchObject({
        id: turn.session.id,
        state: "done_unseen",
        lastSeenAt: "2026-07-04T12:00:00.000Z",
        updatedAt: "2026-07-04T12:01:00.000Z",
      });

      vi.setSystemTime(new Date("2026-07-04T12:02:00.000Z"));
      await expect(
        markGoatChatSessionSeenForUser(
          { userWorkosId: "user_1", sessionId: turn.session.id },
          store,
        ),
      ).resolves.toBe(true);

      const seen = await listRecentGoatChatsForUser({ userWorkosId: "user_1", limit: 8 }, store);
      expect(seen[0]).toMatchObject({
        id: turn.session.id,
        state: "done_seen",
        lastSeenAt: "2026-07-04T12:02:00.000Z",
        updatedAt: "2026-07-04T12:01:00.000Z",
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

  it("keeps task sessions out of chat routes unless the caller requests task kind", async () => {
    const { store, sessions } = createInMemoryChatStore();
    const createdAt = new Date("2026-07-04T12:00:00.000Z");
    sessions.push({
      id: "goat_chat_task_1",
      userWorkosId: "user_1",
      title: "Background research",
      model: DEFAULT_GOAT_MODEL,
      engine: "opencompany",
      kind: "task",
      closedAt: null,
      pinnedAt: null,
      lastSeenAt: createdAt,
      createdAt,
      updatedAt: createdAt,
    });

    await expect(
      loadGoatChatSessionByIdForUser(
        { userWorkosId: "user_1", sessionId: "goat_chat_task_1" },
        store,
      ),
    ).resolves.toBeNull();
    await expect(
      loadGoatChatSessionByIdForUser(
        { userWorkosId: "user_1", sessionId: "goat_chat_task_1", kind: "task" },
        store,
      ),
    ).resolves.toMatchObject({ id: "goat_chat_task_1" });
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
        kind: "chat",
        closedAt: null,
        pinnedAt: null,
        lastSeenAt: now,
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

  it("includes latest Claude effort on loaded chats", async () => {
    const { store, sessions } = createInMemoryChatStore({
      codexSettingsBySessionId: {
        goat_chat_claude_1: {
          reasoningEffort: "xhigh",
        },
      },
    });
    const now = new Date("2026-07-04T12:00:00.000Z");
    sessions.push({
      id: "goat_chat_claude_1",
      userWorkosId: "user_1",
      title: "Claude chat",
      model: "anthropic/claude-opus-4.8",
      engine: "claude_code",
      kind: "chat",
      closedAt: null,
      pinnedAt: null,
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      loadGoatChatSessionByIdForUser(
        { userWorkosId: "user_1", sessionId: "goat_chat_claude_1" },
        store,
      ),
    ).resolves.toMatchObject({
      codexComposerSettings: {
        reasoningEffort: "xhigh",
        planModeEnabled: false,
        goalMode: null,
      },
    });
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
        (session) =>
          session.userWorkosId === input.userWorkosId &&
          !session.closedAt &&
          session.kind === (input.kind ?? "chat"),
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
        (session) =>
          session.userWorkosId === input.userWorkosId &&
          !session.closedAt &&
          session.kind === "chat",
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
        id: input.id ?? `session_${++sessionCount}`,
        userWorkosId: input.userWorkosId,
        title: input.title,
        model: input.model,
        engine: "opencompany",
        kind: "chat",
        closedAt: null,
        pinnedAt: null,
        lastSeenAt: now,
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
      // Mirror the db store: assistant messages upsert by id (approval
      // continuations re-persist the same message id).
      if (input.role === "assistant" && input.id) {
        const existing = messages.find(
          (message) =>
            message.id === input.id &&
            message.sessionId === input.sessionId &&
            message.role === "assistant",
        );
        if (existing) {
          existing.content = input.content;
          existing.taskId = input.taskId ?? null;
          existing.debugTrace = input.debugTrace ?? null;
          existing.updatedAt = now;
          return existing;
        }
      }
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

    async markSessionSeen(input) {
      const session = sessions.find(
        (item) =>
          item.id === input.sessionId &&
          item.userWorkosId === input.userWorkosId &&
          item.kind === "chat" &&
          !item.closedAt,
      );
      if (!session) return false;
      if (!session.lastSeenAt || session.lastSeenAt.getTime() < input.seenAt.getTime()) {
        session.lastSeenAt = input.seenAt;
      }
      return true;
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

    async reopenSession(input) {
      const session = sessions.find(
        (item) =>
          item.id === input.sessionId &&
          item.userWorkosId === input.userWorkosId &&
          Boolean(item.closedAt),
      );
      if (!session) return false;
      session.closedAt = null;
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
