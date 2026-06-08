import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_PER_MESSAGE,
  ATTACHMENT_TEXT_MAX_BYTES,
  attachmentKindForMime,
  isAllowedAttachmentMime,
  modelSupportsAttachments,
  validateAttachmentCandidate,
} from "./attachments";
import { AGENT_MODEL_CATALOG } from "./models";

describe("attachment validation", () => {
  it("classifies image and pdf mime types", () => {
    expect(attachmentKindForMime("image/png")).toBe("image");
    expect(attachmentKindForMime("application/pdf")).toBe("pdf");
  });

  it("classifies text by mime type", () => {
    expect(attachmentKindForMime("text/markdown")).toBe("text");
  });

  it("classifies code files by extension when the mime is octet-stream", () => {
    expect(attachmentKindForMime("application/octet-stream", "a.ts")).toBe("text");
  });

  it("returns null for an unknown octet-stream file", () => {
    expect(attachmentKindForMime("application/octet-stream", "a.bin")).toBeNull();
  });

  it("allows the supported mime set only", () => {
    expect(isAllowedAttachmentMime("image/jpeg")).toBe(true);
    expect(isAllowedAttachmentMime("image/svg+xml")).toBe(false);
  });

  it("rejects oversized files", () => {
    const result = validateAttachmentCandidate({
      mediaType: "image/png",
      sizeBytes: ATTACHMENT_MAX_BYTES + 1,
    });
    expect(result.ok).toBe(false);
  });

  it("accepts a valid candidate", () => {
    const result = validateAttachmentCandidate({ mediaType: "application/pdf", sizeBytes: 1000 });
    expect(result).toEqual({ ok: true, kind: "pdf" });
  });

  it("accepts a valid image candidate", () => {
    const result = validateAttachmentCandidate({ mediaType: "image/png", sizeBytes: 1000 });
    expect(result).toEqual({ ok: true, kind: "image" });
  });

  it("enforces the smaller text size cap", () => {
    const result = validateAttachmentCandidate({
      mediaType: "application/octet-stream",
      sizeBytes: ATTACHMENT_TEXT_MAX_BYTES + 1,
      filename: "notes.md",
    });
    expect(result).toEqual({ ok: false, reason: "size" });
  });

  it("exposes a per-message cap", () => {
    expect(ATTACHMENT_MAX_PER_MESSAGE).toBe(10);
  });
});

describe("modelSupportsAttachments", () => {
  it("reports image support for a vision model id", () => {
    const visionModel = AGENT_MODEL_CATALOG.find((m) => m.supportsImages);
    expect(visionModel).toBeDefined();
    expect(modelSupportsAttachments(visionModel!.id).images).toBe(true);
  });

  it("returns all-false for an unknown model id", () => {
    expect(modelSupportsAttachments("nonexistent/model")).toEqual({ images: false, pdf: false });
  });
});
