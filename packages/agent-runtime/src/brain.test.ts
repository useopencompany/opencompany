import { describe, expect, it } from "vitest";
import {
  formatBrainReferenceDisplay,
  isBrainListingAllowed,
  isBrainPathAllowed,
  matchesBrainReference,
} from "./brain";
import type { AgentBrainReference } from "./types";

const folder = (path: string): AgentBrainReference => ({ path, type: "folder" });
const file = (path: string): AgentBrainReference => ({ path, type: "file" });

describe("matchesBrainReference", () => {
  it("matches any path for the root folder reference", () => {
    expect(matchesBrainReference("wiki/page.md", folder("/"))).toBe(true);
    expect(matchesBrainReference("anything/at/all.md", folder("/"))).toBe(true);
  });

  it("matches nested and new files inside a folder reference (prefix match)", () => {
    expect(matchesBrainReference("wiki/page.md", folder("wiki/"))).toBe(true);
    expect(matchesBrainReference("wiki/notes/new.md", folder("wiki/"))).toBe(true);
  });

  it("does not match a sibling folder", () => {
    expect(matchesBrainReference("marketing/plan.md", folder("wiki/"))).toBe(false);
  });

  it("matches a file reference only exactly", () => {
    expect(matchesBrainReference("wiki/page.md", file("wiki/page.md"))).toBe(true);
    expect(matchesBrainReference("wiki/other.md", file("wiki/page.md"))).toBe(false);
  });
});

describe("isBrainPathAllowed", () => {
  it("returns false when there are no references", () => {
    expect(isBrainPathAllowed("wiki/page.md", [])).toBe(false);
  });

  it("returns true when any reference matches", () => {
    const refs = [file("readme.md"), folder("wiki/")];
    expect(isBrainPathAllowed("wiki/new.md", refs)).toBe(true);
    expect(isBrainPathAllowed("readme.md", refs)).toBe(true);
    expect(isBrainPathAllowed("marketing/plan.md", refs)).toBe(false);
  });
});

describe("isBrainListingAllowed", () => {
  const refs = [folder("wiki/")];

  it("allows listing the brain root", () => {
    expect(isBrainListingAllowed("", refs)).toBe(true);
  });

  it("allows listing an ancestor or the mounted folder itself", () => {
    expect(isBrainListingAllowed("wiki", refs)).toBe(true);
    expect(isBrainListingAllowed("wiki/", refs)).toBe(true);
  });

  it("allows listing a folder inside the mounted folder", () => {
    expect(isBrainListingAllowed("wiki/notes", refs)).toBe(true);
  });

  it("rejects listing an out-of-scope sibling folder", () => {
    expect(isBrainListingAllowed("marketing", refs)).toBe(false);
  });

  it("allows listing ancestors of a deep file reference", () => {
    const fileRefs = [file("wiki/sub/page.md")];
    expect(isBrainListingAllowed("wiki", fileRefs)).toBe(true);
    expect(isBrainListingAllowed("wiki/sub", fileRefs)).toBe(true);
    expect(isBrainListingAllowed("marketing", fileRefs)).toBe(false);
  });
});

describe("formatBrainReferenceDisplay", () => {
  it("renders the root reference as brain/", () => {
    expect(formatBrainReferenceDisplay("/")).toBe("brain/");
  });

  it("prefixes other references with brain/", () => {
    expect(formatBrainReferenceDisplay("wiki/")).toBe("brain/wiki/");
    expect(formatBrainReferenceDisplay("readme.md")).toBe("brain/readme.md");
  });
});
