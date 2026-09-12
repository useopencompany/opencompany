import { notFound, redirect } from "next/navigation";
import { listHeadlessWikis } from "@/lib/headless-knowledge-server";
import { wikiHref } from "@/lib/wiki-routes";

// `/wiki` has no wiki of its own: it is the stable entry point every other
// surface links to, and it sends the reader to the workspace's default wiki.
export default async function WikiIndexPage() {
  const wikis = await listHeadlessWikis();
  const wiki = wikis.find((entry) => entry.isDefault) ?? wikis[0];
  if (!wiki) notFound();
  redirect(wikiHref(wiki.slug));
}
