import {
  extractGoatBrainCitations,
  GOAT_BRAIN_TIMELINE_HEADING,
  GOAT_BRAIN_TRUTH_HEADING,
  type ParsedGoatBrainDocument,
} from "./document";
import {
  isValidGoatBrainEntityType,
  isValidGoatBrainEvidenceId,
  isValidGoatBrainEvidenceKind,
  isValidGoatBrainFolder,
  isValidGoatBrainId,
  isValidGoatBrainRelationType,
  isValidGoatBrainStatus,
} from "./schema";
import { goatBrainFolderTypeError } from "./schemas";
import { isIsoDate } from "./time";
import { parseGoatBrainWikiLinks } from "./wiki-links";

export type GoatBrainValidationResult = { ok: true } | { ok: false; errors: string[] };
export type GoatBrainValidationSubject = "frontmatter" | "sidecar";

export function validateGoatBrainFolderType(input: {
  folder: unknown;
  type: unknown;
  subject: GoatBrainValidationSubject;
}): string[] {
  const errors: string[] = [];
  if (!isValidGoatBrainFolder(input.folder)) {
    errors.push(`${input.subject}.folder must be a safe lowercase folder path.`);
  }
  if (!isValidGoatBrainEntityType(input.type)) {
    errors.push(
      input.subject === "frontmatter"
        ? "frontmatter.type must be a built-in brain entity type."
        : "sidecar.type is invalid.",
    );
  }
  if (typeof input.folder === "string" && typeof input.type === "string") {
    const folderTypeError = goatBrainFolderTypeError(input.folder, input.type);
    if (folderTypeError) errors.push(`${input.subject}.folder/type mismatch: ${folderTypeError}`);
  }
  return errors;
}

export function validateGoatBrainRelations(
  relations: unknown,
  options: { fieldName: string } = { fieldName: "relations" },
): string[] {
  if (relations === undefined) return [];
  if (!Array.isArray(relations)) return [`${options.fieldName} must be an array.`];
  const errors: string[] = [];
  for (const relation of relations) {
    if (!isRecord(relation)) {
      errors.push("relation must have type and to fields.");
      continue;
    }
    if (!isValidGoatBrainRelationType(relation.type)) {
      errors.push(`relation type "${String(relation.type)}" is invalid.`);
    }
    if (!isValidGoatBrainId(relation.to)) {
      errors.push(`relation target "${String(relation.to)}" is invalid.`);
    }
  }
  return errors;
}

export function validateGoatBrainDocument(
  doc: ParsedGoatBrainDocument,
  expectedId?: string,
  source = "",
): GoatBrainValidationResult {
  const errors: string[] = [];
  const fm = doc.frontmatter;
  if (!isValidGoatBrainId(fm.id)) errors.push("frontmatter.id must be a lowercase slug.");
  if (expectedId && fm.id && fm.id !== expectedId) {
    errors.push(`frontmatter.id "${fm.id}" does not match file id "${expectedId}".`);
  }
  errors.push(
    ...validateGoatBrainFolderType({ folder: fm.folder, type: fm.type, subject: "frontmatter" }),
  );
  if (!isValidGoatBrainStatus(fm.status)) {
    errors.push("frontmatter.status must be draft, active, archived, or merged.");
  }
  if (fm.type === "evidence") {
    if (!isValidGoatBrainEvidenceKind(fm.evidenceKind)) {
      errors.push("frontmatter.evidenceKind must be chat, email, correction, or document.");
    } else if (typeof fm.folder === "string") {
      const folderKind = fm.folder.split("/")[1];
      if (folderKind !== fm.evidenceKind) {
        errors.push("frontmatter.evidenceKind must match the evidence folder subtype.");
      }
    }
  } else if (fm.evidenceKind !== undefined) {
    errors.push("frontmatter.evidenceKind is only valid for evidence records.");
  }
  if (!fm.createdAt || !isIsoDate(fm.createdAt)) {
    errors.push("frontmatter.created_at must be an ISO-8601 UTC timestamp.");
  }
  if (!fm.updatedAt || !isIsoDate(fm.updatedAt)) {
    errors.push("frontmatter.updated_at must be an ISO-8601 UTC timestamp.");
  }
  for (const legacyKey of fm.legacyKeys ?? []) {
    errors.push(`frontmatter.${legacyKey} is not supported by the v2 brain contract.`);
  }
  errors.push(
    ...validateGoatBrainRelations(fm.relations ?? [], { fieldName: "frontmatter.relations" }),
  );
  if (fm.mergedInto && !isValidGoatBrainId(fm.mergedInto)) {
    errors.push(`mergedInto target "${fm.mergedInto}" is invalid.`);
  }
  for (const alias of fm.aliases ?? []) {
    if (!alias.trim()) errors.push("aliases must not contain empty values.");
  }
  for (const tag of fm.tags ?? []) {
    if (!tag.trim()) errors.push("tags must not contain empty values.");
  }
  for (const sourceEntry of fm.sources ?? []) {
    if (!sourceEntry.ref.trim()) errors.push("sources.ref must not be empty.");
    if (sourceEntry.capturedAt && !isIsoDate(sourceEntry.capturedAt)) {
      errors.push(`source captured_at "${sourceEntry.capturedAt}" must be ISO-8601 UTC.`);
    }
  }
  if (!doc.title.trim()) errors.push("document must have a # title.");
  if (
    source &&
    (!source.includes(GOAT_BRAIN_TRUTH_HEADING) || !source.includes(GOAT_BRAIN_TIMELINE_HEADING))
  ) {
    errors.push("document must include ## Compiled truth and ## Timeline sections.");
  }
  for (const link of parseGoatBrainWikiLinks(doc.compiledTruth)) {
    if (!link.valid) errors.push(`wiki link target "${link.target}" is invalid.`);
  }
  const evidenceIds = new Set<string>();
  for (const entry of doc.timeline) {
    if (!isValidGoatBrainEvidenceId(entry.evidenceId)) {
      errors.push(`timeline evidence id "${entry.evidenceId}" is invalid.`);
    } else if (evidenceIds.has(entry.evidenceId)) {
      errors.push(`timeline evidence id "${entry.evidenceId}" is duplicated.`);
    } else {
      evidenceIds.add(entry.evidenceId);
    }
    if (!isIsoDate(entry.at)) {
      errors.push(`timeline entry "${entry.evidenceId}" timestamp must be ISO-8601 UTC.`);
    }
  }
  const citations = extractGoatBrainCitations(doc.compiledTruth);
  if (
    fm.status === "active" &&
    fm.type !== "evidence" &&
    hasCompiledTruth(doc.compiledTruth) &&
    citations.length === 0
  ) {
    errors.push("active compiled truth must cite evidence with [^ev:<evidence-id>].");
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

function hasCompiledTruth(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed !== "_No compiled truth yet._";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
