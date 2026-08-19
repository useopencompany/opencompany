import { describe, expect, it } from "vitest";
import { wikiFilePathForPage, wikiFilePathsForPages, wikiPagePathFromFilePath } from "./fs";

describe("wiki filesystem projection", () => {
  it("projects every page to a .md file", () => {
    expect(wikiFilePathForPage("projects/roadmap")).toBe("projects/roadmap.md");
    expect(wikiFilePathForPage("projects")).toBe("projects.md");
  });

  it("maps markdown files back to page paths", () => {
    expect(wikiPagePathFromFilePath("projects/roadmap.md")).toBe("projects/roadmap");
    expect(wikiPagePathFromFilePath("projects/index.md")).toBe("projects/index");
  });

  it("rejects non-page files", () => {
    expect(wikiPagePathFromFilePath("notes.txt")).toBeNull();
    expect(wikiPagePathFromFilePath("index.md")).toBe("index");
    expect(wikiPagePathFromFilePath("projects/Nope.md")).toBeNull();
  });

  it("projects a page set", () => {
    const files = wikiFilePathsForPages(["projects", "projects/site", "people"]);
    expect(files.get("projects")).toBe("projects.md");
    expect(files.get("projects/site")).toBe("projects/site.md");
    expect(files.get("people")).toBe("people.md");
  });
});
