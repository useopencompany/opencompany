import { parseDocument } from "../document";
import { idFromRelativePath } from "../paths";
import type { MemoryRelation, MemoryStatus, MemoryType } from "../schema";
import { listFiles } from "../store";

// A flattened, searchable view of one memory file. Compiled truth and timeline text are kept
// in separate fields so the lexical index can weight current belief above raw history.
export type IndexRecord = {
  id: string;
  type: MemoryType;
  status: MemoryStatus;
  folder: string;
  title: string;
  aliases: string;
  compiledTruth: string;
  timelineText: string;
  updatedAt: string;
  capturedAt: string;
  // Outbound typed graph edges (directional) to other memory ids, used for N-hop query expansion.
  related: MemoryRelation[];
};

// Build the corpus by walking the memory root and leniently parsing each file. Files that fail
// to parse are skipped rather than aborting retrieval (doctor surfaces them separately).
export async function buildCorpus(root: string): Promise<IndexRecord[]> {
  const files = await listFiles(root);
  const records: IndexRecord[] = [];
  for (const file of files) {
    const parsed = parseDocument(file.source);
    const fm = parsed.frontmatter;
    if (!fm.id || !fm.type) continue;
    const folder = file.relativePath.slice(0, file.relativePath.lastIndexOf("/"));
    records.push({
      id: fm.id,
      type: fm.type,
      status: fm.status ?? "active",
      folder,
      title: parsed.title || fm.id,
      aliases: (fm.aliases ?? []).join(" "),
      compiledTruth: parsed.compiledTruth,
      timelineText: parsed.timeline.map((entry) => entry.body).join("\n"),
      updatedAt: fm.updatedAt ?? "",
      capturedAt: fm.source?.capturedAt ?? "",
      related: fm.related ?? [],
    });
  }
  return records;
}

export { idFromRelativePath };
