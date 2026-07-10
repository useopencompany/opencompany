import type { GoatChatMessageAttachment } from "@opencompany/db/goat-schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  hydrateGoatChatAttachmentParts,
  parseGoatChatAttachmentsInput,
} from "@/lib/chat-attachments";
import type { GoatChatUiMessage } from "@/lib/chat-ui";

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

describe("parseGoatChatAttachmentsInput", () => {
  it("accepts a valid attachment and re-mints the id", () => {
    const parsed = parseGoatChatAttachmentsInput([submittedAttachment()], "user_1");
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.attachments).toHaveLength(1);
    const attachment = parsed.attachments[0];
    expect(attachment?.id).toMatch(/^goat_chat_att_/);
    expect(attachment?.kind).toBe("pdf");
    expect(attachment?.blobPathname).toBe("goat-chat/user_1/report.pdf");
  });

  it("rejects blobs outside the caller's prefix", () => {
    const parsed = parseGoatChatAttachmentsInput(
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
      parseGoatChatAttachmentsInput(
        [submittedAttachment({ mediaType: "application/zip" })],
        "user_1",
      ),
    ).toMatchObject({ ok: false });
    const six = Array.from({ length: 6 }, (_, index) =>
      submittedAttachment({
        blobUrl: `https://blob.example.com/goat-chat/user_1/file-${index}.pdf`,
      }),
    );
    expect(parseGoatChatAttachmentsInput(six, "user_1")).toMatchObject({ ok: false });
  });

  it("dedupes repeated blob urls and allows absent attachments", () => {
    const parsed = parseGoatChatAttachmentsInput(
      [submittedAttachment(), submittedAttachment()],
      "user_1",
    );
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.attachments).toHaveLength(1);
    expect(parseGoatChatAttachmentsInput(undefined, "user_1")).toEqual({
      ok: true,
      attachments: [],
    });
  });
});

describe("hydrateGoatChatAttachmentParts", () => {
  beforeEach(() => {
    getMock.mockReset();
  });

  function storedAttachment(
    overrides: Partial<GoatChatMessageAttachment> = {},
  ): GoatChatMessageAttachment {
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

  function userMessage(id: string): GoatChatUiMessage {
    return { id, role: "user", parts: [{ type: "text", text: "look at this" }] };
  }

  it("appends a data-url file part for supported binary kinds", async () => {
    getMock.mockResolvedValue({
      statusCode: 200,
      stream: blobStream(new Uint8Array([1, 2, 3])),
    });
    const hydrated = await hydrateGoatChatAttachmentParts({
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
    const hydrated = await hydrateGoatChatAttachmentParts({
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
    const hydrated = await hydrateGoatChatAttachmentParts({
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

  it("leaves messages without attachments untouched", async () => {
    const message = userMessage("m1");
    const hydrated = await hydrateGoatChatAttachmentParts({
      uiMessages: [message],
      storedMessages: [{ id: "m1", role: "user", attachments: null, attachmentTexts: null }],
      modelId: "anthropic/claude-sonnet-5",
    });
    expect(hydrated[0]).toBe(message);
  });
});
