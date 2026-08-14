// Pure planning for the brain → wiki migration. The script in
// scripts/migrate-brain-to-wiki.ts applies a plan; everything here is
// side-effect free so the mapping rules are unit-testable:
//
//   - curated pages keep their tree position: <folder_path>/<brain_id>
//   - evidence and archived docs land under archive/ (nothing is deleted,
//     it just moves out of the way); [[ev-...]] citations keep resolving
//     because evidence slugs are preserved
//   - merged docs are superseded and skipped
//   - entity_type collapses onto the wiki kind vocabulary
//   - slug collisions across a workspace's brains get -2/-3 suffixes,
//     first-brain-wins, and are reported rather than silently renamed
//   - timeline jsonb becomes wiki timeline entries; evidence citations ride
//     along as inline [[links]]

import type {
  BrainDocumentFormat,
  BrainEntityType,
  BrainStatus,
  BrainTimelineEntry,
  WikiKind,
} from "./product-schema";

export const WIKI_MIGRATION_KIND_BY_ENTITY_TYPE: Record<BrainEntityType, WikiKind> = {
  person: "person",
  company: "company",
  project: "project",
  meeting: "meeting",
  analysis: "research",
  concept: "other",
  source: "other",
  note: "other",
};

export type WikiMigrationSourceDocument = {
  brainSlug: string;
  brainId: string;
  folderPath: string;
  title: string | null;
  body: string;
  kind: "page" | "evidence";
  entityType: BrainEntityType;
  status: BrainStatus;
  format: BrainDocumentFormat;
  timeline: BrainTimelineEntry[];
  mimeType: string | null;
  originalFileName: string | null;
  assetStorageKey: string | null;
  assetExtractedText: string | null;
  assetContentHash: string | null;
  assetSizeBytes: number | null;
};

export type WikiMigrationPlannedPage = {
  path: string;
  slug: string;
  kind: WikiKind;
  body: string;
  format: BrainDocumentFormat;
  timeline: Array<{ at: string; text: string }>;
  asset: {
    mimeType: string | null;
    originalFileName: string | null;
    assetStorageKey: string | null;
    assetExtractedText: string | null;
    assetContentHash: string | null;
    assetSizeBytes: number | null;
  } | null;
  source: { brainSlug: string; brainId: string };
};

export type WikiMigrationPlan = {
  pages: WikiMigrationPlannedPage[];
  skippedMerged: string[];
  collisions: Array<{ brainSlug: string; brainId: string; slug: string }>;
};

/**
 * Documents must arrive in priority order (the "general" brain first, then by
 * brain age) — the first holder of a slug keeps it.
 */
export function planWikiMigration(documents: WikiMigrationSourceDocument[]): WikiMigrationPlan {
  const plan: WikiMigrationPlan = { pages: [], skippedMerged: [], collisions: [] };
  const takenSlugs = new Set<string>();

  for (const document of documents) {
    if (document.status === "merged") {
      plan.skippedMerged.push(document.brainId);
      continue;
    }

    let slug = document.brainId;
    if (takenSlugs.has(slug)) {
      let suffix = 2;
      while (takenSlugs.has(`${document.brainId}-${suffix}`)) suffix += 1;
      slug = `${document.brainId}-${suffix}`;
      plan.collisions.push({ brainSlug: document.brainSlug, brainId: document.brainId, slug });
    }
    takenSlugs.add(slug);

    const archived = document.kind === "evidence" || document.status === "archived";
    const parent = archived ? `archive/${document.folderPath}` : document.folderPath;
    plan.pages.push({
      path: `${parent}/${slug}`,
      slug,
      kind: WIKI_MIGRATION_KIND_BY_ENTITY_TYPE[document.entityType] ?? "other",
      body: document.body,
      format: document.format,
      timeline: document.timeline.map((entry) => ({
        at: entry.at,
        text: entry.evidenceId ? `${entry.body} [[${entry.evidenceId}]]` : entry.body,
      })),
      asset:
        document.format === "markdown"
          ? null
          : {
              mimeType: document.mimeType,
              originalFileName: document.originalFileName,
              assetStorageKey: document.assetStorageKey,
              assetExtractedText: document.assetExtractedText,
              assetContentHash: document.assetContentHash,
              assetSizeBytes: document.assetSizeBytes,
            },
      source: { brainSlug: document.brainSlug, brainId: document.brainId },
    });
  }

  return plan;
}
