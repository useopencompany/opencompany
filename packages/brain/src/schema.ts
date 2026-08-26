// Workflows and legacy skills used to live in reserved Brain folders. Workflows moved to their
// workspace table; Agent Skills now use immutable bundles outside Brain.
export const HARD_DEFAULT_BRAIN_FOLDERS = ["inbox", "people", "companies", "evidence"] as const;

export const ADJUSTABLE_DEFAULT_BRAIN_FOLDERS = [
  "thoughts",
  "projects",
  "meetings",
  "research",
  "decisions",
  "concepts",
] as const;

export const DEFAULT_BRAIN_FOLDERS = [
  "inbox",
  ...ADJUSTABLE_DEFAULT_BRAIN_FOLDERS,
  "people",
  "companies",
  "evidence",
] as const;

export const BRAIN_MIDDLE_FOLDER_ORDER = ADJUSTABLE_DEFAULT_BRAIN_FOLDERS;

export type BrainDefaultFolder = (typeof DEFAULT_BRAIN_FOLDERS)[number];
export type HardDefaultBrainFolder = (typeof HARD_DEFAULT_BRAIN_FOLDERS)[number];
export type AdjustableDefaultBrainFolder = (typeof ADJUSTABLE_DEFAULT_BRAIN_FOLDERS)[number];
export type BrainDocumentFormat =
  | "markdown"
  | "pdf"
  | "docx"
  | "xlsx"
  | "srt"
  | "csv"
  | "tsv"
  | "json"
  | "text"
  | "image";

export const BRAIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;
export const BRAIN_FOLDER_PATTERN = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*){0,5}$/;
export const BRAIN_RELATION_TYPE_PATTERN = /^[a-z][a-z0-9_]*$/;
export const BRAIN_ENTITY_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
export const DEFAULT_BRAIN_RELATION_TYPE = "related";

// One question decides the type: what does this record represent?
// External artifacts of any format (articles, videos, email threads, repos)
// are `source` — the source ref's provider already carries the format nuance.
// Synthesized prose (research reports, drafts) is `analysis`.
export const BRAIN_ENTITY_TYPES = [
  "person",
  "company",
  "project",
  "meeting",
  "concept",
  "source",
  "analysis",
  "note",
] as const;

export type BrainEntityType = (typeof BRAIN_ENTITY_TYPES)[number];

export const BRAIN_KINDS = ["page", "evidence"] as const;

export type BrainKind = (typeof BRAIN_KINDS)[number];

export const BRAIN_EVIDENCE_ZONE = "evidence";

export const BRAIN_STATUS_VALUES = ["draft", "active", "archived", "merged"] as const;

export type BrainStatus = (typeof BRAIN_STATUS_VALUES)[number];

export type BrainRelation = {
  type: string;
  to: string;
};

export type BrainEdgeSourceKind = "relation" | "wiki_link";
export type BrainGraphDirection = "out" | "in" | "both";

export type BrainDerivedEdge = {
  from: string;
  to: string;
  type: string;
  sourceKind: BrainEdgeSourceKind;
};

export type BrainSource = {
  ref: string;
  capturedAt?: string;
  title?: string;
};

export const BRAIN_EVIDENCE_ID_PATTERN = /^ev-[a-z0-9][a-z0-9-]{0,76}$/;

// Source refs are `provider:id` — a lowercase provider slug, a colon, then the
// provider's own identifier (which may itself contain colons or slashes, e.g.
// `jamie:meeting:calendar_event_123`). No whitespace, brackets, or pipes so the
// ref stays inline-link safe.
export const BRAIN_SOURCE_REF_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}:[^\s[\]|]+$/;
export const BRAIN_SOURCE_REF_MAX_LENGTH = 256;

export type ParsedBrainSourceRef = {
  raw: string;
  provider: string;
  id: string;
};

export type BrainFrontmatter = {
  id: string;
  folder: string;
  kind: BrainKind;
  type: BrainEntityType;
  status: BrainStatus;
  createdAt: string;
  updatedAt: string;
  relations: BrainRelation[];
  title?: string;
  description?: string;
  // Workflow docs only: the model/engine mention token the workflow runs on
  // (e.g. "kimi-k2.6", "codex"). Ignored for other document kinds.
  model?: string;
  aliases?: string[];
  sources?: BrainSource[];
  mergedInto?: string;
  legacyKeys?: string[];
};

export type BrainTimelineEntry = {
  evidenceId: string;
  at: string;
  body: string;
};

export type BrainDocument = {
  frontmatter: BrainFrontmatter;
  title: string;
  compiledTruth: string;
  timeline: BrainTimelineEntry[];
};

export function isValidBrainId(value: unknown): value is string {
  return typeof value === "string" && BRAIN_ID_PATTERN.test(value);
}

export function isValidBrainFolder(value: unknown): value is string {
  return typeof value === "string" && BRAIN_FOLDER_PATTERN.test(value);
}

export function isBrainEvidenceFolder(value: string): boolean {
  const normalized = normalizeBrainFolder(value);
  return normalized === BRAIN_EVIDENCE_ZONE || normalized.startsWith(`${BRAIN_EVIDENCE_ZONE}/`);
}

export function isHardDefaultBrainFolder(value: string): boolean {
  const normalized = normalizeBrainFolder(value);
  return HARD_DEFAULT_BRAIN_FOLDERS.includes(normalized as HardDefaultBrainFolder);
}

export function isAdjustableDefaultBrainFolder(value: string): boolean {
  const normalized = normalizeBrainFolder(value);
  return ADJUSTABLE_DEFAULT_BRAIN_FOLDERS.includes(normalized as AdjustableDefaultBrainFolder);
}

export function brainKindForFolder(folder: string): BrainKind {
  return isBrainEvidenceFolder(folder) ? "evidence" : "page";
}

export function isValidBrainRelationType(value: unknown): value is string {
  return typeof value === "string" && BRAIN_RELATION_TYPE_PATTERN.test(value);
}

export function isValidBrainEntityType(value: unknown): value is BrainEntityType {
  return typeof value === "string" && BRAIN_ENTITY_TYPES.includes(value as BrainEntityType);
}

export function isValidBrainKind(value: unknown): value is BrainKind {
  return typeof value === "string" && BRAIN_KINDS.includes(value as BrainKind);
}

export function isValidBrainStatus(value: unknown): value is BrainStatus {
  return typeof value === "string" && BRAIN_STATUS_VALUES.includes(value as BrainStatus);
}

export function isValidBrainEvidenceId(value: unknown): value is string {
  return typeof value === "string" && BRAIN_EVIDENCE_ID_PATTERN.test(value);
}

export function isValidBrainSourceRef(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= BRAIN_SOURCE_REF_MAX_LENGTH &&
    BRAIN_SOURCE_REF_PATTERN.test(value)
  );
}

export function parseBrainSourceRef(value: unknown): ParsedBrainSourceRef | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!isValidBrainSourceRef(raw)) return null;
  const separator = raw.indexOf(":");
  return { raw, provider: raw.slice(0, separator), id: raw.slice(separator + 1) };
}

export function brainRelated(frontmatter: Partial<BrainFrontmatter>): BrainRelation[] {
  return frontmatter.relations ?? [];
}

export function normalizeBrainFolder(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/+/g, "/");
}

export function normalizeBrainId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
}

export function normalizeBrainEntityType(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64)
    .replace(/_+$/g, "");
}
