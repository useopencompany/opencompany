import { describe, expect, it } from "vitest";
import {
  isValidWikiKind,
  isValidWikiPath,
  isValidWikiSlug,
  isValidWikiSourceRef,
  isWikiDescendantPath,
  movedWikiPath,
  parentWikiPath,
  parseWikiSourceRef,
  wikiSlugFromPath,
  wikiSlugFromTitle,
} from "./schema";

describe("wiki slugs", () => {
  it("accepts lowercase alphanumerics and hyphens", () => {
    expect(isValidWikiSlug("website-redesign")).toBe(true);
    expect(isValidWikiSlug("a")).toBe(true);
    expect(isValidWikiSlug("q3-2026")).toBe(true);
  });

  it("rejects invalid slugs", () => {
    expect(isValidWikiSlug("")).toBe(false);
    expect(isValidWikiSlug("-leading")).toBe(false);
    expect(isValidWikiSlug("Upper")).toBe(false);
    expect(isValidWikiSlug("has space")).toBe(false);
    expect(isValidWikiSlug("a".repeat(81))).toBe(false);
    expect(isValidWikiSlug(42)).toBe(false);
  });
});

describe("wiki paths", () => {
  it("accepts slug chains", () => {
    expect(isValidWikiPath("projects")).toBe(true);
    expect(isValidWikiPath("projects/website-redesign/notes")).toBe(true);
  });

  it("rejects malformed paths", () => {
    expect(isValidWikiPath("")).toBe(false);
    expect(isValidWikiPath("/projects")).toBe(false);
    expect(isValidWikiPath("projects/")).toBe(false);
    expect(isValidWikiPath("projects//x")).toBe(false);
    expect(isValidWikiPath("a/".repeat(10) + "a")).toBe(false);
  });

  it("splits into parent and slug", () => {
    expect(parentWikiPath("projects/website-redesign")).toBe("projects");
    expect(parentWikiPath("projects")).toBeNull();
    expect(wikiSlugFromPath("projects/website-redesign")).toBe("website-redesign");
    expect(wikiSlugFromPath("projects")).toBe("projects");
  });

  it("detects descendants without matching prefixes of sibling names", () => {
    expect(isWikiDescendantPath("projects/x", "projects")).toBe(true);
    expect(isWikiDescendantPath("projects-two/x", "projects")).toBe(false);
    expect(isWikiDescendantPath("projects", "projects")).toBe(false);
  });

  it("rewrites moved subtree paths", () => {
    expect(movedWikiPath("projects/site", "projects/site", "archive/site")).toBe("archive/site");
    expect(movedWikiPath("projects/site/notes", "projects/site", "archive/site")).toBe(
      "archive/site/notes",
    );
    expect(movedWikiPath("projects/other", "projects/site", "archive/site")).toBe("projects/other");
  });
});

describe("wiki kinds", () => {
  it("accepts the fixed vocabulary and nothing else", () => {
    expect(isValidWikiKind("project")).toBe(true);
    expect(isValidWikiKind("other")).toBe(true);
    expect(isValidWikiKind("evidence")).toBe(false);
    expect(isValidWikiKind(null)).toBe(false);
  });
});

describe("source refs", () => {
  it("parses provider and id", () => {
    expect(parseWikiSourceRef("linear:issue:ENG-123")).toEqual({
      raw: "linear:issue:ENG-123",
      provider: "linear",
      id: "issue:ENG-123",
    });
  });

  it("rejects malformed refs", () => {
    expect(isValidWikiSourceRef("linear")).toBe(false);
    expect(isValidWikiSourceRef("linear:")).toBe(false);
    expect(isValidWikiSourceRef("linear:has space")).toBe(false);
    expect(isValidWikiSourceRef(`linear:${"x".repeat(300)}`)).toBe(false);
  });
});

describe("wikiSlugFromTitle", () => {
  it("slugifies human titles", () => {
    expect(wikiSlugFromTitle("Website Redesign")).toBe("website-redesign");
    expect(wikiSlugFromTitle("  Café résumé!  ")).toBe("cafe-resume");
    expect(wikiSlugFromTitle("Q3 2026 — Planning")).toBe("q3-2026-planning");
  });

  it("returns null when nothing usable remains", () => {
    expect(wikiSlugFromTitle("!!!")).toBeNull();
    expect(wikiSlugFromTitle("")).toBeNull();
  });
});
