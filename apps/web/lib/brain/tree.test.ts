import { describe, expect, it } from "vitest";
import {
  ancestorFolderPaths,
  buildBrainTree,
  collectFolderPaths,
  flattenVisibleTree,
  parentFolderPath,
  uniqueNewBrainPath,
} from "./tree";

const files = [
  { path: "docs/README.md" },
  { path: "docs/architecture.md" },
  { path: "docs/product/positioning.md" },
  { path: "notes/todo.md" },
  { path: "CHANGELOG.md" },
];

describe("brain tree helpers", () => {
  it("builds nested folder nodes with folders before files", () => {
    const tree = buildBrainTree(files);

    expect(tree.children.map((node) => `${node.type}:${node.path}`)).toEqual([
      "folder:docs",
      "folder:notes",
      "file:CHANGELOG.md",
    ]);
    expect(tree.children[0]?.children.map((node) => `${node.type}:${node.path}`)).toEqual([
      "folder:docs/product",
      "file:docs/architecture.md",
      "file:docs/README.md",
    ]);
  });

  it("filters by full path and preserves matching ancestors", () => {
    const tree = buildBrainTree(files, "product");

    expect(tree.children.map((node) => node.path)).toEqual(["docs"]);
    expect(tree.children[0]?.children.map((node) => node.path)).toEqual(["docs/product"]);
    expect(tree.children[0]?.children[0]?.children.map((node) => node.path)).toEqual([
      "docs/product/positioning.md",
    ]);
  });

  it("collects folder paths and ancestor folder paths", () => {
    const tree = buildBrainTree(files);

    expect(collectFolderPaths(tree)).toEqual(["docs", "docs/product", "notes"]);
    expect(ancestorFolderPaths("docs/product/positioning.md")).toEqual(["docs", "docs/product"]);
    expect(parentFolderPath("docs/product/positioning.md")).toBe("docs/product");
  });

  it("creates unique new note paths in the selected context", () => {
    expect(uniqueNewBrainPath(files)).toBe("notes/new-note.md");
    expect(uniqueNewBrainPath([...files, { path: "notes/new-note.md" }])).toBe(
      "notes/new-note-2.md",
    );
    expect(uniqueNewBrainPath(files, "docs/product")).toBe("docs/product/new-note.md");
    expect(uniqueNewBrainPath(files, "docs/README.md")).toBe("docs/new-note.md");
  });
});

describe("flattenVisibleTree", () => {
  const tree = buildBrainTree([
    { path: "docs/README.md" },
    { path: "docs/product/positioning.md" },
    { path: "notes/todo.md" },
    { path: "CHANGELOG.md" },
  ]);

  it("lists only top-level nodes when nothing is expanded", () => {
    const flat = flattenVisibleTree(tree, new Set());
    expect(flat.map((n) => n.path)).toEqual(["docs", "notes", "CHANGELOG.md"]);
    expect(flat.map((n) => n.depth)).toEqual([0, 0, 0]);
  });

  it("reveals children of expanded folders in DFS order with depth", () => {
    const flat = flattenVisibleTree(tree, new Set(["docs"]));
    // sortTreeNodes orders folders before files, so docs/product precedes docs/README.md.
    expect(flat.map((n) => n.path)).toEqual([
      "docs",
      "docs/product",
      "docs/README.md",
      "notes",
      "CHANGELOG.md",
    ]);
    expect(flat.find((n) => n.path === "docs/product")?.depth).toBe(1);
  });

  it("recurses into nested expanded folders", () => {
    const flat = flattenVisibleTree(tree, new Set(["docs", "docs/product"]));
    expect(flat.map((n) => n.path)).toContain("docs/product/positioning.md");
    expect(flat.find((n) => n.path === "docs/product/positioning.md")?.depth).toBe(2);
  });
});
