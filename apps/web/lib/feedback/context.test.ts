import { describe, expect, it } from "vitest";
import { feedbackContextFromPathname, feedbackContextLabel } from "./context";

describe("feedbackContextFromPathname", () => {
  it("references the chat session or task the reporter is viewing", () => {
    expect(feedbackContextFromPathname("/chat/ses_123")).toEqual({ kind: "chat", id: "ses_123" });
    expect(feedbackContextFromPathname("/tasks/tsk_123")).toEqual({ kind: "task", id: "tsk_123" });
  });

  it("keeps the task reference on the harness run sub-route", () => {
    expect(feedbackContextFromPathname("/tasks/tsk_123/run")).toEqual({
      kind: "task",
      id: "tsk_123",
    });
  });

  it("decodes escaped ids", () => {
    expect(feedbackContextFromPathname("/chat/ses%20123")).toEqual({
      kind: "chat",
      id: "ses 123",
    });
  });

  it("attaches nothing outside a session route", () => {
    for (const pathname of [
      null,
      "/",
      "/tasks",
      "/chat",
      "/brain/notes/ses_123",
      "/plugins/linear",
      "/chat/%E0%A4%A",
      `/chat/${"x".repeat(129)}`,
    ]) {
      expect(feedbackContextFromPathname(pathname)).toBeNull();
    }
  });
});

describe("feedbackContextLabel", () => {
  it("names the reference in the reporter's words", () => {
    expect(feedbackContextLabel({ kind: "chat", id: "ses_1" })).toBe("this chat session");
    expect(feedbackContextLabel({ kind: "task", id: "tsk_1" })).toBe("this task");
  });
});
