import { describe, expect, it, vi } from "vitest";
import { listGranolaNotesSince } from "./goat-granola-poll-worker";
import type { GranolaNotesPage } from "./granola-api";

describe("Granola poll pagination", () => {
  it("returns a continuation cursor instead of advancing past unprocessed pages", async () => {
    const listNotes = vi.fn(async (input: { cursor?: string }): Promise<GranolaNotesPage> => {
      const page = input.cursor ? Number(input.cursor.slice(1)) : 0;
      return {
        notes: [
          {
            id: `note_${page}`,
            title: `Note ${page}`,
            updatedAt: `2026-07-16T10:0${page}:00.000Z`,
            raw: {},
          },
        ],
        hasMore: page < 5,
        cursor: page < 5 ? `c${page + 1}` : null,
      };
    });
    const signal = new AbortController().signal;

    const firstBatch = await listGranolaNotesSince({
      apiKey: "grn_test",
      updatedAfter: "2026-07-16T09:00:00.000Z",
      signal,
      listNotes,
    });
    expect(firstBatch.notes).toHaveLength(5);
    expect(firstBatch.nextCursor).toBe("c5");
    if (!firstBatch.nextCursor) throw new Error("Expected a Granola continuation cursor.");

    const finalBatch = await listGranolaNotesSince({
      apiKey: "grn_test",
      updatedAfter: "2026-07-16T09:00:00.000Z",
      cursor: firstBatch.nextCursor,
      signal,
      listNotes,
    });
    expect(finalBatch.notes.map((note) => note.id)).toEqual(["note_5"]);
    expect(finalBatch.nextCursor).toBeNull();
    expect(listNotes).toHaveBeenCalledTimes(6);
  });

  it("fails closed when Granola says more pages exist without advancing the cursor", async () => {
    await expect(
      listGranolaNotesSince({
        apiKey: "grn_test",
        updatedAfter: "2026-07-16T09:00:00.000Z",
        signal: new AbortController().signal,
        listNotes: async () => ({ notes: [], hasMore: true, cursor: null }),
      }),
    ).rejects.toThrow("did not return a new continuation cursor");
  });

  it("rejects a cursor cycle within a pagination batch", async () => {
    const cursors = ["c1", "c2", "c1"];
    let call = 0;
    await expect(
      listGranolaNotesSince({
        apiKey: "grn_test",
        updatedAfter: "2026-07-16T09:00:00.000Z",
        signal: new AbortController().signal,
        listNotes: async () => ({
          notes: [],
          hasMore: true,
          cursor: cursors[call++] ?? null,
        }),
      }),
    ).rejects.toThrow("did not return a new continuation cursor");
  });
});
