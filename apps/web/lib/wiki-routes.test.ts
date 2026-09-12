import { RESERVED_WIKI_SLUGS } from "@opencompany/db/wikis";
import { describe, expect, it } from "vitest";
import {
  activeWikiSlugFromPathname,
  WIKI_STATIC_SEGMENTS,
  wikiHref,
  wikiPagePathFromPathname,
} from "./wiki-routes";

describe("wikiHref", () => {
  it("roots a page path at its wiki", () => {
    expect(wikiHref("company")).toBe("/wiki/company");
    expect(wikiHref("company", null)).toBe("/wiki/company");
    expect(wikiHref("company", "projects/launch plan")).toBe(
      "/wiki/company/projects/launch%20plan",
    );
  });

  it("drops empty segments rather than producing a double slash", () => {
    expect(wikiHref("company", "/projects//launch/")).toBe("/wiki/company/projects/launch");
  });
});

describe("activeWikiSlugFromPathname", () => {
  it("reads the wiki out of a page URL", () => {
    expect(activeWikiSlugFromPathname("/wiki/company")).toBe("company");
    expect(activeWikiSlugFromPathname("/wiki/company/projects/launch")).toBe("company");
    expect(activeWikiSlugFromPathname("/wiki/launch%20pad")).toBe("launch pad");
  });

  it("has no wiki on the index or the static routes", () => {
    expect(activeWikiSlugFromPathname("/wiki")).toBeNull();
    expect(activeWikiSlugFromPathname("/wiki/")).toBeNull();
    expect(activeWikiSlugFromPathname("/wiki/sources")).toBeNull();
    expect(activeWikiSlugFromPathname("/wiki/import")).toBeNull();
    expect(activeWikiSlugFromPathname("/tasks")).toBeNull();
  });
});

describe("wikiPagePathFromPathname", () => {
  it("returns the path within the wiki", () => {
    expect(wikiPagePathFromPathname("/wiki/company/projects/launch", "company")).toBe(
      "projects/launch",
    );
    expect(wikiPagePathFromPathname("/wiki/company", "company")).toBeNull();
  });

  it("refuses a path belonging to another wiki", () => {
    expect(wikiPagePathFromPathname("/wiki/handbook/projects/launch", "company")).toBeNull();
  });
});

describe("reserved slugs", () => {
  // A wiki slugged like a static segment would be permanently unreachable, so the guard in
  // packages/db and the segments this module knows about have to describe the same set.
  it("match the slugs the database refuses to allocate", () => {
    expect([...WIKI_STATIC_SEGMENTS].toSorted()).toEqual([...RESERVED_WIKI_SLUGS].toSorted());
  });
});
