import { parseGoatBrainDocument } from "../document";
import { goatBrainFolderFromRelativePath } from "../paths";
import type { GoatBrainRelation } from "../schema";
import { listGoatBrainFiles } from "../store";
import { validateGoatBrainDocument } from "../validate";

export type IndexRecord = {
  id: string;
  folder: string;
  title: string;
  tags: string;
  tagList: string[];
  compiledTruth: string;
  timelineText: string;
  updatedAt: string;
  related: GoatBrainRelation[];
  valid: boolean;
};

export async function buildCorpus(root: string): Promise<IndexRecord[]> {
  const files = await listGoatBrainFiles(root);
  return files.flatMap((file) => {
    const doc = parseGoatBrainDocument(file.source);
    const folder = goatBrainFolderFromRelativePath(file.relativePath);
    const id = doc.frontmatter.id ?? file.id;
    if (!folder) return [];
    return [
      {
        id,
        folder: doc.frontmatter.folder ?? folder,
        title: doc.title || doc.frontmatter.title || id,
        tags: (doc.frontmatter.tags ?? []).join(" "),
        tagList: doc.frontmatter.tags ?? [],
        compiledTruth: doc.compiledTruth,
        timelineText: doc.timeline.map((entry) => entry.body).join("\n"),
        updatedAt: doc.frontmatter.updatedAt ?? "",
        related: doc.frontmatter.related ?? [],
        valid: validateGoatBrainDocument(doc, file.id, file.source).ok,
      },
    ];
  });
}
