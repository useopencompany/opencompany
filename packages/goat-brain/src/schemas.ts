import {
  GOAT_BRAIN_ENTITY_TYPES,
  type GoatBrainEntityType,
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
  if (normalized === "source") return "reference";
  if (normalized === "doc") return "document";
  if (normalized === "insight" || normalized === "idea" || normalized === "theme") return "concept";
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
      name: "conversation",
      primitive: "temporal",
      pathPrefixes: ["conversations"],
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
      name: "document",
      primitive: "artifact",
      pathPrefixes: ["docs"],
      extractable: true,
      expertRouting: false,
    },
    {
      name: "concept",
      primitive: "concept",
      pathPrefixes: ["concepts", "ideas", "insights"],
      extractable: true,
      expertRouting: true,
    },
    {
      name: "reference",
      primitive: "artifact",
      pathPrefixes: ["references", "sources"],
      extractable: true,
      expertRouting: false,
    },
    {
      name: "daily",
      primitive: "temporal",
      pathPrefixes: ["daily"],
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
  return (
    GOAT_DEFAULT_SCHEMA_PACK.types.find((entry) => entry.name === normalized)?.pathPrefixes[0] ??
    "inbox"
  );
}

export function inferGoatBrainEntityTypeFromFolder(folder: string): GoatBrainEntityType {
  const rootFolder = normalizeGoatBrainFolder(folder).split("/")[0] ?? "";
  for (const entry of GOAT_DEFAULT_SCHEMA_PACK.types) {
    if (entry.pathPrefixes.includes(rootFolder)) return entry.name;
  }
  return "note";
}

export function normalizeGoatBrainFolderForV1(folder: string): string {
  const normalized = normalizeGoatBrainFolder(folder);
  const [root, ...rest] = normalized.split("/");
  const replacement =
    root === "ideas" || root === "insights" ? "concepts" : root === "sources" ? "references" : root;
  return [replacement, ...rest].filter(Boolean).join("/");
}
