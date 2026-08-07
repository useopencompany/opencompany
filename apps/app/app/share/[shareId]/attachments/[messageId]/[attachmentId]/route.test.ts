import type { ChatMessageAttachment } from "@opencompany/db/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  attachmentResponse: vi.fn(),
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: mocks.getDb,
}));

vi.mock("@/lib/chat-attachment-response", () => ({
  chatAttachmentResponse: mocks.attachmentResponse,
}));

import { GET } from "./route";

const SHARE_ID = "goat_chat_share_123e4567-e89b-42d3-a456-426614174000";
const attachment: ChatMessageAttachment = {
  id: "attachment_1",
  kind: "image",
  mediaType: "image/png",
  filename: "diagram.png",
  sizeBytes: 42,
  blobUrl: "https://private.example/diagram.png",
  blobPathname: "goat-chat/user_1/diagram.png",
};

describe("public shared chat attachments", () => {
  beforeEach(() => {
    mocks.getDb.mockReset();
    mocks.attachmentResponse.mockReset();
    mocks.attachmentResponse.mockResolvedValue(new Response("asset"));
  });

  it("serves only an attachment resolved through the shared session query", async () => {
    mocks.getDb.mockReturnValue(queryDb([{ attachments: [attachment] }]));

    const response = await GET(new Request("https://goat.test"), {
      params: Promise.resolve({
        shareId: SHARE_ID,
        messageId: "message_1",
        attachmentId: "attachment_1",
      }),
    });

    expect(response.status).toBe(200);
    expect(mocks.attachmentResponse).toHaveBeenCalledWith(attachment);
  });

  it("returns 404 for unknown attachments and malformed share tokens", async () => {
    mocks.getDb.mockReturnValue(queryDb([]));

    const missing = await GET(new Request("https://goat.test"), {
      params: Promise.resolve({
        shareId: SHARE_ID,
        messageId: "message_1",
        attachmentId: "missing",
      }),
    });
    expect(missing.status).toBe(404);
    expect(mocks.attachmentResponse).not.toHaveBeenCalled();

    mocks.getDb.mockClear();
    const malformed = await GET(new Request("https://goat.test"), {
      params: Promise.resolve({
        shareId: "../private",
        messageId: "message_1",
        attachmentId: "attachment_1",
      }),
    });
    expect(malformed.status).toBe(404);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });
});

function queryDb(rows: Array<{ attachments: ChatMessageAttachment[] | null }>) {
  const limit = vi.fn(async () => rows);
  const where = vi.fn(() => ({ limit }));
  const innerJoin = vi.fn(() => ({ where }));
  const from = vi.fn(() => ({ innerJoin }));
  return { select: vi.fn(() => ({ from })) };
}
