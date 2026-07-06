export const DEFAULT_GOAT_BRAIN_FOLDERS = [
  "inbox",
  "decisions",
  "insights",
  "meetings",
  "companies",
  "people",
  "projects",
  "research",
  "references",
  "docs",
  "ideas",
  "concepts",
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
  "meeting",
  "decision",
  "research",
  "source",
  "note",
] as const;

export type GoatBrainEntityType = (typeof GOAT_BRAIN_ENTITY_TYPES)[number];

export type GoatBrainRelation = {
  type: string;
  to: string;
};

export type GoatBrainSource = {
  ref: string;
  capturedAt?: string;
  title?: string;
};

export type GoatBrainFrontmatter = {
  id: string;
  folder: string;
  type: GoatBrainEntityType;
  createdAt: string;
  updatedAt: string;
  relations: GoatBrainRelation[];
  title?: string;
  aliases?: string[];
  tags?: string[];
  sources?: GoatBrainSource[];
  legacyKeys?: string[];
};

export type GoatBrainTimelineEntry = {
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
