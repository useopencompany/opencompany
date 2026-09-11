import { describe, expect, it } from "vitest";
import { countAwaitingReview, selectReviewItems } from "@/lib/review-inbox";

type ConversationInput = Parameters<typeof selectReviewItems>[0]["conversations"][number];
type TaskInput = Parameters<typeof selectReviewItems>[0]["tasks"][number];

function conversation(overrides: Partial<ConversationInput> & { id: string }): ConversationInput {
  return {
    title: `Conversation ${overrides.id}`,
    model: "claude-opus-5",
    engine: "opencompany",
    updatedAt: "2026-09-10T10:00:00.000Z",
    archivedAt: null,
    activityState: "idle",
    hasUnseen: true,
    ...overrides,
  };
}

function task(overrides: Partial<TaskInput> & { id: string }): TaskInput {
  return {
    displayId: `TASK-${overrides.id}`,
    name: `Task ${overrides.id}`,
    conversationId: `conversation_${overrides.id}`,
    status: "succeeded",
    hasUnseen: true,
    archivedAt: null,
    updatedAt: "2026-09-10T10:00:00.000Z",
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
        source: { kind: "chat", model: "claude-opus-5", engine: "opencompany" },
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

  // A Task's own conversation is never projected into the conversation read model
  // (refresh_conversation_read_model_v1 keeps only kind 'chat'), so the Task read model is the
  // only place a finished Task result can come from.
  it("includes an unread task result from the task read model", () => {
    const items = selectReviewItems({
      conversations: [],
      tasks: [
        task({
          id: "t1",
          displayId: "TASK-42",
          name: "Refresh the pipeline",
          conversationId: "c9",
        }),
      ],
    });

    expect(items).toEqual([
      {
        conversationId: "c9",
        title: "Refresh the pipeline",
        updatedAt: "2026-09-10T10:00:00.000Z",
        source: { kind: "task", taskId: "t1", displayId: "TASK-42" },
      },
    ]);
  });

  it("includes a failed task result, which is still something to read", () => {
    const items = selectReviewItems({
      conversations: [],
      tasks: [task({ id: "t1", status: "failed" })],
    });

    expect(items.map((item) => item.source)).toEqual([
      { kind: "task", taskId: "t1", displayId: "TASK-t1" },
    ]);
  });

  it("excludes tasks that are unfinished, waiting on input, seen, or archived", () => {
    const items = selectReviewItems({
      conversations: [],
      tasks: [
        task({ id: "queued", status: "queued" }),
        task({ id: "running", status: "running" }),
        task({ id: "waiting", status: "waiting" }),
        task({ id: "canceled", status: "canceled" }),
        task({ id: "seen", hasUnseen: false }),
        task({ id: "archived", archivedAt: "2026-09-09T10:00:00.000Z" }),
        task({ id: "unread" }),
      ],
    });

    expect(items.map((item) => item.source)).toEqual([
      { kind: "task", taskId: "unread", displayId: "TASK-unread" },
    ]);
  });

  it("sorts tasks and chats together, newest first", () => {
    const items = selectReviewItems({
      conversations: [
        conversation({ id: "older-chat", updatedAt: "2026-09-10T08:00:00.000Z" }),
        conversation({ id: "newest-chat", updatedAt: "2026-09-10T14:00:00.000Z" }),
      ],
      tasks: [
        task({ id: "t1", conversationId: "middle-task", updatedAt: "2026-09-10T12:00:00.000Z" }),
      ],
    });

    expect(items.map((item) => item.conversationId)).toEqual([
      "newest-chat",
      "middle-task",
      "older-chat",
    ]);
  });
});

describe("countAwaitingReview", () => {
  it("counts unread, unarchived, settled work from both sources", () => {
    const count = countAwaitingReview({
      conversations: [
        conversation({ id: "unread-a" }),
        conversation({ id: "unread-b" }),
        conversation({ id: "working", activityState: "working" }),
        conversation({ id: "seen", hasUnseen: false }),
        conversation({ id: "archived", archivedAt: "2026-09-09T10:00:00.000Z" }),
      ],
      tasks: [
        task({ id: "unread-task" }),
        task({ id: "waiting", status: "waiting" }),
        task({ id: "seen-task", hasUnseen: false }),
      ],
    });

    expect(count).toBe(3);
  });
});
