import {
  GOAT_BRAIN_ENTITY_TYPES,
  GOAT_BRAIN_EVIDENCE_ZONE,
  type GoatBrainEntityType,
  type GoatBrainKind,
  isGoatBrainEvidenceFolder,
  normalizeGoatBrainEntityType,
  normalizeGoatBrainFolder,
} from "./schema";

const ENTITY_TYPE_SET = new Set<string>(GOAT_BRAIN_ENTITY_TYPES);

export function isBuiltInGoatBrainEntityType(value: unknown): value is GoatBrainEntityType {
  return typeof value === "string" && ENTITY_TYPE_SET.has(value);
}

export function normalizeBuiltInGoatBrainEntityType(
  value: string | undefined,
): GoatBrainEntityType | null {
  if (!value) return null;
  const normalized = normalizeGoatBrainEntityType(value);
  return isBuiltInGoatBrainEntityType(normalized) ? normalized : null;
}

// Types are frontmatter tags; folders are free-form human navigation. This map
// is only the opinionated default used when a caller does not pick a folder.
const DEFAULT_FOLDER_BY_ENTITY_TYPE: Record<GoatBrainEntityType, string> = {
  person: "people",
  company: "companies",
  project: "projects",
  media: "media",
  analysis: "analysis",
  concept: "concepts",
  email: "emails",
  writing: "writing",
  note: "inbox",
  source: "sources",
};

export function defaultGoatBrainFolder(type: GoatBrainEntityType, kind: GoatBrainKind): string {
  if (kind === "evidence") return GOAT_BRAIN_EVIDENCE_ZONE;
  return DEFAULT_FOLDER_BY_ENTITY_TYPE[type];
}

export function goatBrainFolderKindError(folder: string, kind: GoatBrainKind): string | null {
  const normalizedFolder = normalizeGoatBrainFolder(folder);
  const inZone = isGoatBrainEvidenceFolder(normalizedFolder);
  if (kind === "evidence" && !inZone) {
    return `evidence documents must live under the "${GOAT_BRAIN_EVIDENCE_ZONE}/" zone.`;
  }
  if (kind === "page" && inZone) {
    return `folder "${folder}" is inside the "${GOAT_BRAIN_EVIDENCE_ZONE}/" zone, which is reserved for evidence documents.`;
  }
  return null;
}

export function normalizeGoatBrainFolderForV1(folder: string): string {
  return normalizeGoatBrainFolder(folder);
}
