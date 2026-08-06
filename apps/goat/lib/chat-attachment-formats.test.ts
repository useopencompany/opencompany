import { describe, expect, it } from "vitest";
import {
  GOAT_CHAT_ATTACHMENT_MAX_BYTES,
  GOAT_CHAT_IMAGE_MAX_BYTES,
  GOAT_CHAT_SRT_MIME_TYPE,
  goatChatAttachmentKindForMime,
  normalizedGoatChatAttachmentMediaType,
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
    expect(goatChatAttachmentKindForMime("application/x-subrip")).toBe("srt");
    expect(goatChatAttachmentKindForMime("text/srt")).toBe("srt");
    expect(goatChatAttachmentKindForMime("text/csv")).toBe("csv");
    expect(goatChatAttachmentKindForMime("text/tab-separated-values")).toBe("tsv");
    expect(goatChatAttachmentKindForMime("application/json")).toBe("json");
    expect(goatChatAttachmentKindForMime("text/markdown")).toBe("text");
    expect(goatChatAttachmentKindForMime("text/plain")).toBe("text");
  });

  it("rejects legacy office formats and gif", () => {
    expect(goatChatAttachmentKindForMime("application/msword")).toBeNull();
    expect(goatChatAttachmentKindForMime("application/vnd.ms-excel")).toBeNull();
    expect(goatChatAttachmentKindForMime("image/gif")).toBeNull();
  });
});

describe("normalizedGoatChatAttachmentMediaType", () => {
  it.each([
    "",
    "text/plain",
    "application/octet-stream",
    "text/srt",
  ])("normalizes %j for an SRT filename", (mediaType) => {
    expect(normalizedGoatChatAttachmentMediaType({ mediaType, filename: "captions.SRT" })).toBe(
      GOAT_CHAT_SRT_MIME_TYPE,
    );
  });

  it("does not treat generic text files as subtitles", () => {
    expect(
      normalizedGoatChatAttachmentMediaType({ mediaType: "text/plain", filename: "notes.txt" }),
    ).toBe("text/plain");
  });

  it.each([
    ["", "customers.csv", "text/csv"],
    ["application/octet-stream", "customers.tsv", "text/tab-separated-values"],
    ["text/plain", "memo.md", "text/markdown"],
    ["application/vnd.ms-excel", "export.csv", "text/csv"],
    ["application/octet-stream", "payload.json", "application/json"],
  ])("normalizes %j for %j", (mediaType, filename, expected) => {
    expect(normalizedGoatChatAttachmentMediaType({ mediaType, filename })).toBe(expected);
  });
});

describe("validateGoatChatAttachmentCandidate", () => {
  it("accepts a pdf up to 20 MB", () => {
    expect(
      validateGoatChatAttachmentCandidate({
        mediaType: "application/pdf",
        sizeBytes: GOAT_CHAT_ATTACHMENT_MAX_BYTES,
      }),
    ).toEqual({ ok: true, kind: "pdf", mediaType: "application/pdf" });
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
    ).toEqual({ ok: true, kind: "image", mediaType: "image/png" });
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

  it("accepts SRT files despite inconsistent browser MIME types", () => {
    expect(
      validateGoatChatAttachmentCandidate({
        mediaType: "",
        filename: "captions.srt",
        sizeBytes: 100,
      }),
    ).toEqual({ ok: true, kind: "srt", mediaType: GOAT_CHAT_SRT_MIME_TYPE });
    expect(
      validateGoatChatAttachmentCandidate({
        mediaType: "text/srt",
        filename: "captions.txt",
        sizeBytes: 100,
      }),
    ).toMatchObject({ ok: false, reason: "type" });
  });

  it("accepts text-like founder files despite inconsistent browser MIME types", () => {
    expect(
      validateGoatChatAttachmentCandidate({
        mediaType: "application/octet-stream",
        filename: "customers.csv",
        sizeBytes: 100,
      }),
    ).toEqual({ ok: true, kind: "csv", mediaType: "text/csv" });
    expect(
      validateGoatChatAttachmentCandidate({
        mediaType: "application/vnd.ms-excel",
        filename: "legacy.xls",
        sizeBytes: 100,
      }),
    ).toMatchObject({ ok: false, reason: "type" });
  });
});
