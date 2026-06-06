import { describe, expect, it } from "vitest";
import {
  buildMessageAttachments,
  buildModelMessageContent,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BYTES,
  normalizePromptAttachments,
  toAttachmentMeta,
  validatePromptAttachments,
} from "./attachments";

describe("normalizePromptAttachments", () => {
  it("drops empty-content entries and coerces non-strings", () => {
    const result = normalizePromptAttachments([
      { label: "a", content: "hello" },
      { label: "b", content: "" },
      { label: 5 as unknown as string, content: "world" },
    ]);
    expect(result).toEqual([
      { label: "a", content: "hello" },
      { label: "", content: "world" },
    ]);
  });
});

describe("validatePromptAttachments", () => {
  it("accepts attachments within the caps", () => {
    expect(validatePromptAttachments([{ label: "x", content: "short" }])).toEqual({ ok: true });
  });

  it("rejects too many attachments", () => {
    const many = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 1 }, (_, i) => ({
      label: `${i}`,
      content: "x",
    }));
    expect(validatePromptAttachments(many).ok).toBe(false);
  });

  it("rejects an oversized attachment", () => {
    const big = "a".repeat(MAX_ATTACHMENT_BYTES + 1);
    expect(validatePromptAttachments([{ label: "big", content: big }]).ok).toBe(false);
  });
});

describe("buildMessageAttachments", () => {
  it("assigns deterministic paste filenames and measures size", () => {
    const built = buildMessageAttachments("msg_1", [
      { label: "first", content: "line one\nline two" },
      { label: "second", content: "solo" },
    ]);
    expect(built[0]?.filename).toBe("pasted/msg_1-0.txt");
    expect(built[1]?.filename).toBe("pasted/msg_1-1.txt");
    expect(built[0]?.lineCount).toBe(2);
    expect(built[0]?.bytes).toBe("line one\nline two".length);
  });
});

describe("buildModelMessageContent", () => {
  it("references the file path as plain text in the content", () => {
    const built = buildMessageAttachments("msg_1", [{ label: "doc", content: "big blob" }]);
    const content = buildModelMessageContent("please review", built);
    expect(content).toContain("please review");
    expect(content).toContain("work/pasted/msg_1-0.txt");
    // The reference is plain text inside content (a string). The runner replays
    // `{ role: "user", content }` through the strict modelMessageSchema, so the reference must
    // never become a structured/extra key — see model-messages.test.ts for that guarantee.
    expect(typeof content).toBe("string");
  });

  it("is just the reference block when there is no typed text", () => {
    const built = buildMessageAttachments("msg_2", [{ label: "doc", content: "blob" }]);
    const content = buildModelMessageContent("", built);
    expect(content.startsWith("[The user attached")).toBe(true);
  });
});

describe("toAttachmentMeta", () => {
  it("strips the content from each attachment", () => {
    const built = buildMessageAttachments("msg_1", [{ label: "doc", content: "secret" }]);
    const meta = toAttachmentMeta(built);
    expect(meta[0]).not.toHaveProperty("content");
    expect(meta[0]?.filename).toBe("pasted/msg_1-0.txt");
  });
});
