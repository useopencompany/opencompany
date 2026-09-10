import { describe, expect, it } from "vitest";
import { countAwaitingReview, groupReviewItems, selectReviewItems } from "@/lib/review-inbox";

type ConversationInput = Parameters<typeof selectReviewItems>[0]["conversations"][number];
type TaskInput = Parameters<typeof selectReviewItems>[0]["tasks"][number];

function conversation(overrides: Partial<ConversationInput> & { id: string }): ConversationInput {
  return {
    title: `Conversation ${overrides.id}`,
    updatedAt: "2026-09-10T10:00:00.000Z",
    archivedAt: null,
    activityState: "idle",
    hasUnseen: true,
    ...overrides,
  };
}

function task(overrides: Partial<TaskInput> & { id: string }): TaskInput {
  return {
    display_id: `TASK-${overrides.id}`,
    session_id: null,
    archived_at: null,
    ...overrides,
  };
}

describe("selectReviewItems", () => {
  it("includes finished conversations the user has not read", () => {
    const items = selectReviewItems({
      conversations: [conversation({ id: "c1", title: "Draft the update" })],
      tasks: [],
    });

    expect(items).toEqual([
      {
        conversationId: "c1",
        title: "Draft the update",
        updatedAt: "2026-09-10T10:00:00.000Z",
        source: { kind: "chat" },
      },
    ]);
  });

  it("excludes conversations that are still working, already seen, or archived", () => {
    const items = selectReviewItems({
      conversations: [
        conversation({ id: "working", activityState: "working" }),
        conversation({ id: "seen", hasUnseen: false }),
        conversation({ id: "archived", archivedAt: "2026-09-09T10:00:00.000Z" }),
        conversation({ id: "unread" }),
      ],
      tasks: [],
    });

    expect(items.map((item) => item.conversationId)).toEqual(["unread"]);
  });

  it("labels a conversation that backs a task with its task identity", () => {
    const items = selectReviewItems({
      conversations: [conversation({ id: "c1" })],
      tasks: [task({ id: "t1", display_id: "TASK-42", session_id: "c1" })],
    });

    expect(items[0]?.source).toEqual({ kind: "task", taskId: "t1", displayId: "TASK-42" });
  });

  it("treats an archived task's conversation as a plain chat rather than dropping it", () => {
    const items = selectReviewItems({
      conversations: [conversation({ id: "c1" })],
      tasks: [task({ id: "t1", session_id: "c1", archived_at: "2026-09-09T10:00:00.000Z" })],
    });

    expect(items[0]?.source).toEqual({ kind: "chat" });
  });

  it("sorts newest first", () => {
    const items = selectReviewItems({
      conversations: [
        conversation({ id: "older", updatedAt: "2026-09-10T08:00:00.000Z" }),
        conversation({ id: "newer", updatedAt: "2026-09-10T12:00:00.000Z" }),
      ],
      tasks: [],
    });

    expect(items.map((item) => item.conversationId)).toEqual(["newer", "older"]);
  });
});

describe("countAwaitingReview", () => {
  it("counts only unread, unarchived, settled conversations", () => {
    const count = countAwaitingReview({
      conversations: [
        conversation({ id: "unread-a" }),
        conversation({ id: "unread-b" }),
        conversation({ id: "working", activityState: "working" }),
        conversation({ id: "seen", hasUnseen: false }),
        conversation({ id: "archived", archivedAt: "2026-09-09T10:00:00.000Z" }),
      ],
    });

    expect(count).toBe(2);
  });
});

describe("groupReviewItems", () => {
  it("splits task results from chat replies and drops empty groups", () => {
    const items = selectReviewItems({
      conversations: [
        conversation({ id: "c1", updatedAt: "2026-09-10T12:00:00.000Z" }),
        conversation({ id: "c2", updatedAt: "2026-09-10T11:00:00.000Z" }),
      ],
      tasks: [task({ id: "t1", display_id: "TASK-7", session_id: "c1" })],
    });

    expect(groupReviewItems(items)).toEqual([
      {
        kind: "task",
        label: "Task results",
        items: [expect.objectContaining({ conversationId: "c1" })],
      },
      {
        kind: "chat",
        label: "Chat replies",
        items: [expect.objectContaining({ conversationId: "c2" })],
      },
    ]);
  });

  it("returns no groups for an empty queue", () => {
    expect(groupReviewItems([])).toEqual([]);
  });
});
