import { describe, expect, it } from "vitest";
import { selectSidebarChats } from "./sidebar-chats";

describe("selectSidebarChats", () => {
  const now = Date.parse("2026-08-25T12:00:00.000Z");

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
