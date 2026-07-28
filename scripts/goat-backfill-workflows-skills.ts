// Backfill goat.workflows and goat.skills from the reserved Brain folders they
// used to live in. Extraction moved Workflows/Skills out of the Brain into their
// own workspace-scoped tables (migration 0163); this copies existing content
// over so nothing disappears when the surfaces move.
//
// - Non-destructive: only inserts. The old Brain docs are removed by a separate,
//   later step once this backfill is verified.
// - Idempotent: existing (workspace_id, slug) rows are skipped, so re-runs are
//   safe.
// - Collisions: two Brains in one workspace can hold the same slug. The "general"
//   Brain wins the base slug; later duplicates get a "-2", "-3", ... suffix. Every
//   collision is logged so nothing is silently dropped.
//
// Usage: DATABASE_URL=postgres://... bun run scripts/goat-backfill-workflows-skills.ts

import { createHash, randomUUID } from "node:crypto";
import { getDb } from "@opencompany/db/client";
import {
  goatBrainDocuments,
  goatBrains,
  goatSkills,
  goatWorkflows,
} from "@opencompany/db/goat-schema";
import {
  goatBrainSkillFromDocument,
  goatBrainWorkflowFromDocument,
  parseGoatBrainDocument,
} from "@opencompany/goat-brain";
import { eq, like, or } from "drizzle-orm";

const GENERAL_BRAIN_SLUG = "general";

type BrainMeta = { workspaceId: string; isGeneral: boolean };

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("Set DATABASE_URL to the target database before running the backfill.");
    process.exit(1);
  }
  const db = getDb();

  const brains = await db
    .select({ id: goatBrains.id, workspaceId: goatBrains.workspaceId, slug: goatBrains.slug })
    .from(goatBrains);
  const brainMeta = new Map<string, BrainMeta>(
    brains.map((brain) => [
      brain.id,
      { workspaceId: brain.workspaceId, isGeneral: brain.slug === GENERAL_BRAIN_SLUG },
    ]),
  );

  await backfillWorkflows(db, brainMeta);
  await backfillSkills(db, brainMeta);
  console.log("Backfill complete.");
  process.exit(0);
}

// Sort so "general"-Brain docs are inserted first: they win the un-suffixed slug
// when two Brains in one workspace share it.
function generalFirst<T extends { meta: BrainMeta; sourceKey: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const workspaceOrder = a.meta.workspaceId.localeCompare(b.meta.workspaceId);
    if (workspaceOrder !== 0) return workspaceOrder;
    const generalOrder = Number(b.meta.isGeneral) - Number(a.meta.isGeneral);
    return generalOrder !== 0 ? generalOrder : a.sourceKey.localeCompare(b.sourceKey);
  });
}

async function backfillWorkflows(db: ReturnType<typeof getDb>, brainMeta: Map<string, BrainMeta>) {
  const docs = await db
    .select({
      brainRef: goatBrainDocuments.brainRef,
      brainId: goatBrainDocuments.brainId,
      content: goatBrainDocuments.content,
      format: goatBrainDocuments.format,
    })
    .from(goatBrainDocuments)
    .where(
      or(
        eq(goatBrainDocuments.folderPath, "workflows"),
        like(goatBrainDocuments.folderPath, "workflows/%"),
      ),
    );

  const parsed = generalFirst(
    docs.flatMap((row) => {
      const meta = brainMeta.get(row.brainRef);
      if (!meta || row.format !== "markdown") return [];
      const workflow = goatBrainWorkflowFromDocument(parseGoatBrainDocument(row.content));
      if (!workflow || workflow.id !== row.brainId) return [];
      return [{ meta, sourceKey: `${row.brainRef}:${row.brainId}`, workflow }];
    }),
  );

  // Stable target IDs distinguish a rerun from a different Brain document that
  // happens to use the same slug. Slugs alone cannot make that distinction.
  const existing = await db
    .select({
      id: goatWorkflows.id,
      workspaceId: goatWorkflows.workspaceId,
      slug: goatWorkflows.slug,
    })
    .from(goatWorkflows);
  const existingIds = new Set(existing.map((row) => row.id));
  const takenByWorkspace = new Map<string, Set<string>>();
  for (const row of existing) {
    getSet(takenByWorkspace, row.workspaceId).add(row.slug);
  }

  let inserted = 0;
  let skipped = 0;
  let suffixed = 0;
  for (const { meta, sourceKey, workflow } of parsed) {
    const id = migratedId("goat_wf", meta.workspaceId, sourceKey);
    if (existingIds.has(id)) {
      skipped++;
      continue;
    }
    const taken = getSet(takenByWorkspace, meta.workspaceId);
    const slug = uniqueSlug(taken, workflow.id);
    if (slug !== workflow.id) {
      suffixed++;
      console.warn(
        `[workflows] slug collision in workspace ${meta.workspaceId}: "${workflow.id}" -> "${slug}"`,
      );
    }
    taken.add(slug);
    await db.insert(goatWorkflows).values({
      id,
      workspaceId: meta.workspaceId,
      slug,
      name: workflow.name,
      description: workflow.description,
      instructions: workflow.instructions,
      model: workflow.model,
      status: "active",
    });
    existingIds.add(id);
    inserted++;
  }
  console.log(
    `[workflows] inserted ${inserted}, skipped ${skipped} (already present), suffixed ${suffixed} collision(s).`,
  );
}

