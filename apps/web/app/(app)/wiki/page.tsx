import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { listHeadlessWikis } from "@/lib/headless-knowledge-server";
import { wikiHref } from "@/lib/wiki-routes";

// `/wiki` has no wiki of its own: it is the stable entry point every other
// surface links to, and it sends the reader to the workspace's default wiki.
export default async function WikiIndexPage() {
  // Resolving the reader also activates their workspace. Without it this route asks the API for
  // wikis before a workspace is selected and is refused, which 404s the one URL the sidebar,
  // Slack settings, and the legacy Brain redirect all point at.
  await currentUser();
  const wikis = await listHeadlessWikis();
  const wiki = wikis.find((entry) => entry.isDefault) ?? wikis[0];
  if (!wiki) notFound();
  redirect(wikiHref(wiki.slug));
}
