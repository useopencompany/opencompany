// The canonical memory schema: the frontmatter fields, their enums, and the document types.
// Kept deliberately small and hand-validated (no zod) to match the repo's agent-runtime style.

// Canonical object types — derived, updateable views of a single real-world thing.
export const CANONICAL_TYPES = [
  "person",
  "company",
  "project",
  "customer",
  "decision",
  "concept",
  "theme",
] as const;
export type CanonicalType = (typeof CANONICAL_TYPES)[number];

// Evidence types — immutable source records that canonical truth is compiled from.
export const EVIDENCE_TYPES = ["meeting", "conversation", "doc", "research", "correction"] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export type MemoryType = CanonicalType | EvidenceType;

export const STATUS_VALUES = ["active", "draft", "deprecated", "merged"] as const;
export type MemoryStatus = (typeof STATUS_VALUES)[number];

const CANONICAL_TYPE_SET = new Set<string>(CANONICAL_TYPES);
const EVIDENCE_TYPE_SET = new Set<string>(EVIDENCE_TYPES);
const STATUS_SET = new Set<string>(STATUS_VALUES);

export function isCanonicalType(value: unknown): value is CanonicalType {
  return typeof value === "string" && CANONICAL_TYPE_SET.has(value);
}

export function isEvidenceType(value: unknown): value is EvidenceType {
  return typeof value === "string" && EVIDENCE_TYPE_SET.has(value);
}

export function isMemoryType(value: unknown): value is MemoryType {
  return isCanonicalType(value) || isEvidenceType(value);
}

export function isMemoryStatus(value: unknown): value is MemoryStatus {
  return typeof value === "string" && STATUS_SET.has(value);
}

// A memory id is also the file name (without `.md`). Lowercase slug, globally unique.
export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isValidMemoryId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

// A typed, directional edge from one memory to another. `target` is the id it points at; `type`
// is a freeform lowercase slug (e.g. `inspired_by`, `depends_on`, `employs`). The vocabulary is
// intentionally open — we don't enforce an ontology, only the slug shape — so the agent can coin
// relation kinds as it needs them. One edge per target (the type is replaceable, not multiplied).
export type MemoryRelation = { type: string; target: string };

export const DEFAULT_RELATION_TYPE = "related";
export const RELATION_TYPE_PATTERN = /^[a-z][a-z0-9_]*$/;

export function isValidRelationType(value: unknown): value is string {
  return typeof value === "string" && RELATION_TYPE_PATTERN.test(value);
}

// Provenance for an evidence record. `ref` is a URL/path/opaque identifier pointing at the
// original source; `kind` mirrors the evidence type so a record is self-describing.
export type MemorySource = {
  ref: string;
  capturedAt: string;
  author?: string;
};

// Frontmatter shared by every memory file. Canonical-only and evidence-only fields are
// optional here and enforced per-type by the validators.
export type MemoryFrontmatter = {
  id: string;
  type: MemoryType;
  status: MemoryStatus;
  createdAt: string;
  updatedAt: string;
  related: MemoryRelation[];
  // Canonical only.
  aliases?: string[];
  mergedInto?: string;
  // Evidence only.
  subjects?: string[];
  source?: MemorySource;
};

// A single dated entry in the append-only timeline. `at` is an ISO-8601 UTC timestamp.
export type TimelineEntry = {
  at: string;
  body: string;
};

// A fully parsed memory file: frontmatter plus the two-layer body (compiled truth on top,
// the append-only timeline below the sentinel).
export type MemoryDocument = {
  frontmatter: MemoryFrontmatter;
  title: string;
  compiledTruth: string;
  timeline: TimelineEntry[];
};

export type CanonicalDocument = MemoryDocument & {
  frontmatter: MemoryFrontmatter & { type: CanonicalType };
};

export type EvidenceDocument = MemoryDocument & {
  frontmatter: MemoryFrontmatter & { type: EvidenceType; subjects: string[]; source: MemorySource };
};

export function isCanonicalDocument(doc: MemoryDocument): doc is CanonicalDocument {
  return isCanonicalType(doc.frontmatter.type);
}

export function isEvidenceDocument(doc: MemoryDocument): doc is EvidenceDocument {
  return isEvidenceType(doc.frontmatter.type);
}