async function backfillSkills(db: ReturnType<typeof getDb>, brainMeta: Map<string, BrainMeta>) {
  const docs = await db
    .select({
      brainRef: goatBrainDocuments.brainRef,
      brainId: goatBrainDocuments.brainId,
      content: goatBrainDocuments.content,
      format: goatBrainDocuments.format,
    })
    .from(goatBrainDocuments)
    .where(
      or(
        eq(goatBrainDocuments.folderPath, "skills"),
        like(goatBrainDocuments.folderPath, "skills/%"),
      ),
    );

  const parsed = generalFirst(
    docs.flatMap((row) => {
      const meta = brainMeta.get(row.brainRef);
      if (!meta || row.format !== "markdown") return [];
      const skill = goatBrainSkillFromDocument(parseGoatBrainDocument(row.content));
      if (!skill || skill.id !== row.brainId) return [];
      return [{ meta, skill, sourceKey: `${row.brainRef}:${row.brainId}` }];
    }),
  );

  const existing = await db
    .select({ id: goatSkills.id, workspaceId: goatSkills.workspaceId, slug: goatSkills.slug })
    .from(goatSkills);
  const existingIds = new Set(existing.map((row) => row.id));
  const takenByWorkspace = new Map<string, Set<string>>();
  for (const row of existing) {
    getSet(takenByWorkspace, row.workspaceId).add(row.slug);
  }

  let inserted = 0;
  let skipped = 0;
  let suffixed = 0;
  for (const { meta, skill, sourceKey } of parsed) {
    const id = migratedId("goat_skill", meta.workspaceId, sourceKey);
    if (existingIds.has(id)) {
      skipped++;
      continue;
    }
    const taken = getSet(takenByWorkspace, meta.workspaceId);
    const slug = uniqueSlug(taken, skill.id);
    if (slug !== skill.id) {
      suffixed++;
      console.warn(
        `[skills] slug collision in workspace ${meta.workspaceId}: "${skill.id}" -> "${slug}"`,
      );
    }
    taken.add(slug);
    await db.insert(goatSkills).values({
      id,
      workspaceId: meta.workspaceId,
      slug,
      name: skill.name,
      description: skill.description,
      instructions: skill.instructions,
      status: "active",
    });
    existingIds.add(id);
    inserted++;
  }
  console.log(
    `[skills] inserted ${inserted}, skipped ${skipped} (already present), suffixed ${suffixed} collision(s).`,
  );
}

function getSet(map: Map<string, Set<string>>, key: string): Set<string> {
  let set = map.get(key);
  if (!set) {
    set = new Set<string>();
    map.set(key, set);
  }
  return set;
}

function migratedId(
  kind: "goat_wf" | "goat_skill",
  workspaceId: string,
  sourceKey: string,
): string {
  const digest = createHash("sha256")
    .update(`${kind}:${workspaceId}:${sourceKey}`)
    .digest("hex")
    .slice(0, 32);
  return `${kind}_${digest}`;
}

function uniqueSlug(taken: Set<string>, base: string): string {
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base.slice(0, 60)}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base.slice(0, 55)}-${randomUUID().slice(0, 8)}`;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
