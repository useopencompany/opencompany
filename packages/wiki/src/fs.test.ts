import { describe, expect, it } from "vitest";
import {
  duplicateWikiPagePaths,
  wikiFilePathForPage,
  wikiFilePathsForPages,
  wikiPagePathFromFilePath,
} from "./fs";

describe("wiki filesystem projection", () => {
  it("projects leaves to .md and parents to index.md", () => {
    expect(wikiFilePathForPage("projects/roadmap", false)).toBe("projects/roadmap.md");
    expect(wikiFilePathForPage("projects", true)).toBe("projects/index.md");
  });

  it("maps both file forms back to the same page path", () => {
    expect(wikiPagePathFromFilePath("projects/roadmap.md")).toBe("projects/roadmap");
    expect(wikiPagePathFromFilePath("projects/index.md")).toBe("projects");
  });

  it("rejects non-page files", () => {
    expect(wikiPagePathFromFilePath("notes.txt")).toBeNull();
    expect(wikiPagePathFromFilePath("index.md")).toBeNull();
    expect(wikiPagePathFromFilePath("projects/Nope.md")).toBeNull();
  });

  it("derives children from the page set", () => {
    const files = wikiFilePathsForPages(["projects", "projects/site", "people"]);
    expect(files.get("projects")).toBe("projects/index.md");
    expect(files.get("projects/site")).toBe("projects/site.md");
    expect(files.get("people")).toBe("people.md");
  });

  it("flags foo.md colliding with foo/index.md", () => {
    const duplicates = duplicateWikiPagePaths(["projects.md", "projects/index.md", "people.md"]);
    expect([...duplicates.keys()]).toEqual(["projects"]);
    expect(duplicates.get("projects")).toEqual(["projects.md", "projects/index.md"]);
  });
});
