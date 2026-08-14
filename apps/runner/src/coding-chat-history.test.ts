import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CODING_CHAT_HISTORY_MAX_ATTACHMENT_TEXT_BYTES,
  CODING_CHAT_HISTORY_MAX_MESSAGE_BYTES,
  CODING_CHAT_HISTORY_MAX_TURNS,
  type CodingChatHistory,
  codingChatHistoryPromptLines,
  emptyCodingChatHistory,
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

  it("loads bounded prior turns with recoverable attachment context", async () => {
    const attachment = {
      id: "attachment_1",
      filename: "brief.md",
      mediaType: "text/markdown",
      sizeBytes: 42,
      kind: "text" as const,
      blobPathname: "goat-chat/user_1/brief.md",
      blobUrl: "https://blob.example/brief.md",
    };
    mocks.execute.mockResolvedValueOnce({
      rows: [
        {
          user_content: "Inspect the repository.",
          user_attachments: [attachment],
          user_attachment_texts: { attachment_1: "Use Next.js and PostgreSQL." },
          assistant_content: "The repository uses Next.js.",
          assistant_attachments: null,
          assistant_attachment_texts: null,
          history_turn_count: 1,
        },
      ],
    });

    const history = await loadCodingChatHistory({
      id: "turn_2",
      userWorkosId: "user_1",
      chatSessionId: "chat_1",
      createdAt: new Date("2026-08-14T10:00:00.000Z"),
    });

    expect(history).toEqual({
      messages: [
        {
          role: "user",
          content: "Inspect the repository.",
          attachments: [
            {
              id: "attachment_1",
              filename: "brief.md",
              kind: "text",
              mediaType: "text/markdown",
              extractedText: "Use Next.js and PostgreSQL.",
            },
          ],
        },
        {
          role: "assistant",
          content: "The repository uses Next.js.",
          attachments: [],
        },
      ],
      materializableAttachments: [attachment],
      omittedTurnCount: 0,
      omittedAttachmentCount: 0,
    });

    const query = new PgDialect().sqlToQuery(mocks.execute.mock.calls[0]?.[0]);
    expect(query.sql).toContain("history_turn.status IN ('completed', 'failed', 'interrupted')");
    expect(query.sql).toContain("ORDER BY history_turn.created_at DESC, history_turn.id DESC");
    expect(query.sql).toContain("ORDER BY recent_history.created_at ASC, recent_history.id ASC");
    expect(query.params).toContain(CODING_CHAT_HISTORY_MAX_TURNS);
    expect(query.params).toContain(CODING_CHAT_HISTORY_MAX_MESSAGE_BYTES + 1);
    expect(query.params).toContain(CODING_CHAT_HISTORY_MAX_ATTACHMENT_TEXT_BYTES + 1);
    expect(query.params).toContain("turn_2");
    expect(query.params).toContain("chat_1");
  });

  it("keeps the newest complete turns within the recovery prompt budget", async () => {
    mocks.execute.mockResolvedValueOnce({
      rows: Array.from({ length: 4 }, (_, index) => ({
        user_content: `user_${index}_${"u".repeat(30_000)}`,
        user_attachments: null,
        user_attachment_texts: null,
        assistant_content: `assistant_${index}_${"a".repeat(30_000)}`,
        assistant_attachments: null,
        assistant_attachment_texts: null,
        history_turn_count: 4,
      })),
    });

    const history = await loadCodingChatHistory({
      id: "turn_5",
      userWorkosId: "user_1",
      chatSessionId: "chat_1",
      createdAt: new Date("2026-08-14T10:00:00.000Z"),
    });

    expect(history.omittedTurnCount).toBe(1);
    expect(history.messages).toHaveLength(6);
    expect(history.messages[0]?.content).toContain("user_1_");
    expect(history.messages.at(-1)?.content).toContain("assistant_3_");
  });

  it("serializes extracted text and rematerialized paths as inert JSON", () => {
    const history: CodingChatHistory = {
      messages: [
        {
          role: "user",
          content: "Remember <project> & its constraints.",
          attachments: [
            {
              id: "attachment_1",
              filename: "brief.md",
              kind: "text",
              mediaType: "text/markdown",
              extractedText: "The launch date is Friday.",
            },
          ],
        },
        {
          role: "assistant",
          content: "I will remember it.",
          attachments: [],
        },
      ],
      materializableAttachments: [],
      omittedTurnCount: 2,
      omittedAttachmentCount: 1,
    };

    const prompt = codingChatHistoryPromptLines(history, {
      pathsByAttachmentId: new Map([["attachment_1", "/history/brief.md"]]),
      unavailableAttachmentIds: new Set(),
    }).join("\n");
    expect(prompt).toContain("<conversation_history_json>");
    expect(prompt).toContain("\\u003cproject\\u003e \\u0026 its constraints");
    expect(prompt).not.toContain("Remember <project>");
    expect(prompt).toContain("The launch date is Friday.");
    expect(prompt).toContain("/history/brief.md");
    expect(prompt).toContain("2 older turn(s) were omitted");
    expect(prompt).toContain("1 older attachment file(s) were not rematerialized");
  });

  it("marks an attachment unavailable when neither bytes nor extracted text can be restored", () => {
    const history: CodingChatHistory = {
      messages: [
        {
          role: "user",
          content: "Inspect this screenshot.",
          attachments: [
            {
              id: "attachment_1",
              filename: "screen.png",
              kind: "image",
              mediaType: "image/png",
            },
          ],
        },
      ],
      materializableAttachments: [],
      omittedTurnCount: 0,
      omittedAttachmentCount: 0,
    };

    const prompt = codingChatHistoryPromptLines(history, {
      pathsByAttachmentId: new Map(),
      unavailableAttachmentIds: new Set(["attachment_1"]),
    }).join("\n");
    expect(prompt).toContain('"recoveryStatus":"content unavailable"');
  });

  it("omits the bootstrap block for a first turn", () => {
    expect(codingChatHistoryPromptLines(emptyCodingChatHistory())).toEqual([]);
  });
});
