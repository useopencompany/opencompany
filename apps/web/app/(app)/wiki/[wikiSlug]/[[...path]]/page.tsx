import { notFound, redirect } from "next/navigation";
import { WikiView } from "@/components/WikiView";
import { currentUser } from "@/lib/auth";
import { listHeadlessWikiPages, listHeadlessWikis } from "@/lib/headless-knowledge-server";
import { wikiHref } from "@/lib/wiki-routes";

type PageProps = {
  params: Promise<{ wikiSlug: string; path?: string[] }>;
};

// The server ships every page once for instant first paint; after hydration
// the client switches to its Electric-synced collections (see
// lib/headless-knowledge-collections.ts) and this payload is never consulted again.
export default async function WikiPage({ params }: PageProps) {
  const { wikiSlug, path } = await params;
  const { user, workspace } = await currentUser();

  const pagePath = (path ?? []).map((segment) => decodeURIComponent(segment)).join("/");
  // `listHeadlessWikis` already excludes the restricted wikis the reader cannot
  // reach, so an unreachable slug 404s exactly like an unknown one -- it must
  // never fall back to the default wiki, which would silently show the wrong
  // wiki's pages under someone else's URL.
  const wikis = await listHeadlessWikis();
  const wiki = wikis.find((entry) => entry.slug === decodeURIComponent(wikiSlug));
  if (!wiki) return legacyPageRedirect(wikis, wikiSlug, path ?? []);
  const pages = await listHeadlessWikiPages(wiki.id);
  if (pagePath && !pages.some((page) => page.path === pagePath)) notFound();

  return (
    <WikiView
      userWorkosId={user.workosUserId}
      wikiId={wiki.id}
      wikiSlug={wiki.slug}
      workspaceId={workspace.id}
      pages={pages.map((page) => ({
        id: page.id,
        slug: page.slug,
        path: page.path,
        title: page.title,
        nodeType: page.nodeType,
        kind: page.kind,
        body: page.body,
      }))}
      initialPath={pagePath || null}
    />
  );
}

/**
 * Before per-wiki routes there was one wiki per workspace and `/wiki/<page-path>` addressed a page
 * in it. Those URLs are in bookmarks, Slack messages and chat transcripts, and after this change
 * their first segment reads as a wiki slug instead. Resolve them against the default wiki once and
 * send the reader to the current address rather than showing them a 404 for a page that still
 * exists.
 *
 * Only reached when no wiki matches the first segment, so it cannot shadow a real wiki.
 */
async function legacyPageRedirect(
  wikis: Awaited<ReturnType<typeof listHeadlessWikis>>,
  wikiSlug: string,
  rest: string[],
): Promise<never> {
  const legacyPath = [wikiSlug, ...rest].map((segment) => decodeURIComponent(segment)).join("/");
  const fallback = wikis.find((entry) => entry.isDefault);
  if (fallback) {
    const pages = await listHeadlessWikiPages(fallback.id);
    if (pages.some((page) => page.path === legacyPath)) {
      redirect(wikiHref(fallback.slug, legacyPath));
    }
  }
  notFound();
}
