import {
  extractGoatBrainCitations,
  GOAT_BRAIN_TIMELINE_HEADING,
  GOAT_BRAIN_TRUTH_HEADING,
  type ParsedGoatBrainDocument,
} from "./document";
import {
  isValidGoatBrainEntityType,
  isValidGoatBrainEvidenceId,
  isValidGoatBrainFolder,
  isValidGoatBrainId,
  isValidGoatBrainRelationType,
  isValidGoatBrainStatus,
} from "./schema";
import { goatBrainFolderTypeError } from "./schemas";
import { isIsoDate } from "./time";
import { parseGoatBrainWikiLinks } from "./wiki-links";

export type GoatBrainValidationResult = { ok: true } | { ok: false; errors: string[] };

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
  if (!isValidGoatBrainFolder(fm.folder)) {
    errors.push("frontmatter.folder must be a safe lowercase folder path.");
  }
  if (!isValidGoatBrainEntityType(fm.type)) {
    errors.push("frontmatter.type must be a built-in brain entity type.");
  }
  if (typeof fm.folder === "string" && typeof fm.type === "string") {
    const folderTypeError = goatBrainFolderTypeError(fm.folder, fm.type);
    if (folderTypeError) errors.push(`frontmatter.folder/type mismatch: ${folderTypeError}`);
  }
  if (!isValidGoatBrainStatus(fm.status)) {
    errors.push("frontmatter.status must be draft, active, archived, or merged.");
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
  for (const relation of fm.relations ?? []) {
    if (!isValidGoatBrainRelationType(relation.type)) {
      errors.push(`relation type "${relation.type}" is invalid.`);
    }
    if (!isValidGoatBrainId(relation.to)) {
      errors.push(`relation target "${relation.to}" is invalid.`);
    }
  }
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
  if (fm.status === "active" && hasCompiledTruth(doc.compiledTruth) && citations.length === 0) {
    errors.push("active compiled truth must cite timeline evidence with [^ev:<evidence-id>].");
  }
  for (const citation of citations) {
    if (!evidenceIds.has(citation)) {
      errors.push(`citation "${citation}" does not match a timeline evidence id.`);
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

function hasCompiledTruth(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed !== "_No compiled truth yet._";
}
