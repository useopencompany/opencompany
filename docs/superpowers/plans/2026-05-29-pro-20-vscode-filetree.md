# PRO-20 VS Code-like Brain Filetree — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Brain filetree (`apps/web/components/BrainView.tsx`) feel like the VS Code explorer: inline name on create, keyboard navigation with a focus cursor, drop-onto-file, and auto-expand on drag-hover.

**Architecture:** Keep the existing optimistic state in `BrainView`. Add pure, tested helpers in `lib/brain/` for tree flattening and keyboard resolution, a small React hook to wire keystrokes, then targeted edits in `BrainView`/`TreeItem` for create/drop/auto-expand. No state-management rewrite.

**Tech Stack:** Next.js App Router, React, TypeScript, vitest. Tests run with `bun run --filter @opencompany/web test`. Worktree: `~/opencompany.cloud/opencompany-pro20` (base SHA `93d0dcf`). No `Co-Authored-By` footers. Never `git commit --amend` or rebase past the base SHA.

**Conventions:** `import { describe, expect, it } from "vitest";`. Tree children are sorted folders-first then alphabetical (`sortTreeNodes`), so visible order is the DFS order of the built tree.

---

### Task 1: `flattenVisibleTree` helper

**Files:**
- Modify: `apps/web/lib/brain/tree.ts`
- Test: `apps/web/lib/brain/tree.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tree.test.ts`:

```ts
import { buildBrainTree, flattenVisibleTree } from "./tree";

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
    expect(flat.map((n) => n.path)).toEqual([
      "docs",
      "docs/README.md",
      "docs/product",
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --filter @opencompany/web test -- tree.test.ts`
Expected: FAIL — `flattenVisibleTree` is not exported.

- [ ] **Step 3: Implement**

Add to `tree.ts` (after the `BrainTreeNode` type, export the flat type and function):

```ts
export type FlatBrainNode = {
  path: string;
  name: string;
  type: "folder" | "file";
  depth: number;
};

export function flattenVisibleTree<TFile extends BrainTreeFile>(
  tree: BrainTreeNode<TFile>,
  expandedPaths: Set<string>,
): FlatBrainNode[] {
  const flat: FlatBrainNode[] = [];

  const walk = (nodes: Array<BrainTreeNode<TFile>>, depth: number) => {
    for (const node of nodes) {
      flat.push({ path: node.path, name: node.name, type: node.type, depth });
      if (node.type === "folder" && expandedPaths.has(node.path)) {
        walk(node.children, depth + 1);
      }
    }
  };

  walk(tree.children, 0);
  return flat;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run --filter @opencompany/web test -- tree.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/brain/tree.ts apps/web/lib/brain/tree.test.ts
git commit -m "feat(brain): add flattenVisibleTree helper"
```

---

### Task 2: `resolveBrainTreeKeyNav` keyboard resolver

**Files:**
- Create: `apps/web/lib/brain/tree-keyboard.ts`
- Test: `apps/web/lib/brain/tree-keyboard.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tree-keyboard.test.ts`:

```ts
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
    expect(resolveBrainTreeKeyNav("ArrowDown", state("notes", []))).toEqual({
      type: "focus",
      path: "notes",
    });
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
    expect(resolveBrainTreeKeyNav("ArrowRight", state("docs", ["docs"]))).toEqual({
      type: "focus",
      path: "docs/README.md",
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --filter @opencompany/web test -- tree-keyboard.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `tree-keyboard.ts`:

```ts
import { type FlatBrainNode, parentFolderPath } from "./tree";

export type BrainTreeKeyAction =
  | { type: "focus"; path: string }
  | { type: "expand"; path: string }
  | { type: "collapse"; path: string }
  | { type: "open"; path: string }
  | { type: "toggle"; path: string }
  | { type: "rename"; path: string }
  | { type: "delete"; path: string };

