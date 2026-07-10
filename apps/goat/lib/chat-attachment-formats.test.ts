import { describe, expect, it } from "vitest";
import {
  GOAT_CHAT_ATTACHMENT_MAX_BYTES,
  GOAT_CHAT_IMAGE_MAX_BYTES,
  goatChatAttachmentKindForMime,
  validateGoatChatAttachmentCandidate,
} from "@/lib/chat-attachment-formats";

describe("goatChatAttachmentKindForMime", () => {
  it("maps the core set", () => {
    expect(goatChatAttachmentKindForMime("application/pdf")).toBe("pdf");
    expect(
      goatChatAttachmentKindForMime(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBe("docx");
    expect(
      goatChatAttachmentKindForMime(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ),
    ).toBe("xlsx");
    expect(goatChatAttachmentKindForMime("image/png")).toBe("image");
    expect(goatChatAttachmentKindForMime("image/jpeg")).toBe("image");
    expect(goatChatAttachmentKindForMime("image/webp")).toBe("image");
  });

  it("rejects legacy office formats, gif, and text", () => {
    expect(goatChatAttachmentKindForMime("application/msword")).toBeNull();
    expect(goatChatAttachmentKindForMime("application/vnd.ms-excel")).toBeNull();
    expect(goatChatAttachmentKindForMime("image/gif")).toBeNull();
    expect(goatChatAttachmentKindForMime("text/plain")).toBeNull();
  });
});

describe("validateGoatChatAttachmentCandidate", () => {
  it("accepts a pdf up to 20 MB", () => {
    expect(
      validateGoatChatAttachmentCandidate({
        mediaType: "application/pdf",
        sizeBytes: GOAT_CHAT_ATTACHMENT_MAX_BYTES,
      }),
    ).toEqual({ ok: true, kind: "pdf" });
    expect(
      validateGoatChatAttachmentCandidate({
        mediaType: "application/pdf",
        sizeBytes: GOAT_CHAT_ATTACHMENT_MAX_BYTES + 1,
      }),
    ).toMatchObject({ ok: false, reason: "size" });
  });

  it("caps images at 5 MB", () => {
    expect(
      validateGoatChatAttachmentCandidate({
        mediaType: "image/png",
        sizeBytes: GOAT_CHAT_IMAGE_MAX_BYTES,
      }),
    ).toEqual({ ok: true, kind: "image" });
    expect(
      validateGoatChatAttachmentCandidate({
        mediaType: "image/png",
        sizeBytes: GOAT_CHAT_IMAGE_MAX_BYTES + 1,
      }),
    ).toMatchObject({ ok: false, reason: "size" });
  });

  it("rejects empty files and unknown types", () => {
    expect(
      validateGoatChatAttachmentCandidate({ mediaType: "application/pdf", sizeBytes: 0 }),
    ).toMatchObject({ ok: false, reason: "size" });
    expect(
      validateGoatChatAttachmentCandidate({ mediaType: "application/zip", sizeBytes: 10 }),
    ).toMatchObject({ ok: false, reason: "type" });
  });
});
