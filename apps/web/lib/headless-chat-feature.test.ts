import { describe, expect, it } from "vitest";
import { hasChatAttachmentTransportMismatch, isHeadlessChatEnabled } from "./headless-chat-feature";

describe("headless Chat rollout boundary", () => {
  it("requires the authorized service rollout before selecting canonical Chat", () => {
    expect(isHeadlessChatEnabled(undefined)).toBe(false);
    expect(isHeadlessChatEnabled("true")).toBe(true);
    expect(isHeadlessChatEnabled("false")).toBe(false);
  });

  it("requires re-upload when attachments cross the canonical/legacy transport switch", () => {
    const canonical = [{ id: "attachment_1" }];
    const legacy = [
      {
        id: "local_1",
        blobUrl: "https://blob.example.test/private/file.pdf",
        blobPathname: "private/file.pdf",
      },
    ];

    expect(hasChatAttachmentTransportMismatch(canonical, true)).toBe(false);
    expect(hasChatAttachmentTransportMismatch(legacy, false)).toBe(false);
    expect(hasChatAttachmentTransportMismatch(canonical, false)).toBe(true);
    expect(hasChatAttachmentTransportMismatch(legacy, true)).toBe(true);
  });
});
