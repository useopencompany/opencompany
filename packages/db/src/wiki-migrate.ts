// Pure planning for the brain → wiki migration. The script in
// scripts/migrate-brain-to-wiki.ts applies a plan; everything here is
// side-effect free so the mapping rules are unit-testable:
//
//   - curated pages keep their tree position: <folder_path>/<brain_id>
//   - evidence and archived docs land under archive/ (nothing is deleted,
//     it just moves out of the way); citations use their full planned paths
//   - merged docs are superseded and skipped
//   - entity_type collapses onto the wiki kind vocabulary
//   - basename collisions within one folder get -2/-3 suffixes and are reported
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
  const takenPaths = new Set<string>();
  const sourceTimeline = new Map<WikiMigrationPlannedPage, BrainTimelineEntry[]>();
  const pathBySource = new Map<string, string>();

  for (const document of documents) {
    if (document.status === "merged") {
      plan.skippedMerged.push(document.brainId);
      continue;
    }

    const archived = document.kind === "evidence" || document.status === "archived";
    const parent = archived ? `archive/${document.folderPath}` : document.folderPath;
    let slug = document.brainId;
    let path = `${parent}/${slug}`;
    if (takenPaths.has(path)) {
      let suffix = 2;
      while (takenPaths.has(`${parent}/${document.brainId}-${suffix}`)) suffix += 1;
      slug = `${document.brainId}-${suffix}`;
      path = `${parent}/${slug}`;
      plan.collisions.push({ brainSlug: document.brainSlug, brainId: document.brainId, slug });
    }
    takenPaths.add(path);

    const page: WikiMigrationPlannedPage = {
      path,
      slug,
      kind: WIKI_MIGRATION_KIND_BY_ENTITY_TYPE[document.entityType] ?? "other",
      body: document.body,
      format: document.format,
      timeline: [],
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
    };
    plan.pages.push(page);
    sourceTimeline.set(page, document.timeline);
    pathBySource.set(sourceKey(document.brainSlug, document.brainId), path);
  }

  for (const page of plan.pages) {
    page.timeline = (sourceTimeline.get(page) ?? []).map((entry) => {
      if (!entry.evidenceId) return { at: entry.at, text: entry.body };
      const evidencePath = pathBySource.get(sourceKey(page.source.brainSlug, entry.evidenceId));
      return {
        at: entry.at,
        text: evidencePath ? `${entry.body} [[${evidencePath}]]` : entry.body,
      };
    });
  }

  return plan;
}

function sourceKey(brainSlug: string, brainId: string): string {
  return `${brainSlug}\0${brainId}`;
}
