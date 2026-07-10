import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGoatCodexChatMessage, interruptGoatCodexChatSession } from "@/lib/codex-chat";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  select: vi.fn(),
  selectResults: [] as unknown[][],
  codexConnected: vi.fn(),
  wake: vi.fn(),
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: () => ({
    execute: mocks.execute,
    select: mocks.select,
  }),
}));

vi.mock("@/lib/codex-auth", () => ({
  isGoatCodexConnectedForUser: mocks.codexConnected,
}));

vi.mock("@/lib/task-runner", () => ({
  triggerGoatCodexChatWake: mocks.wake,
}));

vi.mock("@/lib/chat", () => ({
  newGoatChatMessageId: vi.fn(() => "goat_chat_msg_mock"),
}));

function createSelectBuilder(rows: unknown[]) {
  const builder: Record<string, unknown> = {};
  for (const method of ["from", "innerJoin", "where", "orderBy"]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.limit = vi.fn(async () => rows);
  return builder;
}

describe("createGoatCodexChatMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectResults.length = 0;
    mocks.execute.mockResolvedValue({ rows: [] });
    mocks.codexConnected.mockResolvedValue(true);
    mocks.wake.mockResolvedValue(undefined);
    mocks.select.mockImplementation(() => createSelectBuilder(mocks.selectResults.shift() ?? []));
  });

  it("rejects empty and oversized prompts", async () => {
    expect(
      await createGoatCodexChatMessage({ userWorkosId: "user_1", prompt: "   " }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      await createGoatCodexChatMessage({ userWorkosId: "user_1", prompt: "x".repeat(10_001) }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("rejects invalid Codex settings before writing", async () => {
    const result = await createGoatCodexChatMessage({
      userWorkosId: "user_1",
      prompt: "hello",
      settings: { reasoningEffort: "extreme" },
    });

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: "Invalid Codex reasoning effort.",
    });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.wake).not.toHaveBeenCalled();
  });

  it("rejects sends while Codex is disconnected", async () => {
    mocks.codexConnected.mockResolvedValue(false);
    const result = await createGoatCodexChatMessage({ userWorkosId: "user_1", prompt: "hello" });
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.wake).not.toHaveBeenCalled();
  });

  it("creates a new session atomically and wakes the runner", async () => {
    const result = await createGoatCodexChatMessage({
      userWorkosId: "user_1",
      prompt: "clone my repo",
      clientMessageId: "client_msg_1",
    });
    expect(result).toMatchObject({
      ok: true,
      mode: "started",
      userMessageId: "client_msg_1",
      assistantMessageId: "goat_chat_msg_mock",
    });
    // The whole send (session + both messages + codex session + turn) is one statement.
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.wake).toHaveBeenCalledTimes(1);
  });

  it("returns 404 for an unknown or foreign session", async () => {
    mocks.selectResults.push([]);
    const result = await createGoatCodexChatMessage({
      userWorkosId: "user_1",
      sessionId: "goat_chat_other",
      prompt: "hello",
    });
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("queues a message while the session is running", async () => {
    mocks.selectResults.push([
      {
        codex_chat_sessions: {
          id: "goat_codex_chat_1",
          chatSessionId: "goat_chat_1",
          status: "running",
        },
      },
    ]);
    const result = await createGoatCodexChatMessage({
      userWorkosId: "user_1",
      sessionId: "goat_chat_1",
      prompt: "also do this",
    });
    expect(result).toMatchObject({ ok: true, mode: "queued", sessionId: "goat_chat_1" });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.wake).toHaveBeenCalledTimes(1);
  });

  it("still succeeds when the runner wake fails", async () => {
    mocks.wake.mockRejectedValue(new Error("runner offline"));
    const result = await createGoatCodexChatMessage({ userWorkosId: "user_1", prompt: "hello" });
    expect(result).toMatchObject({ ok: true });
  });
});

describe("interruptGoatCodexChatSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectResults.length = 0;
    mocks.execute.mockResolvedValue({ rows: [] });
    mocks.select.mockImplementation(() => createSelectBuilder(mocks.selectResults.shift() ?? []));
  });

  it("returns 404 for an unknown session", async () => {
    mocks.selectResults.push([]);
    const result = await interruptGoatCodexChatSession({
      userWorkosId: "user_1",
      chatSessionId: "goat_chat_unknown",
    });
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("flags running turns and cancels queued turns", async () => {
    mocks.selectResults.push([
      {
        codex_chat_sessions: {
          id: "goat_codex_chat_1",
          chatSessionId: "goat_chat_1",
          status: "running",
        },
      },
    ]);
    const result = await interruptGoatCodexChatSession({
      userWorkosId: "user_1",
      chatSessionId: "goat_chat_1",
    });
    expect(result).toMatchObject({ ok: true, status: 202 });
    // One UPDATE for the running turn's interrupt flag, one CTE for queued-turn cancellation.
    expect(mocks.execute).toHaveBeenCalledTimes(2);
  });
});
