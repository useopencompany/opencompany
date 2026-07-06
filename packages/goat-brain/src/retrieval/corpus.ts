import { parseGoatBrainDocument } from "../document";
import { goatBrainFolderFromRelativePath } from "../paths";
import type { GoatBrainEntityType, GoatBrainRelation } from "../schema";
import { inferGoatBrainEntityTypeFromFolder } from "../schemas";
import { listGoatBrainFiles } from "../store";
import { validateGoatBrainDocument } from "../validate";
import { wikiLinkTargets } from "../wiki-links";

export type IndexRecord = {
  id: string;
  folder: string;
  title: string;
  type: GoatBrainEntityType;
  aliases: string[];
  tags: string;
  tagList: string[];
  relationText: string;
  compiledTruth: string;
  timelineText: string;
  updatedAt: string;
  relations: GoatBrainRelation[];
  wikiLinks: string[];
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
        type:
          doc.frontmatter.type ??
          inferGoatBrainEntityTypeFromFolder(doc.frontmatter.folder ?? folder),
        aliases: doc.frontmatter.aliases ?? [],
        tags: (doc.frontmatter.tags ?? []).join(" "),
        tagList: doc.frontmatter.tags ?? [],
        relationText: relationsToText(doc.frontmatter.relations),
        compiledTruth: doc.compiledTruth,
        timelineText: doc.timeline.map((entry) => entry.body).join("\n"),
        updatedAt: doc.frontmatter.updatedAt ?? "",
        relations: doc.frontmatter.relations ?? [],
        wikiLinks: wikiLinkTargets(doc.compiledTruth),
        valid: validateGoatBrainDocument(doc, file.id, file.source).ok,
      },
    ];
  });
}

function relationsToText(relations: GoatBrainRelation[] | undefined): string {
  if (!relations) return "";
  return relations.map((relation) => `${relation.type}: ${relation.to}`).join("\n");
}
