// Disable legacy Brain ingestion routes after the Wiki cutover. This is
// intentionally reversible and does not delete source configuration or data.
//
// Usage:
//   DATABASE_URL=postgres://... bun scripts/disable-brain-sources.ts --workspace <id> [--dry-run]

import { parseArgs } from "node:util";
import { setBrainSourceEnabled } from "@opencompany/db/brain-sources";
import { getDb } from "@opencompany/db/client";
import { brainSources, brains, workspaces } from "@opencompany/db/product-schema";
import { and, asc, eq } from "drizzle-orm";

const { values: args } = parseArgs({
  options: {
    workspace: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});
const dryRun = args["dry-run"] === true;

if (!args.workspace) {
  console.error("--workspace <id> is required.");
  process.exit(1);
}
const workspaceId = args.workspace;
const db = getDb();
const [workspace] = await db
  .select({ id: workspaces.id, name: workspaces.name })
  .from(workspaces)
  .where(eq(workspaces.id, workspaceId))
  .limit(1);
if (!workspace) {
  console.error(`No workspace "${workspaceId}".`);
  process.exit(1);
}

const enabledSources = await db
  .select({
    id: brainSources.id,
    provider: brainSources.provider,
    brainId: brains.id,
    workspaceId: brains.workspaceId,
  })
  .from(brainSources)
  .innerJoin(brains, eq(brains.id, brainSources.brainId))
  .where(and(eq(brains.workspaceId, workspaceId), eq(brainSources.enabled, true)))
  .orderBy(asc(brains.workspaceId), asc(brainSources.provider), asc(brainSources.id));

const scope = `workspace ${workspaceId}`;
console.log(`${scope}: ${enabledSources.length} enabled Brain source(s) found.`);
for (const source of enabledSources) {
  console.log(
    `  ${dryRun ? "would disable" : "disable"}: ${source.provider} ${source.id} (brain ${source.brainId})`,
  );
}

if (dryRun || enabledSources.length === 0) process.exit(0);

let disabledCount = 0;
for (const source of enabledSources) {
  const disabled = await setBrainSourceEnabled({
    brainRef: source.brainId,
    sourceId: source.id,
    enabled: false,
  });
  if (disabled) disabledCount += 1;
}
console.log(`Disabled ${disabledCount} Brain source(s) and canceled their active ingest jobs.`);
