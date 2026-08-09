import { describe, expect, it } from "vitest";
import { planWikiMigration, type WikiMigrationSourceDocument } from "./goat-wiki-migrate";

function doc(overrides: Partial<WikiMigrationSourceDocument>): WikiMigrationSourceDocument {
  return {
    brainSlug: "general",
    brainId: "some-page",
    folderPath: "projects",
    title: null,
    body: "# Some page",
    kind: "page",
    entityType: "note",
    status: "active",
    format: "markdown",
    timeline: [],
    mimeType: null,
    originalFileName: null,
    assetStorageKey: null,
    assetExtractedText: null,
    assetContentHash: null,
    assetSizeBytes: null,
    ...overrides,
  };
}

describe("planWikiMigration", () => {
  it("keeps curated pages in place and maps entity types onto wiki kinds", () => {
    const plan = planWikiMigration([
      doc({ brainId: "acme", folderPath: "companies", entityType: "company" }),
      doc({ brainId: "q3-analysis", folderPath: "research", entityType: "analysis" }),
    ]);
    expect(plan.pages).toMatchObject([
      { path: "companies/acme", slug: "acme", kind: "company" },
      { path: "research/q3-analysis", kind: "research" },
    ]);
  });

  it("archives evidence and archived pages, skips merged", () => {
    const plan = planWikiMigration([
      doc({
        brainId: "ev-slack-1",
        folderPath: "evidence/slack",
        kind: "evidence",
        entityType: "source",
      }),
      doc({ brainId: "old-plan", folderPath: "projects", status: "archived" }),
      doc({ brainId: "dupe", status: "merged" }),
    ]);
    expect(plan.pages.map((page) => page.path)).toEqual([
      "archive/evidence/slack/ev-slack-1",
      "archive/projects/old-plan",
    ]);
    expect(plan.skippedMerged).toEqual(["dupe"]);
  });

  it("suffixes slug collisions across brains, first brain wins", () => {
    const plan = planWikiMigration([
      doc({ brainSlug: "general", brainId: "roadmap" }),
      doc({ brainSlug: "second", brainId: "roadmap", folderPath: "thoughts" }),
      doc({ brainSlug: "third", brainId: "roadmap", folderPath: "inbox" }),
    ]);
    expect(plan.pages.map((page) => page.path)).toEqual([
      "projects/roadmap",
      "thoughts/roadmap-2",
      "inbox/roadmap-3",
    ]);
    expect(plan.collisions).toHaveLength(2);
  });

  it("carries evidence citations into timeline text and flags asset pages", () => {
    const plan = planWikiMigration([
      doc({
        timeline: [
          { evidenceId: "ev-gmail-1", at: "2026-08-01T00:00:00Z", body: "Budget approved" },
          { evidenceId: "", at: "2026-08-02T00:00:00Z", body: "Plain entry" },
        ],
      }),
      doc({
        brainId: "deck",
        format: "pdf",
        mimeType: "application/pdf",
        assetStorageKey: "key-1",
      }),
    ]);
    expect(plan.pages[0]?.timeline).toEqual([
      { at: "2026-08-01T00:00:00Z", text: "Budget approved [[ev-gmail-1]]" },
      { at: "2026-08-02T00:00:00Z", text: "Plain entry" },
    ]);
    expect(plan.pages[1]?.asset).toMatchObject({ assetStorageKey: "key-1" });
    expect(plan.pages[0]?.asset).toBeNull();
  });
});
