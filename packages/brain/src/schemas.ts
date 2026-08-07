import {
  type BrainEntityType,
  type BrainKind,
  GOAT_BRAIN_ENTITY_TYPES,
  GOAT_BRAIN_EVIDENCE_ZONE,
  isBrainEvidenceFolder,
  normalizeBrainEntityType,
  normalizeBrainFolder,
} from "./schema";

const ENTITY_TYPE_SET = new Set<string>(GOAT_BRAIN_ENTITY_TYPES);

// Retired v1 type names normalize to their v2 home so documents materialized
// before migration 0100 keep parsing; the next write rewrites the frontmatter.
const LEGACY_ENTITY_TYPE_ALIASES: Record<string, BrainEntityType> = {
  media: "source",
  email: "source",
  writing: "analysis",
};

export function isBuiltInBrainEntityType(value: unknown): value is BrainEntityType {
  return typeof value === "string" && ENTITY_TYPE_SET.has(value);
}

export function normalizeBuiltInBrainEntityType(value: string | undefined): BrainEntityType | null {
  if (!value) return null;
  const normalized = normalizeBrainEntityType(value);
  if (isBuiltInBrainEntityType(normalized)) return normalized;
  return LEGACY_ENTITY_TYPE_ALIASES[normalized] ?? null;
}

// Types classify documents; folders are free-form human navigation. This map
// is only the opinionated default used when a caller does not pick a folder.
const DEFAULT_FOLDER_BY_ENTITY_TYPE: Record<BrainEntityType, string> = {
  person: "people",
  company: "companies",
  project: "projects",
  meeting: "meetings",
  concept: "concepts",
  source: "research",
  analysis: "research",
  note: "inbox",
};

export function defaultBrainFolder(type: BrainEntityType, kind: BrainKind): string {
  if (kind === "evidence") return GOAT_BRAIN_EVIDENCE_ZONE;
  return DEFAULT_FOLDER_BY_ENTITY_TYPE[type];
}

export function brainFolderKindError(folder: string, kind: BrainKind): string | null {
  const normalizedFolder = normalizeBrainFolder(folder);
  const inZone = isBrainEvidenceFolder(normalizedFolder);
  if (kind === "evidence" && !inZone) {
    return `evidence documents must live under the "${GOAT_BRAIN_EVIDENCE_ZONE}/" zone.`;
  }
  if (kind === "page" && inZone) {
    return `folder "${folder}" is inside the "${GOAT_BRAIN_EVIDENCE_ZONE}/" zone, which is reserved for evidence documents.`;
  }
  return null;
}

export function normalizeBrainFolderForV1(folder: string): string {
  return normalizeBrainFolder(folder);
}
