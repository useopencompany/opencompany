import {
  GOAT_BRAIN_ENTITY_TYPES,
  type GoatBrainEntityType,
  isValidGoatBrainEvidenceKind,
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

export type GoatBrainSchemaPack = {
  apiVersion: "goat-brain-schema-pack-v1";
  name: "goat-default";
  version: "0.1.0";
  types: Array<{
    name: GoatBrainEntityType;
    primitive: "entity" | "artifact" | "temporal" | "decision" | "concept" | "note";
    pathPrefixes: string[];
    extractable: boolean;
    expertRouting: boolean;
  }>;
  relations: string[];
};

export const GOAT_DEFAULT_SCHEMA_PACK: GoatBrainSchemaPack = {
  apiVersion: "goat-brain-schema-pack-v1",
  name: "goat-default",
  version: "0.1.0",
  types: [
    {
      name: "person",
      primitive: "entity",
      pathPrefixes: ["people"],
      extractable: true,
      expertRouting: true,
    },
    {
      name: "company",
      primitive: "entity",
      pathPrefixes: ["companies"],
      extractable: true,
      expertRouting: true,
    },
    {
      name: "project",
      primitive: "entity",
      pathPrefixes: ["projects"],
      extractable: true,
      expertRouting: true,
    },
    {
      name: "decision",
      primitive: "decision",
      pathPrefixes: ["decisions"],
      extractable: true,
      expertRouting: true,
    },
    {
      name: "meeting",
      primitive: "temporal",
      pathPrefixes: ["meetings"],
      extractable: true,
      expertRouting: false,
    },
    {
      name: "research",
      primitive: "artifact",
      pathPrefixes: ["research"],
      extractable: true,
      expertRouting: false,
    },
    {
      name: "concept",
      primitive: "concept",
      pathPrefixes: ["concepts"],
      extractable: true,
      expertRouting: true,
    },
    {
      name: "evidence",
      primitive: "artifact",
      pathPrefixes: ["evidence"],
      extractable: true,
      expertRouting: false,
    },
    {
      name: "note",
      primitive: "note",
      pathPrefixes: ["inbox"],
      extractable: false,
      expertRouting: false,
    },
  ],
  relations: [
    "mentions",
    "about",
    "cites",
    "works_at",
    "founded",
    "invested_in",
    "advises",
    "attended",
    "evidenced_by",
    "supports",
    "owns",
    "depends_on",
    "decided_by",
    "supersedes",
    "merged_into",
    "related",
  ],
};

export function goatBrainFolderForEntityType(type: string | undefined): string {
  const normalized = normalizeBuiltInGoatBrainEntityType(type);
  if (normalized === "evidence") return "evidence/chat";
  return (
    GOAT_DEFAULT_SCHEMA_PACK.types.find((entry) => entry.name === normalized)?.pathPrefixes[0] ??
    "inbox"
  );
}

export function goatBrainEntityTypeForFolder(folder: string): GoatBrainEntityType | null {
  return lookupGoatBrainEntityTypeForFolder(folder);
}

export function goatBrainFolderMatchesEntityType(folder: string, type: string): boolean {
  const normalized = normalizeBuiltInGoatBrainEntityType(type);
  if (!normalized) return false;
  return goatBrainEntityTypeForFolder(folder) === normalized;
}

export function goatBrainFolderTypeError(folder: string, type: string): string | null {
  const normalized = normalizeBuiltInGoatBrainEntityType(type);
  if (!normalized) return `type "${type}" is not a built-in brain entity type.`;
  const normalizedFolder = normalizeGoatBrainFolder(folder);
  const actual = goatBrainEntityTypeForFolder(normalizedFolder);
  if (!actual) {
    return `folder "${folder}" must be under a known type folder: ${GOAT_DEFAULT_SCHEMA_PACK.types
      .map((entry) => entry.pathPrefixes[0])
      .join(", ")}.`;
  }
  if (actual !== normalized) {
    return `folder "${folder}" maps to type "${actual}", not "${normalized}".`;
  }
  if (normalized === "evidence") {
    const subtype = normalizedFolder.split("/")[1];
    if (!isValidGoatBrainEvidenceKind(subtype)) {
      return 'evidence records must be under "evidence/chat", "evidence/email", "evidence/correction", or "evidence/document".';
    }
  }
  return null;
}

export function inferGoatBrainEntityTypeFromFolder(folder: string): GoatBrainEntityType {
  return lookupGoatBrainEntityTypeForFolder(folder) ?? "note";
}

function lookupGoatBrainEntityTypeForFolder(folder: string): GoatBrainEntityType | null {
  const rootFolder = normalizeGoatBrainFolder(folder).split("/")[0] ?? "";
  for (const entry of GOAT_DEFAULT_SCHEMA_PACK.types) {
    if (entry.pathPrefixes.includes(rootFolder)) return entry.name;
  }
  return null;
}

export function normalizeGoatBrainFolderForV1(folder: string): string {
  return normalizeGoatBrainFolder(folder);
}
