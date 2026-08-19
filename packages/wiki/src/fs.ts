// Filesystem projection of the wiki tree.
//
// The DB is the source of truth; the file layout agents see in a sandbox is a
// pure projection of page paths. Folders are directories and pages are always
// `<path>.md`, so no index-file promotion or demotion is necessary.

import { isValidWikiPath } from "./schema";

export function wikiFilePathForPage(pagePath: string): string {
  return `${pagePath}.md`;
}

/**
 * Inverse projection. Returns null for files that are not a valid page
 * projection (non-markdown files or invalid path segments).
 */
export function wikiPagePathFromFilePath(filePath: string): string | null {
  if (!filePath.endsWith(".md")) return null;
  const pagePath = filePath.slice(0, -".md".length);
  return isValidWikiPath(pagePath) ? pagePath : null;
}

/**
 * Projects a set of page paths to their file paths.
 */
export function wikiFilePathsForPages(pagePaths: Iterable<string>): Map<string, string> {
  return new Map([...pagePaths].map((path) => [path, wikiFilePathForPage(path)]));
}
