import { describe, expect, it } from "vitest";
import { deriveWikiTitle, parseWikiPageFile, serializeWikiPageFile } from "./document";

describe("parseWikiPageFile", () => {
  it("parses kind frontmatter and body", () => {
    const parsed = parseWikiPageFile("---\nkind: project\n---\n\n# Site\n\nBody.");
    expect(parsed.kind).toBe("project");
    expect(parsed.body).toBe("# Site\n\nBody.");
  });

  it("defaults to kind other without frontmatter", () => {
    expect(parseWikiPageFile("# Just markdown")).toEqual({
      kind: "other",
      body: "# Just markdown",
    });
  });

  it("ignores unknown frontmatter keys and invalid kinds", () => {
    expect(parseWikiPageFile("---\nkind: evidence\nstatus: draft\n---\nBody").kind).toBe("other");
  });

  it("survives malformed yaml", () => {
    const parsed = parseWikiPageFile("---\nkind: [unclosed\n---\nBody");
    expect(parsed.kind).toBe("other");
    expect(parsed.body).toBe("Body");
  });

  it("roundtrips through serialize", () => {
    const serialized = serializeWikiPageFile({ kind: "person", body: "# Ada\n" });
    expect(serialized).toBe("---\nkind: person\n---\n\n# Ada\n");
    expect(parseWikiPageFile(serialized)).toEqual({ kind: "person", body: "# Ada\n" });
  });
});

describe("deriveWikiTitle", () => {
  it("uses the first H1", () => {
    expect(deriveWikiTitle("intro\n\n# Real Title\n\n# Second", "slug")).toBe("Real Title");
  });

  it("ignores deeper headings and falls back", () => {
    expect(deriveWikiTitle("## Only h2", "some-slug")).toBe("some-slug");
    expect(deriveWikiTitle("", "some-slug")).toBe("some-slug");
  });

  it("strips trailing closing hashes", () => {
    expect(deriveWikiTitle("# Title ##", "slug")).toBe("Title");
  });
});
