import { parseDocument, serializeDocument } from "../document";
import type { MemoryDocument } from "../schema";
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
