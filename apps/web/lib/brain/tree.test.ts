import { describe, expect, it } from "vitest";
import {
  ancestorFolderPaths,
  buildBrainTree,
  collectFolderPaths,
  flattenVisibleTree,
  hasOtherFilesInFolder,
  isFolderEmptyAfterRemoving,
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

  it("hides placeholder files but keeps the (empty) folder node", () => {
    const tree = buildBrainTree([{ path: "notes/new-folder/.gitkeep" }]);

    expect(tree.children.map((node) => `${node.type}:${node.path}`)).toEqual(["folder:notes"]);
    expect(tree.children[0]?.children.map((node) => `${node.type}:${node.path}`)).toEqual([
      "folder:notes/new-folder",
    ]);
    // The placeholder leaf itself is never rendered.
    expect(tree.children[0]?.children[0]?.children).toEqual([]);
  });
});

describe("folder emptiness helpers", () => {
  const files = [
    { path: "notes/todo.md" },
    { path: "notes/done.md" },
    { path: "notes-archive/old.md" },
    { path: "empty/.gitkeep" },
  ];

  it("detects when a folder still has other real files", () => {
    expect(hasOtherFilesInFolder(files, "notes", "notes/todo.md")).toBe(true);
    expect(hasOtherFilesInFolder(files, "notes", "notes/done.md")).toBe(true);
  });

  it("does not count prefix-colliding sibling folders", () => {
    // "notes-archive/old.md" must not be treated as a member of "notes".
    expect(hasOtherFilesInFolder([{ path: "notes-archive/old.md" }], "notes", "notes/x.md")).toBe(
      false,
    );
  });

  it("ignores placeholder files when measuring emptiness", () => {
    expect(hasOtherFilesInFolder(files, "empty", "empty/x.md")).toBe(false);
  });

  it("reports a folder as empty after removing its last real file", () => {
    expect(isFolderEmptyAfterRemoving([{ path: "notes/todo.md" }], "notes/todo.md")).toBe(true);
    expect(isFolderEmptyAfterRemoving(files, "notes/todo.md")).toBe(false);
    // Root-level files have no parent folder to keep alive.
    expect(isFolderEmptyAfterRemoving([{ path: "CHANGELOG.md" }], "CHANGELOG.md")).toBe(false);
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
