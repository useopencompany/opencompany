import { describe, expect, it } from "vitest";
import {
  CHAT_ATTACHMENT_MAX_BYTES,
  CHAT_IMAGE_MAX_BYTES,
  CHAT_SRT_MIME_TYPE,
  chatAttachmentKindForMime,
  normalizedChatAttachmentMediaType,
  validateChatAttachmentCandidate,
} from "@/lib/chat-attachment-formats";

describe("chatAttachmentKindForMime", () => {
  it("maps the core set", () => {
    expect(chatAttachmentKindForMime("application/pdf")).toBe("pdf");
    expect(
      chatAttachmentKindForMime(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBe("docx");
    expect(
      chatAttachmentKindForMime(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ),
    ).toBe("xlsx");
    expect(chatAttachmentKindForMime("image/png")).toBe("image");
    expect(chatAttachmentKindForMime("image/jpeg")).toBe("image");
    expect(chatAttachmentKindForMime("image/webp")).toBe("image");
    expect(chatAttachmentKindForMime("application/x-subrip")).toBe("srt");
    expect(chatAttachmentKindForMime("text/srt")).toBe("srt");
    expect(chatAttachmentKindForMime("text/csv")).toBe("csv");
    expect(chatAttachmentKindForMime("text/tab-separated-values")).toBe("tsv");
    expect(chatAttachmentKindForMime("application/json")).toBe("json");
    expect(chatAttachmentKindForMime("text/markdown")).toBe("text");
    expect(chatAttachmentKindForMime("text/plain")).toBe("text");
  });

  it("rejects legacy office formats and gif", () => {
    expect(chatAttachmentKindForMime("application/msword")).toBeNull();
    expect(chatAttachmentKindForMime("application/vnd.ms-excel")).toBeNull();
    expect(chatAttachmentKindForMime("image/gif")).toBeNull();
  });
});

describe("normalizedChatAttachmentMediaType", () => {
  it.each(["", "text/plain", "application/octet-stream", "text/srt"])(
    "normalizes %j for an SRT filename",
    (mediaType) => {
      expect(normalizedChatAttachmentMediaType({ mediaType, filename: "captions.SRT" })).toBe(
        CHAT_SRT_MIME_TYPE,
      );
    },
  );

  it("does not treat generic text files as subtitles", () => {
    expect(
      normalizedChatAttachmentMediaType({ mediaType: "text/plain", filename: "notes.txt" }),
    ).toBe("text/plain");
  });

  it.each([
    ["", "customers.csv", "text/csv"],
    ["application/octet-stream", "customers.tsv", "text/tab-separated-values"],
    ["text/plain", "memo.md", "text/markdown"],
    ["application/vnd.ms-excel", "export.csv", "text/csv"],
    ["application/octet-stream", "payload.json", "application/json"],
  ])("normalizes %j for %j", (mediaType, filename, expected) => {
    expect(normalizedChatAttachmentMediaType({ mediaType, filename })).toBe(expected);
  });
});

describe("validateChatAttachmentCandidate", () => {
  it("accepts a pdf up to 20 MB", () => {
    expect(
      validateChatAttachmentCandidate({
        mediaType: "application/pdf",
        sizeBytes: CHAT_ATTACHMENT_MAX_BYTES,
      }),
    ).toEqual({ ok: true, kind: "pdf", mediaType: "application/pdf" });
    expect(
      validateChatAttachmentCandidate({
        mediaType: "application/pdf",
        sizeBytes: CHAT_ATTACHMENT_MAX_BYTES + 1,
      }),
    ).toMatchObject({ ok: false, reason: "size" });
  });

  it("caps images at 5 MB", () => {
    expect(
      validateChatAttachmentCandidate({
        mediaType: "image/png",
        sizeBytes: CHAT_IMAGE_MAX_BYTES,
      }),
    ).toEqual({ ok: true, kind: "image", mediaType: "image/png" });
    expect(
      validateChatAttachmentCandidate({
        mediaType: "image/png",
        sizeBytes: CHAT_IMAGE_MAX_BYTES + 1,
      }),
    ).toMatchObject({ ok: false, reason: "size" });
  });

  it("rejects empty files and unknown types", () => {
    expect(
      validateChatAttachmentCandidate({ mediaType: "application/pdf", sizeBytes: 0 }),
    ).toMatchObject({ ok: false, reason: "size" });
    expect(
      validateChatAttachmentCandidate({ mediaType: "application/zip", sizeBytes: 10 }),
    ).toMatchObject({ ok: false, reason: "type" });
  });

  it("accepts SRT files despite inconsistent browser MIME types", () => {
    expect(
      validateChatAttachmentCandidate({
        mediaType: "",
        filename: "captions.srt",
        sizeBytes: 100,
      }),
    ).toEqual({ ok: true, kind: "srt", mediaType: CHAT_SRT_MIME_TYPE });
    expect(
      validateChatAttachmentCandidate({
        mediaType: "text/srt",
        filename: "captions.txt",
        sizeBytes: 100,
      }),
    ).toMatchObject({ ok: false, reason: "type" });
  });

  it("accepts text-like founder files despite inconsistent browser MIME types", () => {
    expect(
      validateChatAttachmentCandidate({
        mediaType: "application/octet-stream",
        filename: "customers.csv",
        sizeBytes: 100,
      }),
    ).toEqual({ ok: true, kind: "csv", mediaType: "text/csv" });
    expect(
      validateChatAttachmentCandidate({
        mediaType: "application/vnd.ms-excel",
        filename: "legacy.xls",
        sizeBytes: 100,
      }),
    ).toMatchObject({ ok: false, reason: "type" });
  });
});
