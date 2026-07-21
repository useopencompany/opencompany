import { beforeEach, describe, expect, it, vi } from "vitest";
import { settleTaskForCodexSession } from "./goat-codex-task-settle";

const dbMock = vi.hoisted(() => ({
  execute: vi.fn(),
}));

vi.mock("./db", () => ({
  getDb: () => dbMock,
}));

describe("settleTaskForCodexSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.execute.mockResolvedValue({ rows: [{ id: "goat_task_1" }] });
  });

  it("settles a succeeded task with the assistant message as result", async () => {
    await expect(
      settleTaskForCodexSession({
        chatSessionId: "goat_chat_task_goat_task_1",
        userWorkosId: "user_1",
        turnId: "goat_codex_chat_turn_1",
        assistantMessageId: "goat_chat_msg_assistant",
        outcome: "succeeded",
      }),
    ).resolves.toBe(true);

    const statement = sqlText(dbMock.execute.mock.calls[0]?.[0]);
    expect(statement).toContain("UPDATE goat.tasks AS task");
    expect(statement).toContain("status = 'succeeded'");
    expect(statement).toContain("stage = 'completed'");
    expect(statement).toContain("result = final_message.content");
    expect(statement).toContain("task.status IN ('queued', 'running')");
    expect(statement).toContain("INSERT INTO goat.task_comments");
    expect(statement).toContain("goat_task_comment_goat_codex_chat_turn_1_result");
    expect(statement).toContain("ON CONFLICT (id) DO NOTHING");
    // The completion notification goes to the origin chat, never the run session.
    expect(statement).toContain("session.task_id IS NULL");
  });

  it("keeps the task open while a sibling turn is still queued or running", async () => {
    await settleTaskForCodexSession({
      chatSessionId: "goat_chat_task_goat_task_1",
      userWorkosId: "user_1",
      turnId: "goat_codex_chat_turn_1",
      assistantMessageId: "goat_chat_msg_assistant",
      outcome: "succeeded",
    });

    const statement = sqlText(dbMock.execute.mock.calls[0]?.[0]);
    expect(statement).toContain("NOT EXISTS");
    expect(statement).toContain("pending.status IN ('queued', 'running')");
  });

  it("settles a failed task with the error in comment metadata and notification", async () => {
    await expect(
      settleTaskForCodexSession({
        chatSessionId: "goat_chat_task_goat_task_1",
        userWorkosId: "user_1",
        turnId: "goat_codex_chat_turn_1",
        assistantMessageId: "goat_chat_msg_assistant",
        outcome: "failed",
        error: "Codex sandbox could not be started.",
      }),
    ).resolves.toBe(true);

    const statement = sqlText(dbMock.execute.mock.calls[0]?.[0]);
    expect(statement).toContain("status = 'failed'");
    expect(statement).toContain("stage = 'failed'");
    expect(statement).toContain("goat_task_comment_goat_codex_chat_turn_1_failed");
    expect(statement).toContain(
      JSON.stringify({ status: "failed", error: "Codex sandbox could not be started." }),
    );
    expect(statement).toContain("') failed.'");
  });

  it("reports when no task was settled", async () => {
    dbMock.execute.mockResolvedValue({ rows: [] });

    await expect(
      settleTaskForCodexSession({
        chatSessionId: "goat_chat_regular",
        userWorkosId: "user_1",
        turnId: "goat_codex_chat_turn_1",
        assistantMessageId: "goat_chat_msg_assistant",
        outcome: "succeeded",
      }),
    ).resolves.toBe(false);
  });
});

// Renders a drizzle sql template to text, recursing into nested sql fragments
// (the settle statement composes per-outcome fragments) and inlining string params.
function sqlText(query: unknown): string {
  if (typeof query === "string") return query;
  if (!query || typeof query !== "object") return "";
  if ("queryChunks" in query && Array.isArray((query as { queryChunks?: unknown }).queryChunks)) {
    return ((query as { queryChunks: unknown[] }).queryChunks ?? []).map(sqlText).join("");
  }
  if ("value" in query && Array.isArray((query as { value?: unknown }).value)) {
    return ((query as { value: unknown[] }).value ?? []).join("");
  }
  if ("value" in query) return sqlText((query as { value: unknown }).value);
  return "";
}
