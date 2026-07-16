import { describe, expect, it, vi } from "vitest";
import type { FathomMeetingsPage } from "./fathom-api";
import {
  fathomCursorAfterCompletedWindow,
  listFathomMeetingsWindow,
} from "./goat-fathom-poll-worker";

describe("Fathom poll pagination", () => {
  it("returns a continuation cursor instead of advancing past unprocessed pages", async () => {
    const listMeetings = vi.fn(async (input: { cursor?: string }): Promise<FathomMeetingsPage> => {
      const page = input.cursor ? Number(input.cursor.slice(1)) : 0;
      return {
        meetings: [
          {
            recordingId: `rec_${page}`,
            title: `Meeting ${page}`,
            createdAt: `2026-07-16T10:0${page}:00.000Z`,
            raw: {},
          },
        ],
        nextCursor: page < 5 ? `c${page + 1}` : null,
      };
    });
    const signal = new AbortController().signal;

    const firstBatch = await listFathomMeetingsWindow({
      apiKey: "fathom_test",
      createdAfter: "2026-07-16T09:00:00.000Z",
      createdBefore: "2026-07-16T10:00:00.000Z",
      signal,
      listMeetings,
    });
    expect(firstBatch.meetings).toHaveLength(5);
    expect(firstBatch.nextCursor).toBe("c5");
    if (!firstBatch.nextCursor) throw new Error("Expected a Fathom continuation cursor.");

    const finalBatch = await listFathomMeetingsWindow({
      apiKey: "fathom_test",
      createdAfter: "2026-07-16T09:00:00.000Z",
      createdBefore: "2026-07-16T10:00:00.000Z",
      cursor: firstBatch.nextCursor,
      signal,
      listMeetings,
    });
    expect(finalBatch.meetings.map((meeting) => meeting.recordingId)).toEqual(["rec_5"]);
    expect(finalBatch.nextCursor).toBeNull();
    expect(listMeetings).toHaveBeenCalledTimes(6);
  });

  it("keeps the window filters constant across continuation pages", async () => {
    const listMeetings = vi.fn(
      async (input: {
        createdAfter?: string;
        createdBefore?: string;
        cursor?: string;
      }): Promise<FathomMeetingsPage> => ({
        meetings: [],
        nextCursor: input.cursor ? null : "c1",
      }),
    );

    await listFathomMeetingsWindow({
      apiKey: "fathom_test",
      createdAfter: "2026-07-16T09:00:00.000Z",
      createdBefore: "2026-07-16T10:00:00.000Z",
      signal: new AbortController().signal,
      listMeetings,
    });

    expect(listMeetings).toHaveBeenCalledTimes(2);
    for (const [call] of listMeetings.mock.calls) {
      expect(call.createdAfter).toBe("2026-07-16T09:00:00.000Z");
      expect(call.createdBefore).toBe("2026-07-16T10:00:00.000Z");
    }
  });

  it("rejects a cursor cycle within a pagination batch", async () => {
    const cursors = ["c1", "c2", "c1"];
    let call = 0;
    await expect(
      listFathomMeetingsWindow({
        apiKey: "fathom_test",
        createdAfter: "2026-07-16T09:00:00.000Z",
        createdBefore: "2026-07-16T10:00:00.000Z",
        signal: new AbortController().signal,
        listMeetings: async () => ({
          meetings: [],
          nextCursor: cursors[call++] ?? null,
        }),
      }),
    ).rejects.toThrow("did not return a new continuation cursor");
  });

  it("overlaps adjacent strict timestamp windows by one millisecond", () => {
    expect(
      fathomCursorAfterCompletedWindow(new Date("2026-07-16T10:00:00.000Z")).toISOString(),
    ).toBe("2026-07-16T09:59:59.999Z");
  });
});
