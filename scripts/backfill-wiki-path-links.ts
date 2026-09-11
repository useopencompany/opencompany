// Canonicalize legacy basename wiki links after 0220_goat_wiki_folders.
// Safe to re-run: canonical paths are unchanged, ambiguous basenames are left
// alone, and unchanged page writes do not create another version.
//
// Usage: DATABASE_URL=postgres://... bun scripts/backfill-wiki-path-links.ts

import { getDb } from "@opencompany/db/client";
import { wikiPages, wikiTimelineEntries } from "@opencompany/db/product-schema";
import { rebuildWikiLinksForPage, writeWikiPage } from "@opencompany/db/wiki";
import { canonicalizeWikiPageLinks } from "@opencompany/db/wiki-backfill";
import { asc, eq } from "drizzle-orm";

const db = getDb();
const nodes = await db.select().from(wikiPages).orderBy(asc(wikiPages.wikiId), asc(wikiPages.path));
// Canonicalization resolves a bare basename against its siblings, so it has to
// run per wiki: a basename that is unique inside one wiki may well exist in
// another, and resolving across that boundary is exactly what the wiki_id
// scoping prevents at read time.
const scopes = new Map(
  nodes.map((node) => [node.wikiId, { workspaceId: node.workspaceId, wikiId: node.wikiId }]),
);
const counts = { pages: 0, timelineEntries: 0, rebuilt: 0 };

for (const scope of scopes.values()) {
  const wikiNodes = nodes.filter((node) => node.wikiId === scope.wikiId);
  for (const node of wikiNodes) {
    if (node.nodeType === "folder") {
      await rebuildWikiLinksForPage(node);
      counts.rebuilt += 1;
      continue;
    }
    const body = canonicalizeWikiPageLinks(node.content, wikiNodes);
    const result = await writeWikiPage({
      scope,
      path: node.path,
      body,
      kind: node.kind,
      title: node.title,
      actorWorkosId: null,
    });
    if (result.action === "updated") counts.pages += 1;
    await rebuildWikiLinksForPage(result.page);
    counts.rebuilt += 1;
  }

  const timeline = await db
    .select()
    .from(wikiTimelineEntries)
    .where(eq(wikiTimelineEntries.wikiId, scope.wikiId));
  for (const entry of timeline) {
    const text = canonicalizeWikiPageLinks(entry.text, wikiNodes);
    if (text === entry.text) continue;
    await db.update(wikiTimelineEntries).set({ text }).where(eq(wikiTimelineEntries.id, entry.id));
    counts.timelineEntries += 1;
  }
}

console.log(
  `Wiki link backfill complete: ${counts.pages} page(s) updated, ${counts.timelineEntries} timeline entr(ies) updated, ${counts.rebuilt} link indexes rebuilt.`,
);
