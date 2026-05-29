import { describe, expect, it } from "vitest";
import { buildBrainTree, flattenVisibleTree } from "./tree";
import { resolveBrainTreeKeyNav } from "./tree-keyboard";

const tree = buildBrainTree([
  { path: "docs/README.md" },
  { path: "docs/product/positioning.md" },
  { path: "notes/todo.md" },
]);

function state(focusedPath: string, expanded: string[]) {
  return {
    nodes: flattenVisibleTree(tree, new Set(expanded)),
    focusedPath,
    expandedPaths: new Set(expanded),
  };
}

describe("resolveBrainTreeKeyNav", () => {
  it("moves focus down and clamps at the bottom", () => {
    expect(resolveBrainTreeKeyNav("ArrowDown", state("docs", []))).toEqual({
      type: "focus",
      path: "notes",
    });
    expect(resolveBrainTreeKeyNav("ArrowDown", state("notes", []))).toBeNull();
  });

  it("moves focus up and clamps at the top", () => {
    expect(resolveBrainTreeKeyNav("ArrowUp", state("docs", []))).toBeNull();
    expect(resolveBrainTreeKeyNav("ArrowUp", state("notes", []))).toEqual({
      type: "focus",
      path: "docs",
    });
  });

  it("expands a collapsed folder on ArrowRight, then enters first child", () => {
    expect(resolveBrainTreeKeyNav("ArrowRight", state("docs", []))).toEqual({
      type: "expand",
      path: "docs",
    });
    // folders sort before files, so the first child of docs is docs/product.
    expect(resolveBrainTreeKeyNav("ArrowRight", state("docs", ["docs"]))).toEqual({
      type: "focus",
      path: "docs/product",
    });
  });

  it("does nothing on ArrowRight on a file", () => {
    expect(resolveBrainTreeKeyNav("ArrowRight", state("notes/todo.md", ["notes"]))).toBeNull();
  });

  it("collapses an expanded folder on ArrowLeft, else focuses parent", () => {
    expect(resolveBrainTreeKeyNav("ArrowLeft", state("docs", ["docs"]))).toEqual({
      type: "collapse",
      path: "docs",
    });
    expect(resolveBrainTreeKeyNav("ArrowLeft", state("docs/README.md", ["docs"]))).toEqual({
      type: "focus",
      path: "docs",
    });
    expect(resolveBrainTreeKeyNav("ArrowLeft", state("docs", []))).toBeNull();
  });

  it("opens files and toggles folders on Enter", () => {
    expect(resolveBrainTreeKeyNav("Enter", state("notes/todo.md", ["notes"]))).toEqual({
      type: "open",
      path: "notes/todo.md",
    });
    expect(resolveBrainTreeKeyNav("Enter", state("docs", []))).toEqual({
      type: "toggle",
      path: "docs",
    });
  });

  it("maps F2 to rename and Delete/Backspace to delete", () => {
    expect(resolveBrainTreeKeyNav("F2", state("docs", []))).toEqual({
      type: "rename",
      path: "docs",
    });
    expect(resolveBrainTreeKeyNav("Delete", state("docs", []))).toEqual({
      type: "delete",
      path: "docs",
    });
    expect(resolveBrainTreeKeyNav("Backspace", state("docs", []))).toEqual({
      type: "delete",
      path: "docs",
    });
  });

  it("returns null for unhandled keys", () => {
    expect(resolveBrainTreeKeyNav("a", state("docs", []))).toBeNull();
  });
});

import { findTypeAheadMatch } from "./tree-keyboard";

describe("findTypeAheadMatch", () => {
  const nodes = flattenVisibleTree(
    buildBrainTree([{ path: "alpha.md" }, { path: "beta.md" }, { path: "bravo.md" }]),
    new Set(),
  );

  it("matches the next node by case-insensitive prefix", () => {
    expect(findTypeAheadMatch(nodes, "b", 0)).toBe("beta.md");
    expect(findTypeAheadMatch(nodes, "BR", 0)).toBe("bravo.md");
  });

  it("cycles past the current index and wraps around", () => {
    // nodes order: alpha.md(0), beta.md(1), bravo.md(2)
    expect(findTypeAheadMatch(nodes, "b", 1)).toBe("bravo.md");
    expect(findTypeAheadMatch(nodes, "a", 2)).toBe("alpha.md");
  });

  it("returns null when nothing matches or buffer is empty", () => {
    expect(findTypeAheadMatch(nodes, "z", 0)).toBeNull();
    expect(findTypeAheadMatch(nodes, "", 0)).toBeNull();
  });
});
