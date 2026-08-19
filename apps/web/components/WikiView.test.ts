import { describe, expect, it } from "vitest";
import { availableWikiSlug, buildTree, type WikiPageData } from "./WikiView";

function node(overrides: Partial<WikiPageData>): WikiPageData {
  return {
    id: overrides.path ?? "node",
    slug: "node",
    path: "node",
    title: "Node",
    nodeType: "page",
    kind: "other",
    body: "",
    ...overrides,
  };
}

describe("Wiki tree helpers", () => {
  it("deduplicates slugs within a folder only", () => {
    const pages = [
      node({ path: "company/goals", slug: "goals" }),
      node({ path: "company/goals-2", slug: "goals-2" }),
    ];
    expect(availableWikiSlug("Goals", pages, "company")).toBe("goals-3");
    expect(availableWikiSlug("Goals", pages, "personal")).toBe("goals");
  });

  it("sorts folders first and then pages by display title", () => {
    const tree = buildTree([
      node({ id: "page-a", path: "a", slug: "a", title: "Alpha" }),
      node({ id: "folder-z", path: "z", slug: "z", title: "Zulu", nodeType: "folder" }),
      node({ id: "folder-b", path: "b", slug: "b", title: "Beta", nodeType: "folder" }),
      node({ id: "page-c", path: "c", slug: "c", title: "Charlie" }),
    ]);
    expect(tree.map((entry) => entry.id)).toEqual(["folder-b", "folder-z", "page-a", "page-c"]);
  });
});
