import {
  type CanonicalType,
  type EvidenceType,
  isCanonicalType,
  isEvidenceType,
  type MemoryType,
} from "./schema";

// The opinionated, fixed folder taxonomy. A file's folder is derived from its `type`, so
// location and type can never silently disagree (doctor enforces the round-trip).
const CANONICAL_FOLDER: Record<CanonicalType, string> = {
  person: "people",
  company: "companies",
  project: "projects",
  customer: "customers",
  decision: "decisions",
  concept: "concepts",
  theme: "themes",
};

const EVIDENCE_FOLDER: Record<EvidenceType, string> = {
  meeting: "evidence/meetings",
  conversation: "evidence/conversations",
  doc: "evidence/docs",
  research: "evidence/research",
  correction: "evidence/corrections",
};

// Every folder in the tree, relative to the memory root. Used by `init`/seeding and doctor.
export const ALL_FOLDERS: string[] = [
  ...Object.values(CANONICAL_FOLDER),
  ...Object.values(EVIDENCE_FOLDER),
];

export function folderForType(type: MemoryType): string {
  if (isCanonicalType(type)) return CANONICAL_FOLDER[type];
  return EVIDENCE_FOLDER[type];
}

// The path of a memory file relative to the memory root, e.g. `companies/acme.md`.
export function relativePathForType(type: MemoryType, id: string): string {
  return `${folderForType(type)}/${id}.md`;
}

// Map a folder (relative to the memory root) back to the type it must hold. Returns null for
// a folder outside the taxonomy. Used by doctor to detect type/folder mismatches.
const FOLDER_TO_TYPE = new Map<string, MemoryType>([
  ...Object.entries(CANONICAL_FOLDER).map(
    ([type, folder]) => [folder, type as MemoryType] as const,
  ),
  ...Object.entries(EVIDENCE_FOLDER).map(([type, folder]) => [folder, type as MemoryType] as const),
]);

export function typeForFolder(folder: string): MemoryType | null {
  return FOLDER_TO_TYPE.get(folder) ?? null;
}

// Extract the `{id}` from a memory-root-relative path like `companies/acme.md`. Returns null
// when the path is not a markdown file directly inside a known folder.
export function idFromRelativePath(relativePath: string): string | null {
  const match = /^(.+)\/([^/]+)\.md$/.exec(relativePath);
  if (!match) return null;
  const [, folder, id] = match;
  if (!folder || !id || !FOLDER_TO_TYPE.has(folder)) return null;
  return id;
}

// Reject anything that could escape the memory root or hide a file from bundle sync (which
// drops dotfiles). Mirrors the runner's path normalization posture.
export function isSafeRelativePath(relativePath: string): boolean {
  if (!relativePath || relativePath.startsWith("/")) return false;
  const parts = relativePath.split("/");
  return parts.every(
    (part) => part.length > 0 && part !== "." && part !== ".." && !part.startsWith("."),
  );
}

export { isCanonicalType, isEvidenceType };
