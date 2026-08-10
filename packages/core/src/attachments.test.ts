import { describe, expect, it } from "vitest";
import {
  CHAT_ATTACHMENT_MAX_BYTES,
  CHAT_IMAGE_MAX_BYTES,
  validateChatAttachment,
} from "./attachments";

describe("Chat attachment policy", () => {
  it("normalizes known browser fallback media types", () => {
    expect(
      validateChatAttachment({
        filename: "notes.md",
        mediaType: "application/octet-stream",
        sizeBytes: 10,
      }),
    ).toMatchObject({ ok: true, format: "text", mediaType: "text/markdown" });
    expect(
      validateChatAttachment({
        filename: "payload.exe",
        mediaType: "application/octet-stream",
        sizeBytes: 10,
      }),
    ).toMatchObject({ ok: false, code: "unsupported_type" });
  });

  it("applies the established document and image size boundaries", () => {
    expect(
      validateChatAttachment({
        filename: "brief.pdf",
        mediaType: "application/pdf",
        sizeBytes: CHAT_ATTACHMENT_MAX_BYTES,
      }),
    ).toMatchObject({ ok: true, format: "pdf", kind: "document" });
    expect(
      validateChatAttachment({
        filename: "image.png",
        mediaType: "image/png",
        sizeBytes: CHAT_IMAGE_MAX_BYTES + 1,
      }),
    ).toMatchObject({ ok: false, code: "invalid_size" });
  });
});
