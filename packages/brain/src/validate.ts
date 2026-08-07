import {
  extractBrainCitations,
  GOAT_BRAIN_TIMELINE_HEADING,
  GOAT_BRAIN_TRUTH_HEADING,
  type ParsedBrainDocument,
} from "./document";
import { parseBrainInlineLinks, sourceLinkTargets } from "./inline-links";
import {
  isValidBrainEntityType,
  isValidBrainEvidenceId,
  isValidBrainFolder,
  isValidBrainId,
  isValidBrainKind,
  isValidBrainRelationType,
  isValidBrainStatus,
} from "./schema";
import { brainFolderKindError } from "./schemas";
import { isIsoDate } from "./time";

export type BrainValidationResult = { ok: true } | { ok: false; errors: string[] };
export type BrainValidationSubject = "frontmatter" | "sidecar";

export function validateBrainFolderKindType(input: {
  folder: unknown;
  kind: unknown;
  type: unknown;
  subject: BrainValidationSubject;
}): string[] {
  const errors: string[] = [];
  if (!isValidBrainFolder(input.folder)) {
    errors.push(`${input.subject}.folder must be a safe lowercase folder path.`);
  }
  if (!isValidBrainEntityType(input.type)) {
    errors.push(
      input.subject === "frontmatter"
        ? "frontmatter.type must be a built-in brain entity type."
        : "sidecar.type is invalid.",
    );
  }
  if (!isValidBrainKind(input.kind)) {
    errors.push(`${input.subject}.kind must be "page" or "evidence".`);
  }
  if (isValidBrainFolder(input.folder) && isValidBrainKind(input.kind)) {
    const folderKindError = brainFolderKindError(input.folder, input.kind);
    if (folderKindError) errors.push(`${input.subject}.folder/kind mismatch: ${folderKindError}`);
  }
  return errors;
}

export function validateBrainRelations(
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
    if (!isValidBrainRelationType(relation.type)) {
      errors.push(`relation type "${String(relation.type)}" is invalid.`);
    }
    if (!isValidBrainId(relation.to)) {
      errors.push(`relation target "${String(relation.to)}" is invalid.`);
    }
  }
  return errors;
}

export function validateBrainDocument(
  doc: ParsedBrainDocument,
  expectedId?: string,
  source = "",
): BrainValidationResult {
  const errors: string[] = [];
  const fm = doc.frontmatter;
  if (!isValidBrainId(fm.id)) errors.push("frontmatter.id must be a lowercase slug.");
  if (expectedId && fm.id && fm.id !== expectedId) {
    errors.push(`frontmatter.id "${fm.id}" does not match file id "${expectedId}".`);
  }
  errors.push(
    ...validateBrainFolderKindType({
      folder: fm.folder,
      kind: fm.kind,
      type: fm.type,
      subject: "frontmatter",
    }),
  );
  if (!isValidBrainStatus(fm.status)) {
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
  errors.push(
    ...validateBrainRelations(fm.relations ?? [], { fieldName: "frontmatter.relations" }),
  );
  if (fm.mergedInto && !isValidBrainId(fm.mergedInto)) {
    errors.push(`mergedInto target "${fm.mergedInto}" is invalid.`);
  }
  for (const alias of fm.aliases ?? []) {
    if (!alias.trim()) errors.push("aliases must not contain empty values.");
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
  for (const text of [doc.compiledTruth, ...doc.timeline.map((entry) => entry.body)]) {
    for (const link of parseBrainInlineLinks(text)) {
      if (link.valid) continue;
      if (link.kind === "page") errors.push(`wiki link target "${link.target}" is invalid.`);
      else if (link.kind === "evidence")
        errors.push(`evidence link target "${link.target}" is invalid.`);
      else errors.push(`source link target "${link.target}" is invalid.`);
    }
  }
  const evidenceIds = new Set<string>();
  for (const entry of doc.timeline) {
    if (!isValidBrainEvidenceId(entry.evidenceId)) {
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
  const citations = extractBrainCitations(doc.compiledTruth);
  const sourceCitations = sourceLinkTargets(doc.compiledTruth);
  if (
    fm.status === "active" &&
    fm.kind !== "evidence" &&
    hasCompiledTruth(doc.compiledTruth) &&
    citations.length === 0 &&
    sourceCitations.length === 0
  ) {
    errors.push(
      "active compiled truth must cite provenance with [[evidence:<evidence-id>]] or [[source:<provider>:<id>]].",
    );
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
