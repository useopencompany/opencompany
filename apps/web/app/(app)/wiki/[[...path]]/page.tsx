import { notFound } from "next/navigation";
import { WikiView } from "@/components/WikiView";
import { currentUser } from "@/lib/auth";
import { listHeadlessWikiPages } from "@/lib/headless-knowledge-server";

type PageProps = {
  params: Promise<{ path?: string[] }>;
};

// The server ships every page once for instant first paint; after hydration
// the client switches to its Electric-synced collections (see
// lib/headless-knowledge-collections.ts) and this payload is never consulted again.
export default async function WikiPage({ params }: PageProps) {
  const { path } = await params;
  const { user, workspace } = await currentUser();
  if (!user.wikiEnabled) notFound();

  const pagePath = (path ?? []).map((segment) => decodeURIComponent(segment)).join("/");
  const pages = await listHeadlessWikiPages();
  if (pagePath && !pages.some((page) => page.path === pagePath)) notFound();

  return (
    <WikiView
      workspaceId={workspace.id}
      pages={pages.map((page) => ({
        id: page.id,
        slug: page.slug,
        path: page.path,
        title: page.title,
        kind: page.kind,
        body: page.body,
      }))}
      initialPath={pagePath || null}
    />
  );
}
