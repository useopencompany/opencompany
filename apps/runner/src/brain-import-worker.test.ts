import { normalizeImportRun } from "@opencompany/brain";
import { describe, expect, it } from "vitest";
import {
  selectGranolaImportNotes,
  wikiImportCandidateItem,
  wikiImportFinalizerItem,
} from "./brain-import-worker";

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

describe("Wiki company import writer handoff", () => {
  it("wraps connected-source candidates in the constrained internal import protocol", () => {
    const item = wikiImportCandidateItem(
      {
        id: "gbimp_1",
        companyUrl: "https://acme.example",
        companyDomain: "acme.example",
        companyName: "Acme",
        focus: null,
      },
      {
        id: "gbimpc_1",
        provider: "github",
        sourceRef: "github:acme/api:pull:42",
        title: "Ship onboarding",
        occurredAt: new Date("2026-09-01T10:00:00.000Z"),
        capturedAt: new Date("2026-09-01T10:05:00.000Z"),
        contentHash: "original_hash",
        normalizedPayload: { content: { activity: { state: "merged" } } },
      },
    );

    expect(item).toMatchObject({
      sourceProvider: "opencompany-import",
      sourceType: "run",
      sourceRef: "opencompany-import:run:gbimp_1:candidate:github:gbimpc_1",
      content: {
        phase: "research",
        importRunId: "gbimp_1",
        evidence: {
          provider: "github",
          sourceRef: "github:acme/api:pull:42",
        },
      },
    });
    expect(item.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("translates the legacy finalizer envelope to the Wiki import protocol", () => {
    const item = wikiImportFinalizerItem(
      { id: "gbimp_1" },
      normalizeImportRun({
        phase: "finalize",
        importRunId: "gbimp_1",
        companyUrl: "https://acme.example",
        companyDomain: "acme.example",
        childSummary: [],
      }),
    );

    expect(item).toMatchObject({
      sourceProvider: "opencompany-import",
      sourceType: "run",
      sourceRef: "opencompany-import:run:gbimp_1:finalize",
    });
    expect(item.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

function granolaSummary(id: string, updatedAt: string) {
  return { id, title: id, updatedAt, raw: {} };
}
