import type { ParsedDocument } from "./document";
import {
  isEvidenceType,
  isMemoryStatus,
  isMemoryType,
  isValidMemoryId,
  isValidRelationType,
  type MemoryDocument,
  type MemoryFrontmatter,
} from "./schema";

export type ValidationResult = { ok: true; doc: MemoryDocument } | { ok: false; errors: string[] };

// An ISO-8601 UTC timestamp with seconds, e.g. 2026-06-06T14:32:00Z. The CLI always stamps
// this format; we reject anything that doesn't parse to a real date.
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && ISO_RE.test(value) && !Number.isNaN(Date.parse(value));
}

// Strict validation of a leniently-parsed document. `expectedId` (the file name without `.md`)
// is checked against the frontmatter id so the id==filename invariant is caught at load time.
export function validateDocument(parsed: ParsedDocument, expectedId?: string): ValidationResult {
  const errors: string[] = [];
  const fm = parsed.frontmatter;

  if (!isValidMemoryId(fm.id)) {
    errors.push("`id` is required and must be a lowercase slug (a-z, 0-9, hyphen).");
  } else if (expectedId !== undefined && fm.id !== expectedId) {
    errors.push(`\`id\` (${fm.id}) must equal the file name (${expectedId}).`);
  }

  if (!isMemoryType(fm.type)) {
    errors.push("`type` is required and must be a known canonical or evidence type.");
  }
  if (!isMemoryStatus(fm.status)) {
    errors.push("`status` is required and must be active, deprecated, or merged.");
  }
  if (!isIsoTimestamp(fm.createdAt)) {
    errors.push("`created_at` is required and must be an ISO-8601 UTC timestamp.");
  }
  if (!isIsoTimestamp(fm.updatedAt)) {
    errors.push("`updated_at` is required and must be an ISO-8601 UTC timestamp.");
  }

  const isEvidence = isEvidenceType(fm.type);

  if (isEvidence) {
    if (!fm.subjects || fm.subjects.length === 0) {
      errors.push("Evidence records require at least one `subjects` entry (a canonical id).");
    } else if (!fm.subjects.every(isValidMemoryId)) {
      errors.push("Every `subjects` entry must be a valid memory id.");
    }
    if (!fm.source) {
      errors.push("Evidence records require a `source` (provenance).");
    } else {
      if (!fm.source.ref) errors.push("`source.ref` is required for evidence records.");
      if (!isIsoTimestamp(fm.source.capturedAt)) {
        errors.push("`source.captured_at` must be an ISO-8601 UTC timestamp.");
      }
    }
  } else {
    if (fm.subjects && fm.subjects.length > 0) {
      errors.push("`subjects` is only valid on evidence records.");
    }
    if (fm.source) {
      errors.push("`source` is only valid on evidence records.");
    }
  }

  if (fm.mergedInto && fm.status !== "merged") {
    errors.push("`merged_into` is only valid when status is merged.");
  }
  if (fm.status === "merged" && !fm.mergedInto) {
    errors.push("A merged record must set `merged_into` to its target id.");
  }
  if (
    fm.related &&
    !fm.related.every((rel) => isValidMemoryId(rel.target) && isValidRelationType(rel.type))
  ) {
    errors.push(
      "Every `related` entry needs a valid `target` id and a lowercase `type` slug (a-z, 0-9, _).",
    );
  }

  if (errors.length > 0) return { ok: false, errors };

  // All fields validated above; assemble the strongly-typed frontmatter.
  const frontmatter: MemoryFrontmatter = {
    id: fm.id as string,
    type: fm.type as MemoryFrontmatter["type"],
    status: fm.status as MemoryFrontmatter["status"],
    createdAt: fm.createdAt as string,
    updatedAt: fm.updatedAt as string,
    related: fm.related ?? [],
    ...(fm.aliases && fm.aliases.length > 0 ? { aliases: fm.aliases } : {}),
    ...(fm.mergedInto ? { mergedInto: fm.mergedInto } : {}),
    ...(fm.subjects && fm.subjects.length > 0 ? { subjects: fm.subjects } : {}),
    ...(fm.source ? { source: fm.source } : {}),
  };

  return {
    ok: true,
    doc: {
      frontmatter,
      title: parsed.title,
      compiledTruth: parsed.compiledTruth,
      timeline: parsed.timeline,
    },
  };
}
