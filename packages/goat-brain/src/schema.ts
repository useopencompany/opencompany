export const HARD_DEFAULT_GOAT_BRAIN_FOLDERS = [
  "inbox",
  "people",
  "companies",
  "evidence",
] as const;

export const ADJUSTABLE_DEFAULT_GOAT_BRAIN_FOLDERS = [
  "thoughts",
  "projects",
  "meetings",
  "research",
  "decisions",
  "concepts",
] as const;

export const DEFAULT_GOAT_BRAIN_FOLDERS = [
  "inbox",
  ...ADJUSTABLE_DEFAULT_GOAT_BRAIN_FOLDERS,
  "people",
  "companies",
  "evidence",
] as const;

export const GOAT_BRAIN_MIDDLE_FOLDER_ORDER = ADJUSTABLE_DEFAULT_GOAT_BRAIN_FOLDERS;

export type GoatBrainDefaultFolder = (typeof DEFAULT_GOAT_BRAIN_FOLDERS)[number];
export type HardDefaultGoatBrainFolder = (typeof HARD_DEFAULT_GOAT_BRAIN_FOLDERS)[number];
export type AdjustableDefaultGoatBrainFolder =
  (typeof ADJUSTABLE_DEFAULT_GOAT_BRAIN_FOLDERS)[number];
export type GoatBrainDocumentFormat = "markdown" | "pdf" | "docx";

export const GOAT_BRAIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;
export const GOAT_BRAIN_FOLDER_PATTERN = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*){0,5}$/;
export const GOAT_BRAIN_RELATION_TYPE_PATTERN = /^[a-z][a-z0-9_]*$/;
export const GOAT_BRAIN_ENTITY_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
export const DEFAULT_GOAT_BRAIN_RELATION_TYPE = "related";

// One question decides the type: what does this record represent?
// External artifacts of any format (articles, videos, email threads, repos)
// are `source` — the source ref's provider already carries the format nuance.
// Synthesized prose (research reports, drafts) is `analysis`.
export const GOAT_BRAIN_ENTITY_TYPES = [
  "person",
  "company",
  "project",
  "meeting",
  "concept",
  "source",
  "analysis",
  "note",
] as const;

export type GoatBrainEntityType = (typeof GOAT_BRAIN_ENTITY_TYPES)[number];

export const GOAT_BRAIN_KINDS = ["page", "evidence"] as const;

export type GoatBrainKind = (typeof GOAT_BRAIN_KINDS)[number];

export const GOAT_BRAIN_EVIDENCE_ZONE = "evidence";

export const GOAT_BRAIN_STATUS_VALUES = ["draft", "active", "archived", "merged"] as const;

export type GoatBrainStatus = (typeof GOAT_BRAIN_STATUS_VALUES)[number];

export type GoatBrainRelation = {
  type: string;
  to: string;
};

export type GoatBrainEdgeSourceKind = "relation" | "wiki_link";
export type GoatBrainGraphDirection = "out" | "in" | "both";

export type GoatBrainDerivedEdge = {
  from: string;
  to: string;
  type: string;
  sourceKind: GoatBrainEdgeSourceKind;
};

export type GoatBrainSource = {
  ref: string;
  capturedAt?: string;
  title?: string;
};

export const GOAT_BRAIN_EVIDENCE_ID_PATTERN = /^ev-[a-z0-9][a-z0-9-]{0,76}$/;

// Source refs are `provider:id` — a lowercase provider slug, a colon, then the
// provider's own identifier (which may itself contain colons or slashes, e.g.
// `jamie:meeting:calendar_event_123`). No whitespace, brackets, or pipes so the
// ref stays inline-link safe.
export const GOAT_BRAIN_SOURCE_REF_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}:[^\s[\]|]+$/;
export const GOAT_BRAIN_SOURCE_REF_MAX_LENGTH = 256;

export type ParsedGoatBrainSourceRef = {
  raw: string;
  provider: string;
  id: string;
};

