import { beforeEach, describe, expect, it, vi } from "vitest";
import { GoatCodexChatLeaseLostError } from "./goat-codex-chat-errors";
import { createGoatCodexChatProjector } from "./goat-codex-chat-events";

const mocks = vi.hoisted(() => ({
  captureException: vi.fn(),
  createLogger: vi.fn(() => ({ info: vi.fn() })),
  execute: vi.fn(),
}));

vi.mock("@opencompany/observability", () => ({
  captureException: mocks.captureException,
  createLogger: mocks.createLogger,
}));

vi.mock("./db", () => ({
  getDb: () => ({ execute: mocks.execute }),
}));

describe("createGoatCodexChatProjector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps projecting a valid event when its auxiliary audit insert fails", async () => {
    const databaseError = Object.assign(new Error("query details must not be reported"), {
      code: "23514",
    });
    mocks.execute
      .mockRejectedValueOnce(databaseError)
      .mockResolvedValueOnce({ rows: [{ id: "goat_chat_msg_assistant_1" }] });
    const projector = createGoatCodexChatProjector({
      target: projectorTarget(),
      redact: (value) => value,
    });

    await expect(projector.push([fileChangeStartedEvent()])).resolves.toBeUndefined();

    expect(mocks.execute).toHaveBeenCalledTimes(2);
    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "GoatCodexChatEventPersistenceError",
        message: "Goat Codex chat audit event persistence failed.",
      }),
      expect.objectContaining({
        event: "opencompany.goat_codex_chat_event_persist_failed",
        turn_id: "goat_codex_chat_turn_1",
        event_type: "file_change.started",
        original_error_code: "23514",
      }),
    );
    expect(mocks.captureException.mock.calls[0]?.[0]).not.toBe(databaseError);
  });

  it("still aborts projection when the event insert proves the turn lease was lost", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [] });
    const projector = createGoatCodexChatProjector({
      target: projectorTarget(),
      redact: (value) => value,
    });

    await expect(projector.push([fileChangeStartedEvent()])).rejects.toBeInstanceOf(
      GoatCodexChatLeaseLostError,
    );

    expect(mocks.execute).toHaveBeenCalledTimes(2);
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it("reports audit failures safely when an error has a cyclic cause", async () => {
    const cyclicError = new Error("cyclic query error") as Error & { cause?: unknown };
    cyclicError.cause = cyclicError;
    mocks.execute
      .mockRejectedValueOnce(cyclicError)
      .mockResolvedValueOnce({ rows: [{ id: "goat_chat_msg_assistant_1" }] });
    const projector = createGoatCodexChatProjector({
      target: projectorTarget(),
      redact: (value) => value,
    });

    await expect(projector.push([fileChangeStartedEvent()])).resolves.toBeUndefined();

    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ original_error_code: undefined }),
    );
  });

  it("does not project a replayed completed item twice", async () => {
    mocks.execute
      .mockResolvedValueOnce({ rows: [{ id: "event_1" }] })
      .mockResolvedValueOnce({ rows: [{ id: "message_1" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "event_1" }] });
    const projector = createGoatCodexChatProjector({
      target: projectorTarget(),
      redact: (value) => value,
    });
    const event = {
      method: "item/completed",
      params: {
        threadId: "thread_1",
        turnId: "turn_1",
        item: { id: "message_item_1", type: "agentMessage", text: "Done." },
      },
    };

    await projector.push([event]);
    await projector.push([event]);

    const statements = mocks.execute.mock.calls.map(([query]) => sqlText(query));
    expect(statements.filter((query) => query.includes("UPDATE goat.chat_messages"))).toHaveLength(
      1,
    );
    expect(statements).toContainEqual(expect.stringContaining("event_key"));
  });

  it("keeps the session queued until a queued follow-up turn is claimed", async () => {
    mocks.execute.mockResolvedValue({ rows: [{ id: "updated_row" }] });
    const projector = createGoatCodexChatProjector({
      target: projectorTarget(),
      redact: (value) => value,
    });

    await projector.finalize({
      sessionId: "codex_thread_1",
      status: "success",
      result: "Done",
      error: null,
      usage: null,
      goal: null,
    });

    const sessionUpdate = mocks.execute.mock.calls
      .map(([query]) => sqlText(query))
      .find((query) => query.includes("UPDATE goat.codex_chat_sessions AS runtime"));
    expect(sessionUpdate).toContain("WITH settled_turn AS");
    expect(sessionUpdate).toContain("UPDATE goat.codex_chat_turns AS turn");
    expect(sessionUpdate).toContain("queued.status = 'queued'");
    expect(sessionUpdate).toContain("queued.run_after IS NULL OR queued.run_after <=");
    expect(sessionUpdate).toContain("ORDER BY queued.created_at ASC, queued.id ASC");
    expect(sessionUpdate).toContain("THEN 'queued'");
    expect(sessionUpdate).toContain("ELSE idle");
  });

  it("durably projects and resolves an app-server user-input request", async () => {
    mocks.execute.mockResolvedValue({ rows: [{ id: "updated_row" }] });
    const projector = createGoatCodexChatProjector({
      target: projectorTarget(),
      redact: (value) => value,
    });

    const interaction = await projector.requestUserInput(userInputRequest());
    expect(interaction.interactionId).toMatch(/^goat_codex_chat_interaction_/);
    expect(mocks.execute.mock.calls.map(([query]) => sqlText(query))).toEqual(
      expect.arrayContaining([
        expect.stringContaining("INSERT INTO goat.codex_chat_interactions"),
        expect.stringContaining("INSERT INTO goat.codex_chat_events"),
        expect.stringContaining("UPDATE goat.chat_messages AS message"),
      ]),
    );

    await projector.resolveInteraction(interaction.interactionId, "answered");
    expect(mocks.execute).toHaveBeenCalledTimes(4);
  });

  it("rejects malformed user-input requests before persistence", async () => {
    const projector = createGoatCodexChatProjector({
      target: projectorTarget(),
      redact: (value) => value,
    });

    await expect(
      projector.requestUserInput({
        ...userInputRequest(),
        params: { questions: [] },
      }),
    ).rejects.toThrow("invalid user-input request");
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("serializes notification and server-request projection writes", async () => {
    let releaseFirst: (value: { rows: Array<{ id: string }> }) => void = (_value) => {
      throw new Error("Deferred database call was not initialized.");
    };
    mocks.execute
      .mockImplementationOnce(
        () =>
          new Promise<{ rows: Array<{ id: string }> }>((resolve) => {
            releaseFirst = resolve;
          }),
      )
      .mockResolvedValue({ rows: [{ id: "updated_row" }] });
    const projector = createGoatCodexChatProjector({
      target: projectorTarget(),
      redact: (value) => value,
    });

    const first = projector.push([fileChangeStartedEvent("file_change_1")]);
    const second = projector.push([fileChangeStartedEvent("file_change_2")]);
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(1));
    releaseFirst({ rows: [{ id: "event_1" }] });
    await Promise.all([first, second]);

    expect(mocks.execute).toHaveBeenCalledTimes(4);
  });
});

