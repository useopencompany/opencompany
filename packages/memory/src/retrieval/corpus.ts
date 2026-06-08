import { extractCitations, parseDocument } from "../document";
import { idFromRelativePath } from "../paths";
import type { MemoryStatus, MemoryType } from "../schema";
import { listFiles } from "../store";
import { validateDocument } from "../validate";

// A flattened, searchable view of one memory file. Compiled truth and timeline text are kept
// in separate fields so the lexical index can weight current belief above raw history.
// `valid`/`related`/`subjects`/`citations` are carried so retrieval can mirror doctor's
// integrity view (drop what doctor rejects) and expand the graph along links/citations.
export type IndexRecord = {
  id: string;
  type: MemoryType;
  status: MemoryStatus;
  folder: string;
  title: string;
  aliases: string;
  aliasList: string[];
  compiledTruth: string;
  timelineText: string;
  updatedAt: string;
  capturedAt: string;
  valid: boolean;
  related: string[];
  subjects: string[];
  citations: string[];
};

// Build the corpus by walking the memory root and leniently parsing each file. Files that fail
// to parse are skipped rather than aborting retrieval (doctor surfaces them separately). Each
// record carries a strict-validity flag (the same `validateDocument` doctor uses) so retrieval
// can exclude what doctor would reject without ever throwing — keeping query and doctor honest.
export async function buildCorpus(root: string): Promise<IndexRecord[]> {
  const files = await listFiles(root);
  const records: IndexRecord[] = [];
  for (const file of files) {
    const parsed = parseDocument(file.source);
    const fm = parsed.frontmatter;
    if (!fm.id || !fm.type) continue;
    const folder = file.relativePath.slice(0, file.relativePath.lastIndexOf("/"));
    const aliasList = fm.aliases ?? [];
    records.push({
      id: fm.id,
      type: fm.type,
      status: fm.status ?? "active",
      folder,
      title: parsed.title || fm.id,
      aliases: aliasList.join(" "),
      aliasList,
      compiledTruth: parsed.compiledTruth,
      timelineText: parsed.timeline.map((entry) => entry.body).join("\n"),
      updatedAt: fm.updatedAt ?? "",
      capturedAt: fm.source?.capturedAt ?? "",
      valid: validateDocument(parsed, fm.id).ok,
      related: fm.related ?? [],
      subjects: fm.subjects ?? [],
      citations: extractCitations(parsed.compiledTruth),
    });
  }
  return records;
}

export { idFromRelativePath };
