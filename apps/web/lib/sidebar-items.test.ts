import { describe, expect, it } from "vitest";
import type { ChatSummaryView } from "./chat-ui";
import {
  orderSidebarWorkItems,
  type SidebarTaskView,
  selectSidebarChats,
  selectSidebarTasks,
  sidebarTaskState,
} from "./sidebar-items";

const now = Date.parse("2026-08-25T12:00:00.000Z");

describe("selectSidebarChats", () => {
  it("uses one stable policy for pinned, working, recent, and archived chats", () => {
    const recent = Array.from({ length: 10 }, (_, index) =>
      chat(`recent_${index}`, {
        updatedAt: new Date(now - index * 60_000).toISOString(),
      }),
    );

    const selected = selectSidebarChats(
      [
        ...recent,
        chat("archived", { archivedAt: new Date(now).toISOString() }),
        chat("old", { updatedAt: new Date(now - 8 * 24 * 60 * 60 * 1_000).toISOString() }),
        chat("old_working", {
          activityState: "working",
          updatedAt: new Date(now - 30 * 24 * 60 * 60 * 1_000).toISOString(),
        }),
        chat("old_pinned", {
          pinnedAt: new Date(now - 1_000).toISOString(),
          updatedAt: new Date(now - 30 * 24 * 60 * 60 * 1_000).toISOString(),
        }),
      ],
      now,
    );

    expect(selected.map((entry) => entry.id)).toEqual([
      "old_pinned",
      "old_working",
      "recent_0",
      "recent_1",
      "recent_2",
      "recent_3",
      "recent_4",
      "recent_5",
      "recent_6",
      "recent_7",
    ]);
  });
});

describe("selectSidebarTasks", () => {
  it("keeps an old waiting task listed, because it is blocked on the reader", () => {
    const selected = selectSidebarTasks(
      [
        task("old_waiting", {
          status: "waiting",
          updatedAt: new Date(now - 30 * 24 * 60 * 60 * 1_000).toISOString(),
        }),
        task("old_finished", {
          status: "succeeded",
          updatedAt: new Date(now - 30 * 24 * 60 * 60 * 1_000).toISOString(),
        }),
      ],
      now,
    );

    expect(selected.map((entry) => entry.id)).toEqual(["old_waiting"]);
  });

  it("bounds the unfinished bucket so a task fan-out cannot fill the column", () => {
    const running = Array.from({ length: 12 }, (_, index) =>
      task(`running_${index}`, {
        status: "running",
        updatedAt: new Date(now - index * 60_000).toISOString(),
      }),
    );

    expect(selectSidebarTasks(running, now)).toHaveLength(8);
  });

  it("keeps running tasks, bounds finished ones by recency, and drops archived ones", () => {
    const recent = Array.from({ length: 10 }, (_, index) =>
      task(`recent_${index}`, {
        status: "succeeded",
        updatedAt: new Date(now - index * 60_000).toISOString(),
      }),
    );

    const selected = selectSidebarTasks(
      [
        ...recent,
        task("archived", {
          status: "succeeded",
          archivedAt: new Date(now).toISOString(),
        }),
        task("old", {
          status: "failed",
          updatedAt: new Date(now - 8 * 24 * 60 * 60 * 1_000).toISOString(),
        }),
        task("old_running", {
          status: "running",
          updatedAt: new Date(now - 30 * 24 * 60 * 60 * 1_000).toISOString(),
        }),
        task("queued", {
          status: "queued",
          updatedAt: new Date(now - 10_000).toISOString(),
        }),
      ],
      now,
    );

    expect(selected.map((entry) => entry.id)).toEqual([
      "queued",
      "old_running",
      "recent_0",
      "recent_1",
      "recent_2",
      "recent_3",
      "recent_4",
      "recent_5",
      "recent_6",
      "recent_7",
    ]);
  });
});

