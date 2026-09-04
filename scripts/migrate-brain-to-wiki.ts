// Migrate a workspace's brain(s) into its wiki (brain v2). Deterministic and
// re-runnable — the intended flow is: run, inspect the wiki, run again after
// more brain activity if needed. Chat-driven migration was rejected on
// purpose: a script can be tested, diffed, and repeated per workspace.
//
// - Non-destructive: Brain tables are never written. Legacy source shutdown is
//   a separate reversible disable step; no Brain rows are deleted.
// - Idempotent: pages write through the wiki storage layer (unchanged bodies
//   are no-ops), timeline entries dedupe on (at, text), asset rows skip when
//   the path already exists.
// - Multiple brains merge into the one workspace wiki; sibling path collisions
//   get -2/-3 suffixes (logged).
// - Evidence and archived docs land under archive/; merged docs are skipped.
//
// Usage:
//   DATABASE_URL=postgres://... bun scripts/migrate-brain-to-wiki.ts [--workspace <id>] [--dry-run]

import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { getDb } from "@opencompany/db/client";
import {
  brainDocuments,
  brains as brainRows,
  wikiPages,
  workspaces as workspaceRows,
} from "@opencompany/db/product-schema";
import {
  addWikiTimelineEntry,
  createWikiFolder,
  hashWikiContent,
  listWikiTimeline,
  writeWikiPage,
} from "@opencompany/db/wiki";
import {
  planWikiMigration,
  type WikiMigrationPlannedPage,
  type WikiMigrationSourceDocument,
} from "@opencompany/db/wiki-migrate";
import { deriveWikiTitle, isValidWikiPath } from "@opencompany/wiki";
import { and, asc, eq } from "drizzle-orm";

