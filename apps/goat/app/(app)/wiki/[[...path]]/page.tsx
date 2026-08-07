import {
  getWikiBacklinks,
  getWikiTree,
  listWikiTimeline,
  resolveWikiPages,
} from "@opencompany/db/goat-wiki";
import { notFound } from "next/navigation";
import { GoatWikiView } from "@/components/GoatWikiView";
import { currentGoatUser } from "@/lib/auth";

type PageProps = {
  params: Promise<{ path?: string[] }>;
};

export default async function GoatWikiPage({ params }: PageProps) {
  const { path } = await params;
  const { user, workspace } = await currentGoatUser();
  if (!user.wikiEnabled) notFound();

  const pagePath = (path ?? []).join("/");
  const tree = await getWikiTree(workspace.id);
  const selectedEntry = pagePath ? tree.find((entry) => entry.path === pagePath) : undefined;

  const [resolved, timeline, backlinks] = await Promise.all([
    selectedEntry
      ? resolveWikiPages(workspace.id, [selectedEntry.path])
      : Promise.resolve({ pages: [], missing: [] }),
    selectedEntry
      ? listWikiTimeline({ workspaceId: workspace.id, slug: selectedEntry.slug })
      : Promise.resolve([]),
    selectedEntry ? getWikiBacklinks(workspace.id, selectedEntry.slug) : Promise.resolve([]),
  ]);
  const page = resolved.pages[0] ?? null;
  if (pagePath && !page) notFound();

  return (
    <GoatWikiView
      tree={tree.map((entry) => ({
        slug: entry.slug,
        path: entry.path,
        title: entry.title,
        kind: entry.kind,
        updatedAt: entry.updatedAt.toISOString(),
      }))}
      page={
        page
          ? {
              slug: page.slug,
              path: page.path,
              title: page.title,
              kind: page.kind,
              body: page.content,
              updatedAt: page.updatedAt.toISOString(),
              timeline: timeline.map((entry) => ({
                id: entry.id,
                at: entry.at.toISOString(),
                text: entry.text,
              })),
              backlinks: backlinks.map((link) => ({ path: link.path, title: link.title })),
            }
          : null
      }
    />
  );
}
