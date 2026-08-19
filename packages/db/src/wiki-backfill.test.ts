import { describe, expect, it } from "vitest";
import { canonicalizeWikiPageLinks } from "./wiki-backfill";

const nodes = [
  { path: "company/goals", slug: "goals", nodeType: "page" as const },
  { path: "company", slug: "company", nodeType: "folder" as const },
];

describe("canonicalizeWikiPageLinks", () => {
  it("rewrites legacy basenames to full paths", () => {
    expect(canonicalizeWikiPageLinks("See [[goals|Goals]].", nodes)).toBe(
      "See [[company/goals|Goals]].",
    );
  });

  it("is idempotent and leaves code ranges untouched", () => {
    const once = canonicalizeWikiPageLinks("[[company/goals]] `[[goals]]`", nodes);
    expect(canonicalizeWikiPageLinks(once, nodes)).toBe(once);
    expect(once).toBe("[[company/goals]] `[[goals]]`");
  });

  it("does not guess when a basename is ambiguous", () => {
    expect(
      canonicalizeWikiPageLinks("[[goals]]", [
        ...nodes,
        { path: "personal/goals", slug: "goals", nodeType: "page" },
      ]),
    ).toBe("[[goals]]");
  });
});