export function resolveBrainTreeKeyNav(
  key: string,
  state: { nodes: FlatBrainNode[]; focusedPath: string; expandedPaths: Set<string> },
): BrainTreeKeyAction | null {
  const { nodes, focusedPath, expandedPaths } = state;
  if (nodes.length === 0) return null;
  const index = nodes.findIndex((node) => node.path === focusedPath);
  const current = index >= 0 ? nodes[index] : null;

  switch (key) {
    case "ArrowDown": {
      const next = index < 0 ? 0 : Math.min(index + 1, nodes.length - 1);
      return next === index ? null : { type: "focus", path: nodes[next].path };
    }
    case "ArrowUp": {
      const prev = index < 0 ? 0 : Math.max(index - 1, 0);
      return prev === index ? null : { type: "focus", path: nodes[prev].path };
    }
    case "ArrowRight": {
      if (!current || current.type !== "folder") return null;
      if (!expandedPaths.has(current.path)) return { type: "expand", path: current.path };
      const child = nodes[index + 1];
      if (child && child.depth > current.depth) return { type: "focus", path: child.path };
      return null;
    }
    case "ArrowLeft": {
      if (!current) return null;
      if (current.type === "folder" && expandedPaths.has(current.path)) {
        return { type: "collapse", path: current.path };
      }
      const parent = parentFolderPath(current.path);
      return parent ? { type: "focus", path: parent } : null;
    }
    case "Enter": {
      if (!current) return null;
      return current.type === "file"
        ? { type: "open", path: current.path }
        : { type: "toggle", path: current.path };
    }
    case "F2": {
      if (!current) return null;
      return { type: "rename", path: current.path };
    }
    case "Delete":
    case "Backspace": {
      if (!current) return null;
      return { type: "delete", path: current.path };
    }
    default:
      return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run --filter @opencompany/web test -- tree-keyboard.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/brain/tree-keyboard.ts apps/web/lib/brain/tree-keyboard.test.ts
git commit -m "feat(brain): add resolveBrainTreeKeyNav resolver"
```

---

### Task 3: `findTypeAheadMatch` helper

**Files:**
- Modify: `apps/web/lib/brain/tree-keyboard.ts`
- Test: `apps/web/lib/brain/tree-keyboard.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tree-keyboard.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --filter @opencompany/web test -- tree-keyboard.test.ts`
Expected: FAIL — `findTypeAheadMatch` not exported.

- [ ] **Step 3: Implement**

Append to `tree-keyboard.ts`:

```ts
export function findTypeAheadMatch(
  nodes: FlatBrainNode[],
  buffer: string,
  fromIndex: number,
): string | null {
  if (!buffer || nodes.length === 0) return null;
  const needle = buffer.toLowerCase();
  const count = nodes.length;
  const start = fromIndex < 0 ? 0 : fromIndex;
  for (let offset = 1; offset <= count; offset += 1) {
    const node = nodes[(start + offset) % count];
    if (node.name.toLowerCase().startsWith(needle)) return node.path;
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run --filter @opencompany/web test -- tree-keyboard.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/brain/tree-keyboard.ts apps/web/lib/brain/tree-keyboard.test.ts
git commit -m "feat(brain): add findTypeAheadMatch helper"
```

---

### Task 4: `useBrainTreeKeyboard` hook

**Files:**
- Create: `apps/web/components/use-brain-tree-keyboard.ts`

No unit test (thin React glue over tested pure functions); verified by typecheck + browser.

- [ ] **Step 1: Implement the hook**

Create `use-brain-tree-keyboard.ts`:

```ts
import { useCallback, useRef } from "react";
import type { FlatBrainNode } from "@/lib/brain/tree";
import { findTypeAheadMatch, resolveBrainTreeKeyNav } from "@/lib/brain/tree-keyboard";

const TYPE_AHEAD_RESET_MS = 600;

type BrainTreeKeyboardOptions = {
  nodes: FlatBrainNode[];
  focusedPath: string;
  expandedPaths: Set<string>;
  onFocus: (path: string) => void;
  onExpand: (path: string) => void;
  onCollapse: (path: string) => void;
  onOpen: (path: string) => void;
  onToggle: (path: string) => void;
  onRename: (path: string) => void;
  onDelete: (path: string) => void;
};

export function useBrainTreeKeyboard(options: BrainTreeKeyboardOptions) {
  const bufferRef = useRef("");
  const lastKeyAtRef = useRef(0);

  const {
    nodes,
    focusedPath,
    expandedPaths,
    onFocus,
    onExpand,
    onCollapse,
    onOpen,
    onToggle,
    onRename,
    onDelete,
  } = options;

  return useCallback(
    (event: React.KeyboardEvent) => {
      const action = resolveBrainTreeKeyNav(event.key, { nodes, focusedPath, expandedPaths });
      if (action) {
        event.preventDefault();
        switch (action.type) {
          case "focus":
            onFocus(action.path);
            break;
          case "expand":
            onExpand(action.path);
            break;
          case "collapse":
            onCollapse(action.path);
            break;
          case "open":
            onOpen(action.path);
            break;
          case "toggle":
            onToggle(action.path);
            break;
          case "rename":
            onRename(action.path);
            break;
          case "delete":
            onDelete(action.path);
            break;
        }
        return;
      }

      if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return;

      const now = event.timeStamp;
      const index = nodes.findIndex((node) => node.path === focusedPath);
      const extending = now - lastKeyAtRef.current < TYPE_AHEAD_RESET_MS;
      lastKeyAtRef.current = now;
      bufferRef.current = extending ? bufferRef.current + event.key : event.key;
      // When extending, re-check the current node first (index - 1); otherwise advance past it.
      const fromIndex = extending ? index - 1 : index;
      const match = findTypeAheadMatch(nodes, bufferRef.current, fromIndex);
      if (match) {
        event.preventDefault();
        onFocus(match);
      }
    },
    [nodes, focusedPath, expandedPaths, onFocus, onExpand, onCollapse, onOpen, onToggle, onRename, onDelete],
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run --filter @opencompany/web typecheck`
Expected: PASS (no errors referencing this file).

- [ ] **Step 3: Commit**

```bash
git add apps/web/components/use-brain-tree-keyboard.ts
git commit -m "feat(brain): add useBrainTreeKeyboard hook"
```

---

### Task 5: Wire keyboard navigation into BrainView

**Files:**
- Modify: `apps/web/components/BrainView.tsx`

This task adds the focus cursor, the container key handler, the focused-row visual, and a11y roles. It is verified by typecheck/lint + the user's browser review (no unit test).

- [ ] **Step 1: Imports and state**

Add imports near the top of `BrainView.tsx`:

```ts
import { type FlatBrainNode, flattenVisibleTree } from "@/lib/brain/tree";
import { useBrainTreeKeyboard } from "./use-brain-tree-keyboard";
```

(Extend the existing `@/lib/brain/tree` import rather than duplicating it.)

Inside `BrainView`, after the `expandedPaths` state, add:

```ts
const [focusedPath, setFocusedPath] = useState(serverFiles[0]?.path ?? "");
const treeScrollRef = useRef<HTMLDivElement>(null);
```

After the `visibleExpandedPaths` memo, add:

```ts
const flatNodes = useMemo(
  () => flattenVisibleTree(tree, visibleExpandedPaths),
  [tree, visibleExpandedPaths],
);
```

- [ ] **Step 2: Focus helpers and keyboard hook**

Add these handlers inside `BrainView` (near `toggleFolder`):

```ts
function focusBrainNode(path: string) {
  setFocusedPath(path);
}

function expandFolderPath(path: string) {
  setSelectedContextPath(path);
  setExpandedPaths((current) => {
    if (current.has(path)) return current;
    const next = new Set(current);
    next.add(path);
    return next;
  });
}

function collapseFolderPath(path: string) {
  setSelectedContextPath(path);
  setExpandedPaths((current) => {
    if (!current.has(path)) return current;
    const next = new Set(current);
    next.delete(path);
    return next;
  });
}

function openBrainPath(path: string) {
  const file = files.find((candidate) => candidate.path === path);
  if (file) selectFile(file);
}

function renameBrainPath(path: string) {
  const node = flatNodes.find((candidate) => candidate.path === path);
  if (!node) return;
  if (node.type === "folder") startRenameFolder(path);
  else {
    const file = files.find((candidate) => candidate.path === path);
    if (file) startRenameFile(file);
  }
}

function deleteBrainPath(path: string) {
  const node = flatNodes.find((candidate) => candidate.path === path);
  if (!node) return;
  if (node.type === "folder") removeFolder(path);
  else {
    const file = files.find((candidate) => candidate.path === path);
    if (file) removeFile(file);
  }
}

const handleTreeKeyDown = useBrainTreeKeyboard({
  nodes: flatNodes,
  focusedPath,
  expandedPaths: visibleExpandedPaths,
  onFocus: focusBrainNode,
  onExpand: expandFolderPath,
  onCollapse: collapseFolderPath,
  onOpen: openBrainPath,
  onToggle: toggleFolder,
  onRename: renameBrainPath,
  onDelete: deleteBrainPath,
});
```

- [ ] **Step 3: Keep focus in sync and scroll into view**

Add effects inside `BrainView`:

```ts
useEffect(() => {
  if (selectedPath) setFocusedPath(selectedPath);
}, [selectedPath]);

useEffect(() => {
  if (!focusedPath) return;
  const container = treeScrollRef.current;
  if (!container) return;
  const row = container.querySelector(`[data-brain-path="${CSS.escape(focusedPath)}"]`);
  row?.scrollIntoView({ block: "nearest" });
}, [focusedPath]);
```

- [ ] **Step 4: Thread props to the sidebar**

In the `<BrainSidebar ... />` JSX, add props:

```tsx
focusedPath={focusedPath}
onFocusItem={focusBrainNode}
onTreeKeyDown={handleTreeKeyDown}
treeScrollRef={treeScrollRef}
```

Add the matching entries to `BrainSidebar`'s props type and destructuring:

```ts
focusedPath: string;
onFocusItem: (path: string) => void;
onTreeKeyDown: (event: React.KeyboardEvent) => void;
treeScrollRef: React.RefObject<HTMLDivElement | null>;
```

- [ ] **Step 5: Make the scroll container the focus scope**

In `BrainSidebar`, change the scrollable `<div>` (the one with `flex-1 overflow-y-auto px-2 py-3 ...`) to add:

```tsx
ref={treeScrollRef}
role="tree"
tabIndex={0}
aria-activedescendant={focusedPath ? `brain-row-${focusedPath}` : undefined}
onKeyDown={onTreeKeyDown}
```

(Keep the existing `onClick`/`onContextMenu`/drag handlers and the `className` with the `dropTargetPath === "" ` highlight; add `focus:outline-none` to the className so the container does not draw a default outline.)

Thread `focusedPath` and `onFocusItem` down into each `<TreeItem ... />` (both the top-level map and the recursive map): add props `focusedPath={focusedPath}` and `onFocusItem={onFocusItem}`.

- [ ] **Step 6: Focused-row visual + a11y in TreeItem**

Add to `TreeItem`'s props type and destructuring: `focusedPath: string;` and `onFocusItem: (path: string) => void;`.

Compute near the other booleans:

```ts
const focused = node.path === focusedPath;
```

Extend `rowClassName` so a focused, non-active row gets a ring. Change the trailing branch:

```ts
const rowClassName = `group flex w-full items-center gap-1.5 rounded-md py-[5px] pr-2 text-left text-[12.5px] transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
  dropActive
    ? "bg-[#d9d9d4] text-ink ring-1 ring-[#b9b9b1]"
    : active
      ? "bg-[#dfdfda] text-ink"
      : focused
        ? "bg-[#ececea] text-ink ring-1 ring-[#cfcfc8]"
        : contextActive
          ? "bg-[#ebebe7] text-ink"
          : "text-ink/85 hover:bg-[#ececea] hover:text-ink"
}`;
```

On the row `<button>`, add `role="treeitem"`, `tabIndex={-1}`, an id + path marker, and set focus on click. Add these attributes:

```tsx
id={`brain-row-${node.path}`}
data-brain-path={node.path}
role="treeitem"
tabIndex={-1}
aria-selected={active}
```

And in the existing `onClick`, set focus first:

```tsx
onClick={() => {
  onFocusItem(node.path);
  if (node.type === "folder") onToggleFolder(node.path);
  else if (node.file) onSelect(node.file);
}}
```

Also add the id + data marker to the renaming-row container `<div className={rowClassName} ...>` so scroll-into-view still finds the row during rename:

```tsx
id={`brain-row-${node.path}`}
data-brain-path={node.path}
```

- [ ] **Step 7: Focus the container after a click**

So keystrokes work immediately after clicking a row, focus the tree container on row click. In `BrainSidebar`, the container already exists; add to the row click path by focusing the container ref. Simplest: in `BrainView`'s `focusBrainNode`, also focus the container:

```ts
function focusBrainNode(path: string) {
  setFocusedPath(path);
  treeScrollRef.current?.focus();
}
```

- [ ] **Step 8: Typecheck + lint**

Run: `bun run --filter @opencompany/web typecheck && bun run --filter @opencompany/web lint`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/web/components/BrainView.tsx
git commit -m "feat(brain): keyboard navigation with focus cursor"
```

---

### Task 6: Inline name on create

**Files:**
- Modify: `apps/web/components/BrainView.tsx`

- [ ] **Step 1: Enter rename mode after creating a file**

In `createFile`, after the existing `expandAncestors(path);` (before `startTransition`), add:

```ts
setRenamingPath(path);
setRenamingName(fileNameFromPath(path));
setRenamingType("file");
```

Inside the `startTransition` success branch, where it handles `result.path !== path`, also follow the rename target. After the existing `expandAncestors(result.path);` inside that `if`, add:

```ts
setRenamingPath((current) => (current === path ? result.path : current));
setRenamingName(fileNameFromPath(result.path));
```

- [ ] **Step 2: Enter rename mode after creating a folder**

In `createFolder`, after `expandAncestors(path);` (before `startTransition`), add:

```ts
setRenamingPath(folderPath);
setRenamingName(fileNameFromPath(folderPath));
setRenamingType("folder");
```

Inside `createFolder`'s `startTransition` success branch, after the existing `expandAncestors(result.path);` in the `result.path !== path` block, add:

```ts
const resolvedFolder = parentFolderPath(result.path);
setRenamingPath((current) => (current === folderPath ? resolvedFolder : current));
setRenamingName(fileNameFromPath(resolvedFolder));
```

- [ ] **Step 3: Typecheck**

Run: `bun run --filter @opencompany/web typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/BrainView.tsx
git commit -m "feat(brain): inline name field on create"
```

---

### Task 7: Drop onto a file + auto-expand on hover

**Files:**
- Modify: `apps/web/components/BrainView.tsx`

- [ ] **Step 1: Add `dropFolderForNode` and `onAutoExpandFolder`**

Add a module-level helper near `canDropItemOnFolder`:

```ts
function dropFolderForNode(node: BrainTreeNode<BrainFile>) {
  return node.type === "folder" ? node.path : parentFolderPath(node.path);
}
```

In `BrainView`, add a handler (reuse `expandFolderPath` from Task 5 — but auto-expand must not change `selectedContextPath`). Add a dedicated expand-only handler:

```ts
function autoExpandFolderPath(path: string) {
  setExpandedPaths((current) => {
    if (current.has(path)) return current;
    const next = new Set(current);
    next.add(path);
    return next;
  });
}
```

Pass `onAutoExpandFolder={autoExpandFolderPath}` to `<BrainSidebar />`, and thread it through `BrainSidebar` → each `<TreeItem />`. Add `onAutoExpandFolder: (path: string) => void;` to both prop types.

- [ ] **Step 2: Replace folder-only drop gating in TreeItem**

In `TreeItem`, replace:

```ts
const canDropOnFolder = node.type === "folder" && canDropItemOnFolder(draggingItem, node.path);
const dropActive = canDropOnFolder && dropTargetPath === node.path;
```

with drop logic that also accepts files (routing to the parent folder):

```ts
const dropFolder = dropFolderForNode(node);
const canDropHere = canDropItemOnFolder(draggingItem, dropFolder);
const dropActive = canDropHere && dropTargetPath === node.path;
```

Update the `onDragOver` / `onDrop` handlers on the row `<button>` to use `canDropHere` and `dropFolder`:

```tsx
onDragOver={(event) => {
  if (!canDropHere) {
    if (draggingItem) onDropTargetChange(null);
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  event.dataTransfer.dropEffect = "move";
  onDropTargetChange(node.path);
  if (node.type === "folder" && !expanded) scheduleAutoExpand(node.path);
  else clearAutoExpand();
}}
onDrop={(event) => {
  if (!canDropHere) return;
  event.preventDefault();
  event.stopPropagation();
  clearAutoExpand();
  const item = draggedBrainItem(event);
  if (item?.type === "file") onDropFileToFolder(item.path, dropFolder);
  if (item?.type === "folder") onDropFolderToFolder(item.path, dropFolder);
}}
onDragLeave={() => clearAutoExpand()}
```

- [ ] **Step 2b: Auto-expand timer in TreeItem**

Add near the other refs in `TreeItem`:

```ts
const autoExpandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

const clearAutoExpand = () => {
  if (autoExpandTimerRef.current) {
    clearTimeout(autoExpandTimerRef.current);
    autoExpandTimerRef.current = null;
  }
};

const scheduleAutoExpand = (path: string) => {
  if (autoExpandTimerRef.current) return;
  autoExpandTimerRef.current = setTimeout(() => {
    autoExpandTimerRef.current = null;
    onAutoExpandFolder(path);
  }, 600);
};

useEffect(() => clearAutoExpand, []);
```

Update `onDragEnd` to also clear the timer:

```tsx
onDragEnd={() => {
  clearAutoExpand();
  onDragEndItem();
}}
```

- [ ] **Step 3: Update the root drop zone (optional parity)**

The root `<div>` drop handlers in `BrainSidebar` already target `""`; leave them as-is (root is a folder path). No change needed.

- [ ] **Step 4: Typecheck + lint**

Run: `bun run --filter @opencompany/web typecheck && bun run --filter @opencompany/web lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/BrainView.tsx
git commit -m "feat(brain): drop onto file and auto-expand on drag-hover"
```

---

### Task 8: Full verification gate

**Files:** none (verification only).

- [ ] **Step 1: Run the brain unit tests**

Run: `bun run --filter @opencompany/web test -- brain`
Expected: PASS (tree, tree-keyboard, and existing brain tests).

- [ ] **Step 2: Typecheck the web app**

Run: `bun run --filter @opencompany/web typecheck`
Expected: PASS.

- [ ] **Step 3: Lint the web app**

Run: `bun run --filter @opencompany/web lint`
Expected: PASS.

- [ ] **Step 4: Report for local review**

Summarize: files changed, commands run + results, and the four behaviors to verify in the browser (inline name on create, keyboard cursor + Enter-to-open, drop-onto-file, auto-expand). Do not push.

---

## Self-Review

**Spec coverage:**
- Inline name on create → Task 6. ✓
- Keyboard navigation (flatten, resolver, type-ahead, hook, wiring, visual, a11y) → Tasks 1–5. ✓
- Drop onto a file → Task 7 Steps 1–2. ✓
- Auto-expand on hover → Task 7 Steps 1, 2b. ✓
- Double-click stays rename → untouched (no task changes `onDoubleClick`). ✓
- Out-of-scope items → not implemented. ✓

**Placeholder scan:** No TBD/TODO; every code step shows code; commands have expected output. ✓

**Type consistency:** `FlatBrainNode` defined in Task 1, imported in Tasks 2/4/5. `BrainTreeKeyAction` defined in Task 2, consumed in Task 4. `resolveBrainTreeKeyNav`/`findTypeAheadMatch` signatures match between definition and use. Hook option names (`onFocus`, `onExpand`, `onCollapse`, `onOpen`, `onToggle`, `onRename`, `onDelete`) match Task 5 wiring. `flattenVisibleTree(tree, expandedPaths)` signature consistent across Tasks 1, 4, 5. ✓