const { values: args } = parseArgs({
  options: {
    workspace: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});
const dryRun = args["dry-run"] === true;

const db = getDb();

const workspaces = args.workspace
  ? await db.select().from(workspaceRows).where(eq(workspaceRows.id, args.workspace))
  : await db.select().from(workspaceRows).orderBy(asc(workspaceRows.createdAt));
if (workspaces.length === 0) {
  console.error(args.workspace ? `No workspace "${args.workspace}".` : "No workspaces.");
  process.exit(1);
}

for (const workspace of workspaces) {
  const allWorkspaceBrains = await db
    .select()
    .from(brainRows)
    .where(eq(brainRows.workspaceId, workspace.id))
    .orderBy(asc(brainRows.createdAt));
  if (allWorkspaceBrains.length === 0) {
    console.log(`\n${workspace.name} (${workspace.id}): no brains, skipping.`);
    continue;
  }
  const restrictedBrains = allWorkspaceBrains.filter((brain) => brain.visibility === "restricted");
  for (const brain of restrictedBrains) {
    console.log(
      `\n${workspace.name} (${workspace.id}): restricted brain ${brain.name} (${brain.id}) skipped.`,
    );
  }
  const workspaceBrains = allWorkspaceBrains.filter((brain) => brain.visibility !== "restricted");
  if (workspaceBrains.length === 0) {
    console.log(`  no workspace-visible brains to migrate.`);
    continue;
  }
  // "general" first so it wins contested slugs; then by age.
  workspaceBrains.sort((a, b) =>
    a.slug === "general" ? -1 : b.slug === "general" ? 1 : +a.createdAt - +b.createdAt,
  );

  const sourceDocuments: WikiMigrationSourceDocument[] = [];
  for (const brain of workspaceBrains) {
    const documents = await db
      .select()
      .from(brainDocuments)
      .where(eq(brainDocuments.brainRef, brain.id))
      .orderBy(asc(brainDocuments.folderPath), asc(brainDocuments.brainId));
    for (const document of documents) {
      sourceDocuments.push({
        brainSlug: brain.slug,
        brainId: document.brainId,
        folderPath: document.folderPath,
        title: document.title,
        body: document.body,
        kind: document.kind,
        entityType: document.entityType,
        status: document.status,
        format: document.format,
        timeline: document.timeline,
        mimeType: document.mimeType,
        originalFileName: document.originalFileName,
        assetStorageKey: document.assetStorageKey,
        assetExtractedText: document.assetExtractedText,
        assetContentHash: document.assetContentHash,
        assetSizeBytes: document.assetSizeBytes,
      });
    }
  }

  const plan = planWikiMigration(sourceDocuments);
  console.log(
    `\n${workspace.name} (${workspace.id}): ${workspaceBrains.length} workspace-visible brain(s), ${restrictedBrains.length} restricted brain(s) skipped, ${plan.pages.length} page(s) to write, ` +
      `${plan.skippedMerged.length} merged skipped, ${plan.collisions.length} slug collision(s).`,
  );
  for (const collision of plan.collisions) {
    console.log(
      `  collision: ${collision.brainSlug}/${collision.brainId} → sibling slug "${collision.slug}"`,
    );
  }
  if (dryRun) {
    for (const page of plan.pages.slice(0, 30)) {
      console.log(`  plan: ${page.path} [${page.kind}${page.asset ? ", asset" : ""}]`);
    }
    if (plan.pages.length > 30) console.log(`  … and ${plan.pages.length - 30} more`);
    continue;
  }

  const counts = { created: 0, updated: 0, unchanged: 0, assets: 0, timeline: 0, invalid: 0 };
  for (const page of plan.pages) {
    if (!isValidWikiPath(page.path)) {
      counts.invalid += 1;
      console.log(`  invalid path, skipped: ${page.path}`);
      continue;
    }
    if (page.asset) {
      const wrote = await writeAssetPage(workspace.id, page);
      if (wrote) counts.assets += 1;
      continue;
    }
    const result = await writeWikiPage({
      workspaceId: workspace.id,
      path: page.path,
      body: page.body,
      kind: page.kind,
      actorWorkosId: null,
    });
    counts[result.action] += 1;
    counts.timeline += await migrateTimeline(workspace.id, result.page.path, page.timeline);
  }
  console.log(
    `  done: ${counts.created} created, ${counts.updated} updated, ${counts.unchanged} unchanged, ` +
      `${counts.assets} asset page(s), ${counts.timeline} timeline entr(ies), ${counts.invalid} invalid.`,
  );
}

// Binary-backed docs bypass writeWikiPage (which is markdown-only) and copy
// the asset columns; the blob itself stays at the same storage key.
async function writeAssetPage(workspaceId: string, page: WikiMigrationPlannedPage) {
  const existing = await db
    .select({ id: wikiPages.id })
    .from(wikiPages)
    .where(and(eq(wikiPages.workspaceId, workspaceId), eq(wikiPages.path, page.path)))
    .limit(1);
  if (existing.length > 0) return false;
  // Ensure ancestors exist as folders.
  const parentPath = page.path.slice(0, page.path.lastIndexOf("/"));
  if (parentPath) {
    await createWikiFolder({ workspaceId, path: parentPath, actorWorkosId: null });
  }
  await db.insert(wikiPages).values({
    id: randomUUID(),
    workspaceId,
    slug: page.slug,
    path: page.path,
    title: deriveWikiTitle(page.body, page.slug),
    kind: page.kind,
    content: page.body,
    contentHash: hashWikiContent(page.body),
    sizeBytes: Buffer.byteLength(page.body, "utf8"),
    format: page.format,
    mimeType: page.asset?.mimeType ?? null,
    originalFileName: page.asset?.originalFileName ?? null,
    assetStorageKey: page.asset?.assetStorageKey ?? null,
    assetExtractedText: page.asset?.assetExtractedText ?? null,
    assetContentHash: page.asset?.assetContentHash ?? null,
    assetSizeBytes: page.asset?.assetSizeBytes ?? null,
  });
  return true;
}

async function migrateTimeline(
  workspaceId: string,
  path: string,
  entries: Array<{ at: string; text: string }>,
) {
  if (entries.length === 0) return 0;
  const existing = await listWikiTimeline({ workspaceId, path });
  const seen = new Set(existing.map((entry) => `${entry.at.toISOString()}\0${entry.text}`));
  let added = 0;
  for (const entry of entries) {
    const at = new Date(entry.at);
    if (Number.isNaN(at.getTime())) continue;
    const key = `${at.toISOString()}\0${entry.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await addWikiTimelineEntry({ workspaceId, path, at, text: entry.text, actorWorkosId: null });
    added += 1;
  }
  return added;
}
