import type { ChatMessageAttachment } from "@opencompany/db/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractChatAttachmentTexts,
  hydrateChatAttachmentParts,
  parseChatAttachmentsInput,
} from "@/lib/chat-attachments";
import type { ChatUiMessage } from "@/lib/chat-ui";

const getMock = vi.hoisted(() => vi.fn());
vi.mock("@vercel/blob", () => ({
  get: getMock,
}));

function blobStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function submittedAttachment(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "client-id",
    kind: "pdf",
    mediaType: "application/pdf",
    filename: "report.pdf",
    sizeBytes: 1024,
    blobUrl: "https://blob.example.com/goat-chat/user_1/report.pdf",
    blobPathname: "goat-chat/user_1/report.pdf",
    ...overrides,
  };
}

describe("parseChatAttachmentsInput", () => {
  it("accepts a valid attachment and re-mints the id", () => {
    const parsed = parseChatAttachmentsInput([submittedAttachment()], "user_1");
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.attachments).toHaveLength(1);
    const attachment = parsed.attachments[0];
    expect(attachment?.id).toMatch(/^goat_chat_att_/);
    expect(attachment?.kind).toBe("pdf");
    expect(attachment?.blobPathname).toBe("goat-chat/user_1/report.pdf");
  });

  it("accepts and canonicalizes SRT attachment metadata", () => {
    const parsed = parseChatAttachmentsInput(
      [
        submittedAttachment({
          mediaType: "text/plain",
          filename: "captions.srt",
          blobUrl: "https://blob.example.com/goat-chat/user_1/captions.srt",
        }),
      ],
      "user_1",
    );
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.attachments[0]).toMatchObject({
      kind: "srt",
      mediaType: "application/x-subrip",
      filename: "captions.srt",
    });
  });

  it("accepts and canonicalizes CSV attachment metadata", () => {
    const parsed = parseChatAttachmentsInput(
      [
        submittedAttachment({
          mediaType: "application/vnd.ms-excel",
          filename: "customers.csv",
          blobUrl: "https://blob.example.com/goat-chat/user_1/customers.csv",
        }),
      ],
      "user_1",
    );
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.attachments[0]).toMatchObject({
      kind: "csv",
      mediaType: "text/csv",
      filename: "customers.csv",
    });
  });

  it("rejects blobs outside the caller's prefix", () => {
    const parsed = parseChatAttachmentsInput(
      [
        submittedAttachment({
          blobUrl: "https://blob.example.com/goat-chat/user_2/report.pdf",
        }),
      ],
      "user_1",
    );
    expect(parsed).toMatchObject({ ok: false });
  });

  it("rejects unsupported types and over-cap counts", () => {
    expect(
      parseChatAttachmentsInput([submittedAttachment({ mediaType: "application/zip" })], "user_1"),
    ).toMatchObject({ ok: false });
    const six = Array.from({ length: 6 }, (_, index) =>
      submittedAttachment({
        blobUrl: `https://blob.example.com/goat-chat/user_1/file-${index}.pdf`,
      }),
    );
    expect(parseChatAttachmentsInput(six, "user_1")).toMatchObject({ ok: false });
  });

  it("dedupes repeated blob urls and allows absent attachments", () => {
    const parsed = parseChatAttachmentsInput(
      [submittedAttachment(), submittedAttachment()],
      "user_1",
    );
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.attachments).toHaveLength(1);
    expect(parseChatAttachmentsInput(undefined, "user_1")).toEqual({
      ok: true,
      attachments: [],
    });
  });
});