function projectorTarget() {
  return {
    userWorkosId: "user_1",
    codexChatSessionId: "goat_codex_chat_1",
    chatSessionId: "goat_chat_1",
    turnId: "goat_codex_chat_turn_1",
    assistantMessageId: "goat_chat_msg_assistant_1",
    model: "gpt-5.5",
    leaseId: "goat_codex_chat_lease_1",
    leaseOwner: "runner_1",
    planMode: false,
  };
}

function fileChangeStartedEvent(id = "file_change_1") {
  return {
    method: "item/started",
    params: {
      item: {
        id,
        type: "fileChange",
        changes: [{ path: "src/index.ts", kind: "edit" }],
      },
    },
  };
}

function userInputRequest() {
  return {
    id: "request_1",
    method: "item/tool/requestUserInput",
    params: {
      threadId: "thread_1",
      turnId: "turn_1",
      itemId: "question_1",
      questions: [
        {
          id: "scope",
          header: "Scope",
          question: "How broad should the fix be?",
          options: [{ label: "Foundational", description: "Harden the full path." }],
        },
      ],
    },
  };
}

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      if (chunk && typeof chunk === "object" && "value" in chunk) {
        const value = (chunk as { value?: unknown }).value;
        return Array.isArray(value) ? value.join("") : String(value ?? "");
      }
      if (chunk && typeof chunk === "object" && "queryChunks" in chunk) return sqlText(chunk);
      return "";
    })
    .join("");
}