describe("sidebarTaskState", () => {
  it("reports a running task as working regardless of its unread flag", () => {
    expect(sidebarTaskState({ status: "queued", hasUnseen: true })).toBe("working");
    expect(sidebarTaskState({ status: "running", hasUnseen: false })).toBe("working");
  });

  it("reports a settled task with an unread result as unseen", () => {
    expect(sidebarTaskState({ status: "succeeded", hasUnseen: true })).toBe("done_unseen");
    expect(sidebarTaskState({ status: "failed", hasUnseen: true })).toBe("done_unseen");
    // A waiting run has paused for an approval, which is exactly when it needs the dot.
    expect(sidebarTaskState({ status: "waiting", hasUnseen: true })).toBe("done_unseen");
  });

  it("reports a read task as seen", () => {
    expect(sidebarTaskState({ status: "succeeded", hasUnseen: false })).toBe("done_seen");
  });

  it("withholds the dot from a canceled run, which has nothing that would clear it", () => {
    expect(sidebarTaskState({ status: "canceled", hasUnseen: true })).toBe("done_seen");
  });
});

describe("orderSidebarWorkItems", () => {
  it("leads with unfinished work before falling back to recency", () => {
    const items = orderSidebarWorkItems({
      chats: [
        chatSummary("chat_newest", { updatedAt: "2026-08-25T12:00:00.000Z" }),
        chatSummary("chat_streaming", {
          updatedAt: "2026-08-01T09:00:00.000Z",
          activityState: "working",
        }),
      ],
      tasks: [
        taskView("task_blocked", {
          status: "waiting",
          hasUnseen: true,
          updatedAt: "2026-08-02T09:00:00.000Z",
        }),
      ],
    });

    expect(items.map((item) => item.id)).toEqual(["task_blocked", "chat_streaming", "chat_newest"]);
  });

  it("interleaves chats and tasks by recency and resolves both row states", () => {
    const items = orderSidebarWorkItems({
      chats: [
        chatSummary("chat_new", {
          updatedAt: "2026-08-25T11:59:00.000Z",
          activityState: "idle",
          hasUnseen: true,
        }),
        chatSummary("chat_old", { updatedAt: "2026-08-25T09:00:00.000Z" }),
      ],
      tasks: [
        taskView("task_newest", {
          name: "Newest task",
          status: "running",
          updatedAt: "2026-08-25T12:00:00.000Z",
        }),
        taskView("task_middle", {
          name: "Middle task",
          status: "succeeded",
          hasUnseen: true,
          updatedAt: "2026-08-25T10:00:00.000Z",
        }),
      ],
    });

    expect(items.map((item) => [item.kind, item.id, item.state])).toEqual([
      ["task", "task_newest", "working"],
      ["chat", "chat_new", "done_unseen"],
      ["task", "task_middle", "done_unseen"],
      ["chat", "chat_old", "done_seen"],
    ]);
    expect(items.map((item) => item.title)).toEqual([
      "Newest task",
      "chat_new title",
      "Middle task",
      "chat_old title",
    ]);
  });
});

function chat(
  id: string,
  overrides: Partial<{
    activityState: "working" | "idle";
    archivedAt: string | null;
    pinnedAt: string | null;
    updatedAt: string;
  }> = {},
) {
  return {
    id,
    activityState: "idle" as const,
    archivedAt: null,
    pinnedAt: null,
    updatedAt: "2026-08-25T12:00:00.000Z",
    ...overrides,
  };
}

function task(
  id: string,
  overrides: Partial<{
    status: SidebarTaskView["status"];
    archivedAt: string | null;
    updatedAt: string;
  }> = {},
) {
  return {
    id,
    status: "succeeded" as SidebarTaskView["status"],
    archivedAt: null,
    updatedAt: "2026-08-25T12:00:00.000Z",
    ...overrides,
  };
}

function chatSummary(id: string, overrides: Partial<ChatSummaryView> = {}): ChatSummaryView {
  return {
    id,
    title: `${id} title`,
    model: "anthropic/claude-sonnet-5",
    engine: "opencompany",
    preview: "Ready",
    updatedAt: "2026-08-25T12:00:00.000Z",
    pinnedAt: null,
    activityState: "idle",
    hasUnseen: false,
    ...overrides,
  };
}

function taskView(id: string, overrides: Partial<SidebarTaskView> = {}): SidebarTaskView {
  return {
    id,
    conversationId: `conversation_${id}`,
    displayId: id.toUpperCase(),
    name: `${id} name`,
    status: "succeeded",
    hasUnseen: false,
    updatedAt: "2026-08-25T12:00:00.000Z",
    ...overrides,
  };
}
