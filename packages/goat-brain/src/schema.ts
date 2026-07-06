export const DEFAULT_GOAT_BRAIN_FOLDERS = [
  "inbox",
  "people",
  "companies",
  "projects",
  "decisions",
  "meetings",
  "research",
  "concepts",
  "evidence",
  "evidence/chat",
  "evidence/email",
  "evidence/correction",
  "evidence/document",
] as const;

export type GoatBrainDefaultFolder = (typeof DEFAULT_GOAT_BRAIN_FOLDERS)[number];
export type GoatBrainDocumentKind = "markdown" | "pdf" | "docx";

export const GOAT_BRAIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;
export const GOAT_BRAIN_FOLDER_PATTERN = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*){0,5}$/;
export const GOAT_BRAIN_RELATION_TYPE_PATTERN = /^[a-z][a-z0-9_]*$/;
export const GOAT_BRAIN_ENTITY_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
export const DEFAULT_GOAT_BRAIN_RELATION_TYPE = "related";

export const GOAT_BRAIN_ENTITY_TYPES = [
  "person",
  "company",
  "project",
  "decision",
  "meeting",
  "research",
  "concept",
  "evidence",
  "note",
] as const;

export type GoatBrainEntityType = (typeof GOAT_BRAIN_ENTITY_TYPES)[number];

export const GOAT_BRAIN_EVIDENCE_KINDS = ["chat", "email", "correction", "document"] as const;

export type GoatBrainEvidenceKind = (typeof GOAT_BRAIN_EVIDENCE_KINDS)[number];

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

export type GoatBrainFrontmatter = {
  id: string;
  folder: string;
  type: GoatBrainEntityType;
  status: GoatBrainStatus;
  createdAt: string;
  updatedAt: string;
  relations: GoatBrainRelation[];
  evidenceKind?: GoatBrainEvidenceKind;
  title?: string;
  aliases?: string[];
  tags?: string[];
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

export function isValidGoatBrainRelationType(value: unknown): value is string {
  return typeof value === "string" && GOAT_BRAIN_RELATION_TYPE_PATTERN.test(value);
}

export function isValidGoatBrainEntityType(value: unknown): value is GoatBrainEntityType {
  return (
    typeof value === "string" && GOAT_BRAIN_ENTITY_TYPES.includes(value as GoatBrainEntityType)
  );
}

export function isValidGoatBrainEvidenceKind(value: unknown): value is GoatBrainEvidenceKind {
  return (
    typeof value === "string" && GOAT_BRAIN_EVIDENCE_KINDS.includes(value as GoatBrainEvidenceKind)
  );
}

export function isValidGoatBrainStatus(value: unknown): value is GoatBrainStatus {
  return typeof value === "string" && GOAT_BRAIN_STATUS_VALUES.includes(value as GoatBrainStatus);
}

export function isValidGoatBrainEvidenceId(value: unknown): value is string {
  return typeof value === "string" && GOAT_BRAIN_EVIDENCE_ID_PATTERN.test(value);
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
