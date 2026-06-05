import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_PER_MESSAGE,
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
    expect(attachmentKindForMime("text/plain")).toBeNull();
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
