// The shape of a wiki URL, shared by the server routes under app/(app)/wiki and the client
// sidebar. Free of both "use client" and server-only imports so either side can call it.

/**
 * The static segments under `/wiki/`. Next resolves these before the `[wikiSlug]` segment, so a
 * path matching one is a page of its own rather than a wiki. `RESERVED_WIKI_SLUGS` in
 * `packages/db/src/wikis.ts` keeps a wiki from ever taking one of these names; the two lists are
 * asserted equal in wiki-routes.test.ts.
 */
export const WIKI_STATIC_SEGMENTS: ReadonlySet<string> = new Set(["sources", "import"]);

export function wikiHref(slug: string, path?: string | null) {
  const base = `/wiki/${encodeURIComponent(slug)}`;
  if (!path) return base;
  const encoded = path
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return encoded ? `${base}/${encoded}` : base;
}

/** The wiki the reader is inside, or null on `/wiki`, `/wiki/sources` and `/wiki/import`. */
export function activeWikiSlugFromPathname(pathname: string): string | null {
  const segment = /^\/wiki\/([^/]+)/.exec(pathname)?.[1];
  if (!segment) return null;
  const slug = decodeURIComponent(segment);
  return WIKI_STATIC_SEGMENTS.has(slug) ? null : slug;
}

/** The page path within a wiki, i.e. everything after `/wiki/<slug>/`. */
export function wikiPagePathFromPathname(pathname: string, slug: string): string | null {
  const prefix = `${wikiHref(slug)}/`;
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  return rest ? decodeURIComponent(rest) : null;
}