export type GoatBrainFrontmatter = {
  id: string;
  folder: string;
  kind: GoatBrainKind;
  type: GoatBrainEntityType;
  status: GoatBrainStatus;
  createdAt: string;
  updatedAt: string;
  relations: GoatBrainRelation[];
  title?: string;
  aliases?: string[];
  sources?: GoatBrainSource[];
  mergedInto?: string;
  legacyKeys?: string[];
};

export type GoatBrainTimelineEntry = {
  evidenceId: string;
  at: string;
  body: string;
};

export type GoatBrainDocument = {
  frontmatter: GoatBrainFrontmatter;
  title: string;
  compiledTruth: string;
  timeline: GoatBrainTimelineEntry[];
};

export function isValidGoatBrainId(value: unknown): value is string {
  return typeof value === "string" && GOAT_BRAIN_ID_PATTERN.test(value);
}

export function isValidGoatBrainFolder(value: unknown): value is string {
  return typeof value === "string" && GOAT_BRAIN_FOLDER_PATTERN.test(value);
}

export function isGoatBrainEvidenceFolder(value: string): boolean {
  const normalized = normalizeGoatBrainFolder(value);
  return (
    normalized === GOAT_BRAIN_EVIDENCE_ZONE || normalized.startsWith(`${GOAT_BRAIN_EVIDENCE_ZONE}/`)
  );
}

export function isHardDefaultGoatBrainFolder(value: string): boolean {
  const normalized = normalizeGoatBrainFolder(value);
  return HARD_DEFAULT_GOAT_BRAIN_FOLDERS.includes(normalized as HardDefaultGoatBrainFolder);
}

export function isAdjustableDefaultGoatBrainFolder(value: string): boolean {
  const normalized = normalizeGoatBrainFolder(value);
  return ADJUSTABLE_DEFAULT_GOAT_BRAIN_FOLDERS.includes(
    normalized as AdjustableDefaultGoatBrainFolder,
  );
}

export function goatBrainKindForFolder(folder: string): GoatBrainKind {
  return isGoatBrainEvidenceFolder(folder) ? "evidence" : "page";
}

export function isValidGoatBrainRelationType(value: unknown): value is string {
  return typeof value === "string" && GOAT_BRAIN_RELATION_TYPE_PATTERN.test(value);
}

export function isValidGoatBrainEntityType(value: unknown): value is GoatBrainEntityType {
  return (
    typeof value === "string" && GOAT_BRAIN_ENTITY_TYPES.includes(value as GoatBrainEntityType)
  );
}

export function isValidGoatBrainKind(value: unknown): value is GoatBrainKind {
  return typeof value === "string" && GOAT_BRAIN_KINDS.includes(value as GoatBrainKind);
}

export function isValidGoatBrainStatus(value: unknown): value is GoatBrainStatus {
  return typeof value === "string" && GOAT_BRAIN_STATUS_VALUES.includes(value as GoatBrainStatus);
}

export function isValidGoatBrainEvidenceId(value: unknown): value is string {
  return typeof value === "string" && GOAT_BRAIN_EVIDENCE_ID_PATTERN.test(value);
}

export function isValidGoatBrainSourceRef(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= GOAT_BRAIN_SOURCE_REF_MAX_LENGTH &&
    GOAT_BRAIN_SOURCE_REF_PATTERN.test(value)
  );
}

export function parseGoatBrainSourceRef(value: unknown): ParsedGoatBrainSourceRef | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!isValidGoatBrainSourceRef(raw)) return null;
  const separator = raw.indexOf(":");
  return { raw, provider: raw.slice(0, separator), id: raw.slice(separator + 1) };
}

export function goatBrainRelated(frontmatter: Partial<GoatBrainFrontmatter>): GoatBrainRelation[] {
  return frontmatter.relations ?? [];
}

export function normalizeGoatBrainFolder(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/+/g, "/");
}

export function normalizeGoatBrainId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
}

export function normalizeGoatBrainEntityType(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64)
    .replace(/_+$/g, "");
}
