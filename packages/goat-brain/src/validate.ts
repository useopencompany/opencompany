import {
  GOAT_BRAIN_TIMELINE_HEADING,
  GOAT_BRAIN_TRUTH_HEADING,
  type ParsedGoatBrainDocument,
} from "./document";
import { isValidGoatBrainFolder, isValidGoatBrainId, isValidGoatBrainRelationType } from "./schema";
import { isIsoDate } from "./time";

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
  if (!fm.createdAt || !isIsoDate(fm.createdAt)) {
    errors.push("frontmatter.created_at must be an ISO-8601 UTC timestamp.");
  }
  if (!fm.updatedAt || !isIsoDate(fm.updatedAt)) {
    errors.push("frontmatter.updated_at must be an ISO-8601 UTC timestamp.");
  }
  for (const relation of fm.related ?? []) {
    if (!isValidGoatBrainRelationType(relation.type)) {
      errors.push(`related relation type "${relation.type}" is invalid.`);
    }
    if (!isValidGoatBrainId(relation.target)) {
      errors.push(`related target "${relation.target}" is invalid.`);
    }
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
  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}
