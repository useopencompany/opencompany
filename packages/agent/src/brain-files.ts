import {
  type BrainEntityType,
  type BrainKind,
  type BrainRelation,
  type BrainSource,
  type BrainStatus,
  type BrainTimelineEntry,
  isValidBrainId,
  normalizeBrainCompiledTruth,
  parseBrainDocument,
} from "@opencompany/brain";
import { brainFilePathFor, listBrainFiles } from "@opencompany/db/brain-files";
import type { BrainDocument as BrainDocumentRow } from "@opencompany/db/product-schema";

export type BrainDocumentView = {
  id: string;
  brainId: string;
  folderPath: string;
  path: string;
  title: string;
  description?: string;
  content: string;
  body: string;
  timeline: BrainTimelineEntry[];
  format: "markdown" | "pdf" | "docx" | "xlsx" | "srt" | "csv" | "tsv" | "json" | "text" | "image";
  mimeType: string;
  originalFileName?: string | null;
  assetStorageKey?: string | null;
  assetSizeBytes?: number | null;
  relations: BrainRelation[];
  sources: BrainSource[];
  kind: BrainKind;
  type: BrainEntityType;
  status: BrainStatus;
  aliases: string[];
  contentHash: string;
  sizeBytes: number;
  parseError?: string | null;
  createdByWorkosId?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type BrainMutationResult =
  | { ok: true; path?: string; document?: BrainDocumentView; quotaPaused?: boolean }
  | { ok: false; message: string };

export function documentViewFromFileRow(row: BrainDocumentRow): BrainDocumentView {
  const parsed = parseBrainDocument(row.content);
  const path = brainFilePathFor(row.folderPath, row.brainId);
  return {
    id: row.id,
    brainId: row.brainId,
    folderPath: row.folderPath,
    path,
    title: row.title || parsed.title || row.brainId,
    ...(parsed.frontmatter.description ? { description: parsed.frontmatter.description } : {}),
    content: row.content,
    body: normalizeBrainCompiledTruth(row.body, row.title || parsed.title || row.brainId),
    timeline: parsed.timeline,
    format: row.format,
    mimeType: row.mimeType ?? "text/markdown",
    originalFileName: row.originalFileName,
    assetStorageKey: row.assetStorageKey,
    assetSizeBytes: row.assetSizeBytes,
    relations: parsed.frontmatter.relations ?? [],
    sources: parsed.frontmatter.sources ?? [],
    kind: row.kind,
    type: row.entityType,
    status: row.status,
    aliases: parsed.frontmatter.aliases ?? [],
    contentHash: row.contentHash,
    sizeBytes: row.sizeBytes,
    parseError: null,
    createdByWorkosId: row.createdByWorkosId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function nextAvailableBrainId(
  brainRef: string,
  baseId: string,
  options: { db?: any } = {},
): Promise<string> {
  const base = isValidBrainId(baseId) ? baseId : "untitled";
  const rows = await listBrainFiles(
    { brainRef },
    { includeInvalid: true, ...(options.db ? { db: options.db } : {}) },
  );
  const used = new Set(rows.map((row) => row.brainId));
  if (!used.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix++) {
    const candidate = brainIdCandidate(base, suffix);
    if (!used.has(candidate)) return candidate;
  }
  throw new Error("Could not allocate a unique brain id.");
}

export function brainIdCandidate(base: string, suffix: number, maxLength = 80): string {
  if (suffix <= 1) return base;
  const ending = `-${suffix}`;
  const prefix = base.slice(0, maxLength - ending.length).replace(/-+$/g, "");
  return `${prefix || "untitled"}${ending}`;
}
