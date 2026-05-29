# PRO-20 — Brain filetree that feels like the VS Code filetree

**Linear:** PRO-20 · **Branch:** `jasper/pro-20-improve-brain-interface-to-feel-even-more-like-vs-code`
**Date:** 2026-05-29

## Problem

The Brain view (`apps/web/components/BrainView.tsx`) is a file-tree sidebar plus an
editor. Its click/drag/create behavior is functional but does not match the muscle
memory of the VS Code explorer. We want targeted improvements so the tree *feels* like
VS Code, without rewriting the existing state management.

## Scope

In scope (agreed):

1. **Inline name on create** — creating a file/folder immediately enters the inline
   rename field with the name pre-selected, instead of leaving a fixed `new-note.md`.
2. **Keyboard navigation** with a focus cursor decoupled from the open file
   (VS Code model): arrows, expand/collapse, `Enter`, `F2`, `Delete`/`Backspace`,
   type-ahead.
3. **Drop onto a file** moves the dragged item into that file's parent folder.
4. **Auto-expand** a collapsed folder when hovering over it during a drag.

Explicitly **out of scope** (decided):

- Double-click stays **rename** (we do *not* adopt VS Code's double-click-to-open).
- No multi-select, no multi-item drag.
- No "Esc cancels creation and removes the file" — Esc keeps the default name. True
  cancel-on-create would need a pre-create input node; YAGNI for now.

## Existing building blocks (reuse, do not reinvent)

- Tree model + traversal: `apps/web/lib/brain/tree.ts`
  (`buildBrainTree`, `ancestorFolderPaths`, `parentFolderPath`, `collectFolderPaths`).
  Tree children are sorted **folders-first, then alphabetical** by `sortTreeNodes`, so
  the visible order is the DFS order of the built tree — flattening must walk the tree,
  not the flat file list.
- Rename infrastructure in `BrainView.tsx`: `renamingPath/renamingName/renamingType`,
  `startRenameFile`, `startRenameFolder`, `commitRenameFile`, `commitRenameFolder`,
  the rename `<input>` in `TreeItem`, and `brainFileRenameSelectionEnd` (selects the
  basename without extension).
- Create: `createFile(contextPath)`, `createFolder(contextPath)` — already optimistic,
  already select the new node and set draft content.
- Drag/drop: `canDropItemOnFolder`, `draggedBrainItem`, `dropTargetPath`,
  `moveFileToFolder`, `moveFolderToFolder`, `startDragItem`/`finishDragItem`.
- Row visual states live in one `rowClassName` ternary
  (`dropActive` > `active` > `contextActive` > hover).
- Tests: **vitest** (`describe/it/expect`), run with `bun run --filter @opencompany/web test`.

## Design

### 1. Inline name on create

After the optimistic create + select that `createFile`/`createFolder` already do,
immediately enter rename mode on the new node:

- `createFile`: `startRenameFile(optimisticFile)` so the input opens with the basename
  (minus extension) selected. If the server returns a different path
  (`result.path !== path`), move `renamingPath` to the resolved path.
- `createFolder`: `startRenameFolder(newFolderPath)` (the auto-created `new-note.md`
  inside stays; folders are derived from file paths, so an empty folder cannot exist).
- `Esc` cancels the rename and keeps the default name (no deletion).

### 2. Keyboard navigation (focus-cursor model)

New `focusedPath` state in `BrainView`, **separate** from `selectedPath` (open file)
and `selectedContextPath`. The cursor moves freely over files *and* folders; the editor
only changes on `Enter` for a file.

Pure helpers (testable, no React):

- `flattenVisibleTree(tree, expandedPaths)` → `Array<{ path; type; depth; name }>`
  in DFS/visible order. A folder is followed by its children only when expanded.
  During search the caller passes the all-expanded set (same as `visibleExpandedPaths`),
  so search results flatten fully. Lives in `tree.ts`.
- `resolveBrainTreeKeyNav(key, { nodes, focusedPath, expandedPaths })` → one action or
  `null`. Lives in new `tree-keyboard.ts`. Mapping:
  - `ArrowDown`/`ArrowUp`: `{ type: "focus", path }` (clamped at ends).
  - `ArrowRight`: collapsed folder → `expand`; expanded folder → `focus` first child;
    file → `null`.
  - `ArrowLeft`: expanded folder → `collapse`; otherwise → `focus` parent
    (`null` at root).
  - `Enter`: file → `open`; folder → `toggle`.
  - `F2`: `rename`. `Delete`/`Backspace`: `delete`.
- `findTypeAheadMatch(nodes, buffer, fromIndex)` → next node path whose name starts with
  `buffer` (case-insensitive), searching after `fromIndex` and wrapping. Lives in
  `tree-keyboard.ts`.

React glue: `useBrainTreeKeyboard({ nodes, focusedPath, expandedPaths, on* })` returns an
`onKeyDown` handler. It runs `resolveBrainTreeKeyNav`; printable single characters feed a
type-ahead buffer (with an idle reset timer) routed through `findTypeAheadMatch`. Lives in
`apps/web/components/use-brain-tree-keyboard.ts`.

DOM focus decision (the previously-open detail): the **scroll container** is the focus
scope — `role="tree"`, `tabIndex={0}`, `aria-activedescendant` pointing at the focused
row; it owns `onKeyDown`. Row buttons become `role="treeitem"` with `tabIndex={-1}` so
keyboard `Enter` is handled once by the container (not also by a focused `<button>`).
Mouse clicks still work and also set `focusedPath` and focus the container. The focused
row is scrolled into view with `scrollIntoView({ block: "nearest" })`.

Focus sync: default `focusedPath` to `selectedPath` on mount; clicking a row or selecting
a file updates `focusedPath`; deletions move focus to the nearest remaining sibling/parent.

Visual: add a `focused` branch to `rowClassName` — a subtle outline ring shown when
`node.path === focusedPath` and the row is not `active`. Distinct from the `active`
(open-file) background.

### 3. Drop onto a file → its parent folder

Add `dropFolderForNode(node)` = `node.path` for folders, `parentFolderPath(node.path)`
for files. In `TreeItem`, enable drag-over/drop on **file** rows too, using
`canDropItemOnFolder(draggingItem, dropFolderForNode(node))` and moving into that folder.
The hovered row shows the drop highlight; the move targets the resolved folder.

### 4. Auto-expand on drag-hover

In `TreeItem`, when a drag hovers a **collapsed folder**, start a ~600 ms timer that calls
`onAutoExpandFolder(path)` (expand-only; never collapse). Clear the timer on drag-leave,
drop, drag-end, or when the row stops being the drop target. Timer held in a per-row ref.

## Files

**New:**
- `apps/web/lib/brain/tree-keyboard.ts` — `resolveBrainTreeKeyNav`, `findTypeAheadMatch`.
- `apps/web/lib/brain/tree-keyboard.test.ts` — vitest unit tests.
- `apps/web/components/use-brain-tree-keyboard.ts` — the React hook.

**Modified:**
- `apps/web/lib/brain/tree.ts` — add `flattenVisibleTree`.
- `apps/web/lib/brain/tree.test.ts` — tests for `flattenVisibleTree`.
- `apps/web/components/BrainView.tsx` — `focusedPath` state; wire the hook + container
  a11y/keydown; auto-rename on create; `dropFolderForNode` drop-on-file; auto-expand;
  focused row visual; row `role`/`tabIndex` changes.

## Testing

- **Unit (vitest):** `flattenVisibleTree` (DFS order, expansion gating, search-all-expanded);
  `resolveBrainTreeKeyNav` (every key, plus edges: top/bottom clamp, root `ArrowLeft`,
  file `ArrowRight`, collapsed-vs-expanded folder); `findTypeAheadMatch` (prefix match,
  wrap-around, no match).
- **Automated gate per task:** `bun run --filter @opencompany/web test`, `typecheck`, `lint`.
- **Browser verification:** done by the user locally at the end (create→inline name,
  keyboard cursor + Enter-to-open, drop-on-file, auto-expand). The dev server is the
  user's; we do not start a second one.

## Risks

- Keyboard handler vs. focused `<button>` double-handling `Enter` — mitigated by making
  the container the sole focus scope (`tabIndex={-1}` on rows).
- Type-ahead timer and rename-mode keystrokes must not collide — type-ahead is ignored
  while a rename input is active (rename `<input>` stops propagation).
- Auto-save (800 ms) interaction: the cursor model means arrows never trigger a save;
  only `Enter`-to-open switches files, preserving the existing save-on-switch path.
