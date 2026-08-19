// Core wiki vocabulary: node types, kinds, slugs, and tree paths.
//
// `path` is the workspace-unique identity of a node. `slug` is its final path
// segment and is unique only among siblings. Leading path segments are folders;
// pages are always leaves. `[[wiki-links]]` target full page paths, so moving a
// node rewrites both subtree paths and links that point into the subtree.
// Invariant: the last path segment is always the node's slug.

export const WIKI_NODE_TYPES = ["page", "folder"] as const;

export type WikiNodeType = (typeof WIKI_NODE_TYPES)[number];

export function isValidWikiNodeType(value: unknown): value is WikiNodeType {
  return typeof value === "string" && (WIKI_NODE_TYPES as readonly string[]).includes(value);
}

export const WIKI_KINDS = ["project", "person", "company", "research", "meeting", "other"] as const;

export type WikiKind = (typeof WIKI_KINDS)[number];

export const DEFAULT_WIKI_KIND: WikiKind = "other";

export function isValidWikiKind(value: unknown): value is WikiKind {
  return typeof value === "string" && (WIKI_KINDS as readonly string[]).includes(value);
}

export const WIKI_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;

// Depth is a soft product bound, not a structural necessity; 10 is far beyond
// any sane wiki and exists only to bound path length and recursion.
export const MAX_WIKI_PATH_DEPTH = 10;

export function isValidWikiSlug(value: unknown): value is string {
  return typeof value === "string" && WIKI_SLUG_PATTERN.test(value);
}

export function isValidWikiPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  const segments = value.split("/");
  if (segments.length > MAX_WIKI_PATH_DEPTH) return false;
  return segments.every((segment) => WIKI_SLUG_PATTERN.test(segment));
}

export function wikiSlugFromPath(path: string): string {
  const segments = path.split("/");
  return segments[segments.length - 1] ?? "";
}

/** Containing folder path, or null for a root node. */
export function parentWikiPath(path: string): string | null {
  const index = path.lastIndexOf("/");
  return index === -1 ? null : path.slice(0, index);
}

export function wikiPathDepth(path: string): number {
  return path.split("/").length;
}

export function isWikiDescendantPath(path: string, ancestorPath: string): boolean {
  return path.startsWith(`${ancestorPath}/`);
}

/** Rewrites `path` when the subtree rooted at `fromPath` moves to `toPath`. */
export function movedWikiPath(path: string, fromPath: string, toPath: string): string {
  if (path === fromPath) return toPath;
  if (!isWikiDescendantPath(path, fromPath)) return path;
  return `${toPath}${path.slice(fromPath.length)}`;
}

// Source refs point at artifacts in other tools: `provider:opaque-id`, e.g.
// `linear:issue:ENG-123`, `gmail:thread:abc`, `github:owner/repo:pull:123`.
// Same grammar the brain used, so existing refs migrate verbatim.
export const WIKI_SOURCE_REF_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}:[^\s[\]|]+$/;
export const WIKI_SOURCE_REF_MAX_LENGTH = 256;

export type ParsedWikiSourceRef = {
  raw: string;
  provider: string;
  id: string;
};

export function isValidWikiSourceRef(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= WIKI_SOURCE_REF_MAX_LENGTH &&
    WIKI_SOURCE_REF_PATTERN.test(value)
  );
}

export function parseWikiSourceRef(value: unknown): ParsedWikiSourceRef | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!isValidWikiSourceRef(raw)) return null;
  const separator = raw.indexOf(":");
  return { raw, provider: raw.slice(0, separator), id: raw.slice(separator + 1) };
}

/** Best-effort slug from a human title; returns null when nothing usable remains. */
export function wikiSlugFromTitle(title: string): string | null {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return isValidWikiSlug(slug) ? slug : null;
}
