// Filesystem projection of the wiki tree.
//
// The DB is the source of truth; the file layout agents see in a sandbox is a
// pure projection of page paths:
//   - a leaf page            projects/roadmap      →  projects/roadmap.md
//   - a page with children   projects              →  projects/index.md
// Both forms map back to the same page path (strip `.md` / `/index.md`), so a
// page "promotes" between forms automatically as children appear or vanish —
// neither agents nor the DB ever perform an explicit promote/demote.

import { isValidWikiPath } from "./schema";

export function wikiFilePathForPage(pagePath: string, hasChildren: boolean): string {
  return hasChildren ? `${pagePath}/index.md` : `${pagePath}.md`;
}

/**
 * Inverse projection. Returns null for files that are not a valid page
 * projection (non-markdown files, invalid path segments, a bare root
 * `index.md` — the wiki root is the tree itself, not a page).
 */
export function wikiPagePathFromFilePath(filePath: string): string | null {
  if (!filePath.endsWith(".md")) return null;
  const withoutExtension = filePath.slice(0, -".md".length);
  const pagePath = withoutExtension.endsWith("/index")
    ? withoutExtension.slice(0, -"/index".length)
    : withoutExtension === "index"
      ? ""
      : withoutExtension;
  return isValidWikiPath(pagePath) ? pagePath : null;
}

/**
 * Projects a set of page paths to their file paths. Children are derived from
 * the set itself, so this is the single place that decides `.md` vs `/index.md`.
 */
export function wikiFilePathsForPages(pagePaths: Iterable<string>): Map<string, string> {
  const paths = [...pagePaths];
  const parents = new Set<string>();
  for (const path of paths) {
    const index = path.lastIndexOf("/");
    if (index !== -1) parents.add(path.slice(0, index));
  }
  return new Map(paths.map((path) => [path, wikiFilePathForPage(path, parents.has(path))]));
}

/**
 * Page paths that appear under more than one file path (`foo.md` next to
 * `foo/index.md`). Sync must reject these rather than pick a winner.
 */
export function duplicateWikiPagePaths(filePaths: Iterable<string>): Map<string, string[]> {
  const byPagePath = new Map<string, string[]>();
  for (const filePath of filePaths) {
    const pagePath = wikiPagePathFromFilePath(filePath);
    if (pagePath === null) continue;
    const existing = byPagePath.get(pagePath);
    if (existing) existing.push(filePath);
    else byPagePath.set(pagePath, [filePath]);
  }
  return new Map([...byPagePath].filter(([, files]) => files.length > 1));
}
