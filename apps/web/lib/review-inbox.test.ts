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
    lastSeenAt: null,
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
        unread: true,
        source: { kind: "chat", model: "claude-opus-5", engine: "opencompany" },
      },
    ]);
  });

  // Reading something is not the same as being done with it. The queue is a place to come back
  // to, so a read item stays until the reader archives it.
  it("keeps a read conversation in the queue and marks it read", () => {
    const items = selectReviewItems({
      conversations: [
        conversation({ id: "read", hasUnseen: false, lastSeenAt: "2026-09-10T10:05:00.000Z" }),
      ],
      tasks: [],
    });

    expect(items.map((item) => ({ id: item.conversationId, unread: item.unread }))).toEqual([
      { id: "read", unread: false },
    ]);
  });

  it("excludes conversations that are still working or archived", () => {
    const items = selectReviewItems({
      conversations: [
        conversation({ id: "working", activityState: "working" }),
        conversation({ id: "archived", archivedAt: "2026-09-09T10:00:00.000Z" }),
        conversation({ id: "unread" }),
      ],
      tasks: [],
    });

    expect(items.map((item) => item.conversationId)).toEqual(["unread"]);
  });

  // A conversation nobody has written in or been notified about never produced a result, so it is
  // not something to review — it would only pad the queue with empty rows.
  it("excludes a conversation that was never read and never had unread output", () => {
    const items = selectReviewItems({
      conversations: [conversation({ id: "untouched", hasUnseen: false, lastSeenAt: null })],
      tasks: [],
    });

    expect(items).toEqual([]);
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
        unread: true,
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

  it("keeps a read task result in the queue and marks it read", () => {
    const items = selectReviewItems({
      conversations: [],
      tasks: [task({ id: "read", hasUnseen: false })],
    });

    expect(items.map((item) => ({ id: item.source, unread: item.unread }))).toEqual([
      { id: { kind: "task", taskId: "read", displayId: "TASK-read" }, unread: false },
    ]);
  });

  it("excludes tasks that are unfinished, waiting on input, canceled, or archived", () => {
    const items = selectReviewItems({
      conversations: [],
      tasks: [
        task({ id: "queued", status: "queued" }),
        task({ id: "running", status: "running" }),
        task({ id: "waiting", status: "waiting" }),
        task({ id: "canceled", status: "canceled" }),
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

  // Read items stay until they are archived, so the list needs a tail. Unread work is never cut:
  // it is the reason the queue exists.
  it("keeps every unread item but drops read items past the tail", () => {
    const read = Array.from({ length: 60 }, (_, index) =>
      conversation({
        id: `read-${index}`,
        hasUnseen: false,
        lastSeenAt: "2026-09-01T10:00:00.000Z",
        updatedAt: `2026-09-10T10:${String(index).padStart(2, "0")}:00.000Z`,
      }),
    );
    const unread = Array.from({ length: 5 }, (_, index) =>
      conversation({ id: `unread-${index}`, updatedAt: "2026-08-01T10:00:00.000Z" }),
    );

    const items = selectReviewItems({ conversations: [...read, ...unread], tasks: [] });

    expect(items.filter((item) => item.unread)).toHaveLength(5);
    expect(items.filter((item) => !item.unread)).toHaveLength(50);
    // The tail cuts the oldest read rows, not the newest.
    expect(items.some((item) => item.conversationId === "read-59")).toBe(true);
    expect(items.some((item) => item.conversationId === "read-0")).toBe(false);
  });
});

describe("countAwaitingReview", () => {
  it("counts unread, unarchived, settled work from both sources", () => {
    const count = countAwaitingReview({
      conversations: [
        conversation({ id: "unread-a" }),
        conversation({ id: "unread-b" }),
        conversation({ id: "working", activityState: "working" }),
        conversation({ id: "seen", hasUnseen: false, lastSeenAt: "2026-09-10T10:05:00.000Z" }),
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
