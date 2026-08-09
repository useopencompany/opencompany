import { listWikiPagesWithBodies } from "@opencompany/db/goat-wiki";
import { notFound } from "next/navigation";
import { GoatWikiView } from "@/components/GoatWikiView";
import { currentGoatUser } from "@/lib/auth";

type PageProps = {
  params: Promise<{ path?: string[] }>;
};

// The server ships every page once for instant first paint; after hydration
// the client switches to its Electric-synced collections (see
// lib/wiki-collections.ts) and this payload is never consulted again.
export default async function GoatWikiPage({ params }: PageProps) {
  const { path } = await params;
  const { user, workspace } = await currentGoatUser();
  if (!user.wikiEnabled) notFound();

  const pagePath = (path ?? []).map((segment) => decodeURIComponent(segment)).join("/");
  const pages = await listWikiPagesWithBodies(workspace.id);
  if (pagePath && !pages.some((page) => page.path === pagePath)) notFound();

  return (
    <GoatWikiView
      workspaceId={workspace.id}
      pages={pages.map((page) => ({
        id: page.id,
        slug: page.slug,
        path: page.path,
        title: page.title,
        kind: page.kind,
        body: page.content,
      }))}
      initialPath={pagePath || null}
    />
  );
}