describe("hydrateChatAttachmentParts", () => {
  beforeEach(() => {
    getMock.mockReset();
  });

  function storedAttachment(overrides: Partial<ChatMessageAttachment> = {}): ChatMessageAttachment {
    return {
      id: "goat_chat_att_1",
      kind: "pdf",
      mediaType: "application/pdf",
      filename: "report.pdf",
      sizeBytes: 3,
      blobPathname: "goat-chat/user_1/report.pdf",
      blobUrl: "https://blob.example.com/goat-chat/user_1/report.pdf",
      ...overrides,
    };
  }

  function userMessage(id: string): ChatUiMessage {
    return { id, role: "user", parts: [{ type: "text", text: "look at this" }] };
  }

  it("appends a data-url file part for supported binary kinds", async () => {
    getMock.mockResolvedValue({
      statusCode: 200,
      stream: blobStream(new Uint8Array([1, 2, 3])),
    });
    const hydrated = await hydrateChatAttachmentParts({
      uiMessages: [userMessage("m1")],
      storedMessages: [
        { id: "m1", role: "user", attachments: [storedAttachment()], attachmentTexts: null },
      ],
      modelId: "anthropic/claude-sonnet-5",
    });
    const parts = hydrated[0]?.parts ?? [];
    const filePart = parts.find((part) => part.type === "file");
    expect(filePart).toMatchObject({ mediaType: "application/pdf", filename: "report.pdf" });
    expect((filePart as { url: string }).url.startsWith("data:application/pdf;base64,")).toBe(true);
    const label = parts.find(
      (part) => part.type === "text" && part.text.includes("attachment id: goat_chat_att_1"),
    );
    expect(label).toBeTruthy();
  });

  it("substitutes a placeholder when the model lacks the capability", async () => {
    const hydrated = await hydrateChatAttachmentParts({
      uiMessages: [userMessage("m1")],
      storedMessages: [
        { id: "m1", role: "user", attachments: [storedAttachment()], attachmentTexts: null },
      ],
      modelId: "moonshotai/kimi-k2.6",
    });
    const parts = hydrated[0]?.parts ?? [];
    expect(parts.some((part) => part.type === "file")).toBe(false);
    expect(
      parts.some(
        (part) => part.type === "text" && part.text.includes("not viewable with the current model"),
      ),
    ).toBe(true);
    expect(getMock).not.toHaveBeenCalled();
  });

  it("inlines stored extracted text for docx/xlsx", async () => {
    const attachment = storedAttachment({
      id: "goat_chat_att_2",
      kind: "xlsx",
      mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      filename: "numbers.xlsx",
    });
    const hydrated = await hydrateChatAttachmentParts({
      uiMessages: [userMessage("m1")],
      storedMessages: [
        {
          id: "m1",
          role: "user",
          attachments: [attachment],
          attachmentTexts: { goat_chat_att_2: "## Sheet: Q1\nrevenue,120" },
        },
      ],
      modelId: "anthropic/claude-sonnet-5",
    });
    const parts = hydrated[0]?.parts ?? [];
    expect(parts.some((part) => part.type === "text" && part.text.includes("revenue,120"))).toBe(
      true,
    );
    expect(getMock).not.toHaveBeenCalled();
  });

  it("extracts and replays SRT text without a model attachment capability", async () => {
    const subtitle = "1\n00:00:00,000 --> 00:00:01,000\nHello from the subtitles.";
    getMock.mockResolvedValue({
      statusCode: 200,
      stream: blobStream(Buffer.from(subtitle)),
    });
    const attachment = storedAttachment({
      id: "goat_chat_att_srt",
      kind: "srt",
      mediaType: "application/x-subrip",
      filename: "captions.srt",
      blobUrl: "https://blob.example.com/goat-chat/user_1/captions.srt",
    });

    const attachmentTexts = await extractChatAttachmentTexts([attachment]);
    expect(attachmentTexts).toEqual({ goat_chat_att_srt: subtitle });

    getMock.mockClear();
    const hydrated = await hydrateChatAttachmentParts({
      uiMessages: [userMessage("m1")],
      storedMessages: [
        {
          id: "m1",
          role: "user",
          attachments: [attachment],
          attachmentTexts,
        },
      ],
      modelId: "moonshotai/kimi-k2.6",
    });
    expect(
      hydrated[0]?.parts.some(
        (part) => part.type === "text" && part.text.includes("Hello from the subtitles."),
      ),
    ).toBe(true);
    expect(getMock).not.toHaveBeenCalled();
  });

  it("extracts and replays CSV text without a model attachment capability", async () => {
    const csv = "name,stage\nAcme,trial";
    getMock.mockResolvedValue({
      statusCode: 200,
      stream: blobStream(Buffer.from(csv)),
    });
    const attachment = storedAttachment({
      id: "goat_chat_att_csv",
      kind: "csv",
      mediaType: "text/csv",
      filename: "customers.csv",
      blobUrl: "https://blob.example.com/goat-chat/user_1/customers.csv",
    });

    const attachmentTexts = await extractChatAttachmentTexts([attachment]);
    expect(attachmentTexts).toEqual({ goat_chat_att_csv: csv });

    getMock.mockClear();
    const hydrated = await hydrateChatAttachmentParts({
      uiMessages: [userMessage("m1")],
      storedMessages: [
        {
          id: "m1",
          role: "user",
          attachments: [attachment],
          attachmentTexts,
        },
      ],
      modelId: "moonshotai/kimi-k2.6",
    });
    expect(
      hydrated[0]?.parts.some((part) => part.type === "text" && part.text.includes("Acme,trial")),
    ).toBe(true);
    expect(getMock).not.toHaveBeenCalled();
  });

  it("leaves messages without attachments untouched", async () => {
    const message = userMessage("m1");
    const hydrated = await hydrateChatAttachmentParts({
      uiMessages: [message],
      storedMessages: [{ id: "m1", role: "user", attachments: null, attachmentTexts: null }],
      modelId: "anthropic/claude-sonnet-5",
    });
    expect(hydrated[0]).toBe(message);
  });
});
