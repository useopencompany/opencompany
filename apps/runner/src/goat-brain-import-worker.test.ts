import { describe, expect, it } from "vitest";
import { selectGranolaImportNotes } from "./goat-brain-import-worker";

describe("Granola context import discovery", () => {
  it("deduplicates note ids and keeps the most recently updated bounded set", () => {
    const notes = [
      granolaSummary("note_1", "2026-07-10T10:00:00.000Z"),
      granolaSummary("note_2", "2026-07-12T10:00:00.000Z"),
      granolaSummary("note_1", "2026-07-13T10:00:00.000Z"),
      granolaSummary("note_3", "2026-07-11T10:00:00.000Z"),
    ];

    expect(selectGranolaImportNotes(notes, 2).map((note) => [note.id, note.updatedAt])).toEqual([
      ["note_1", "2026-07-13T10:00:00.000Z"],
      ["note_2", "2026-07-12T10:00:00.000Z"],
    ]);
  });
});

function granolaSummary(id: string, updatedAt: string) {
  return { id, title: id, updatedAt, raw: {} };
}
