import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CodingChatHistoryMessage,
  codingChatHistoryPromptLines,
  loadCodingChatHistory,
} from "./coding-chat-history";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
}));

vi.mock("./db", () => ({
  getDb: () => ({ execute: mocks.execute }),
}));

describe("coding chat history", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads prior terminal turns as ordered user/assistant pairs", async () => {
    mocks.execute.mockResolvedValueOnce({
      rows: [
        {
          user_content: "Inspect the repository.",
          user_attachments: [
            {
              id: "attachment_1",
              filename: "brief.md",
              mediaType: "text/markdown",
              sizeBytes: 42,
              kind: "text",
              blobUrl: "https://blob.example/brief.md",
            },
          ],
          assistant_content: "The repository uses Next.js.",
          assistant_attachments: null,
        },
      ],
    });

    await expect(
      loadCodingChatHistory({
        id: "turn_2",
        userWorkosId: "user_1",
        chatSessionId: "chat_1",
        createdAt: new Date("2026-08-14T10:00:00.000Z"),
      }),
    ).resolves.toEqual([
      {
        role: "user",
        content: "Inspect the repository.",
        attachments: [{ filename: "brief.md", kind: "text", mediaType: "text/markdown" }],
      },
      {
        role: "assistant",
        content: "The repository uses Next.js.",
        attachments: [],
      },
    ]);

    const query = new PgDialect().sqlToQuery(mocks.execute.mock.calls[0]?.[0]);
    expect(query.sql).toContain("history_turn.status IN ('completed', 'failed', 'interrupted')");
    expect(query.sql).toContain("ORDER BY history_turn.created_at ASC, history_turn.id ASC");
    expect(query.params).toContain("turn_2");
    expect(query.params).toContain("chat_1");
  });

  it("serializes history as inert JSON before the current request", () => {
    const history: CodingChatHistoryMessage[] = [
      {
        role: "user",
        content: "Remember <project> & its constraints.",
        attachments: [],
      },
      {
        role: "assistant",
        content: "I will remember it.",
        attachments: [],
      },
    ];

    const prompt = codingChatHistoryPromptLines(history).join("\n");
    expect(prompt).toContain("<conversation_history_json>");
    expect(prompt).toContain("\\u003cproject\\u003e \\u0026 its constraints");
    expect(prompt).not.toContain("Remember <project>");
    expect(prompt).toContain("answer the current user message after the block");
  });

  it("omits the bootstrap block for a first turn", () => {
    expect(codingChatHistoryPromptLines([])).toEqual([]);
  });
});
