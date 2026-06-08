import { extractCitations, parseDocument, serializeDocument } from "../document";
import { isEvidenceType, type MemoryDocument } from "../schema";
import { findFile, pathForDocument, writeDocumentText } from "../store";
import { validateDocument } from "../validate";

// Load + strictly validate a document by id. Returns the loaded doc, a validation failure, or
// null when the id is absent — letting callers map each case to the right exit code.
export async function loadValid(
  root: string,
  id: string,
): Promise<
  | { kind: "ok"; relativePath: string; doc: MemoryDocument }
  | { kind: "invalid"; errors: string[] }
  | { kind: "missing" }
> {
  const file = await findFile(root, id);
  if (!file) return { kind: "missing" };
  const result = validateDocument(parseDocument(file.source), id);
  if (!result.ok) return { kind: "invalid", errors: result.errors };
  return { kind: "ok", relativePath: file.relativePath, doc: result.doc };
}

// Serialize and atomically write a document to the path its type+id dictates.
export async function persist(root: string, doc: MemoryDocument): Promise<string> {
  const relativePath = pathForDocument(doc);
  await writeDocumentText(root, relativePath, serializeDocument(doc));
  return relativePath;
}

// The compiled-truth citation contract, shared by `rewrite` and `create`: the truth must cite
// evidence with [^ev:<id>] footnotes, every cited id must resolve to a valid evidence record, and
// each must already list `subjectId` in its `subjects`. Returns the cited ids on success or the
// first guard error — so a record can only carry compiled truth that is fully backed by evidence.
export async function validateCitations(
  root: string,
  subjectId: string,
  truth: string,
): Promise<{ ok: true; cited: string[] } | { ok: false; error: string }> {
  const cited = extractCitations(truth);
  if (cited.length === 0) {
    return {
      ok: false,
      error:
        "Compiled truth must cite evidence with [^ev:<evidence-id>] footnotes. Capture evidence first with `memory append-evidence`.",
    };
  }
  for (const evidenceId of cited) {
    const evidence = await loadValid(root, evidenceId);
    if (evidence.kind === "missing") {
      return { ok: false, error: `Cited evidence "${evidenceId}" does not exist.` };
    }
    if (evidence.kind === "invalid") {
      return {
        ok: false,
        error: `Cited evidence "${evidenceId}" is invalid: ${evidence.errors[0]}`,
      };
    }
    if (!isEvidenceType(evidence.doc.frontmatter.type)) {
      return { ok: false, error: `Citation "${evidenceId}" is not an evidence record.` };
    }
    if (!(evidence.doc.frontmatter.subjects ?? []).includes(subjectId)) {
      return {
        ok: false,
        error: `Evidence "${evidenceId}" does not list "${subjectId}" as a subject — it cannot back this claim.`,
      };
    }
  }
  return { ok: true, cited };
}

export function uniqueMerge(...lists: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const item of list) {
      if (item && !seen.has(item)) {
        seen.add(item);
        out.push(item);
      }
    }
  }
  return out;
}
