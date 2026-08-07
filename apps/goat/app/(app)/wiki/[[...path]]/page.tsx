import { getWikiTimelineCounts, listWikiPagesWithBodies } from "@opencompany/db/goat-wiki";
import { notFound } from "next/navigation";
import { GoatWikiView } from "@/components/GoatWikiView";
import { currentGoatUser } from "@/lib/auth";

type PageProps = {
  params: Promise<{ path?: string[] }>;
};

// The whole wiki ships in one payload (bodies included) so page-to-page
// navigation is a client-side state change, not a server round-trip. Wikis are
// lightweight-Notion scale; this is a deliberate trade for instant UX.
export default async function GoatWikiPage({ params }: PageProps) {
  const { path } = await params;
  const { user, workspace } = await currentGoatUser();
  if (!user.wikiEnabled) notFound();

  const pagePath = (path ?? []).map((segment) => decodeURIComponent(segment)).join("/");
  const [pages, timelineCounts] = await Promise.all([
    listWikiPagesWithBodies(workspace.id),
    getWikiTimelineCounts(workspace.id),
  ]);
  if (pagePath && !pages.some((page) => page.path === pagePath)) notFound();

  return (
    <GoatWikiView
      pages={pages.map((page) => ({
        slug: page.slug,
        path: page.path,
        title: page.title,
        kind: page.kind,
        body: page.content,
        updatedAt: page.updatedAt.toISOString(),
        timelineCount: timelineCounts.get(page.id) ?? 0,
      }))}
      initialPath={pagePath || null}
    />
  );
}
