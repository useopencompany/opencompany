import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseGoatBrainDocument } from "../document";
import { goatBrainPayloadHash } from "../entry";
import { evidenceLinkTargets, pageLinkTargets } from "../inline-links";
import { goatBrainFolderFromRelativePath } from "../paths";
import type { GoatBrainEntityType, GoatBrainRelation, GoatBrainStatus } from "../schema";
import { inferGoatBrainEntityTypeFromFolder } from "../schemas";
import { listGoatBrainFiles } from "../store";
import { validateGoatBrainDocument } from "../validate";

export type IndexRecord = {
  id: string;
  folder: string;
  title: string;
  type: GoatBrainEntityType;
  status: GoatBrainStatus;
  aliases: string[];
  tags: string;
  tagList: string[];
  relationText: string;
  compiledTruth: string;
  contentHash: string;
  embeddingText: string;
  timelineText: string;
  updatedAt: string;
  relations: GoatBrainRelation[];
  wikiLinks: string[];
  evidenceLinks: string[];
  valid: boolean;
};

export async function buildCorpus(root: string): Promise<IndexRecord[]> {
  const files = await listGoatBrainFiles(root);
  return files.flatMap((file) => {
    const doc = parseGoatBrainDocument(file.source);
    const folder = goatBrainFolderFromRelativePath(file.relativePath);
    const id = doc.frontmatter.id ?? file.id;
    if (!folder) return [];
    const title = doc.title || doc.frontmatter.title || id;
    const timelineText = doc.timeline.map((entry) => entry.body).join("\n");
    const inlineLinkText = [doc.compiledTruth, timelineText].join("\n\n");
    const embeddingText = `${title}\n${doc.compiledTruth}`.trim() || id;
    return [
      {
        id,
        folder: doc.frontmatter.folder ?? folder,
        title,
        type:
          doc.frontmatter.type ??
          inferGoatBrainEntityTypeFromFolder(doc.frontmatter.folder ?? folder),
        status: doc.frontmatter.status ?? "draft",
        aliases: doc.frontmatter.aliases ?? [],
        tags: (doc.frontmatter.tags ?? []).join(" "),
        tagList: doc.frontmatter.tags ?? [],
        relationText: relationsToText(doc.frontmatter.relations),
        compiledTruth: doc.compiledTruth,
        contentHash: goatBrainPayloadHash(embeddingText),
        embeddingText,
        timelineText,
        updatedAt: doc.frontmatter.updatedAt ?? "",
        relations: doc.frontmatter.relations ?? [],
        wikiLinks: pageLinkTargets(inlineLinkText),
        evidenceLinks: evidenceLinkTargets(inlineLinkText),
        valid: validateGoatBrainDocument(doc, file.id, file.source).ok,
      },
    ];
  });
}

export async function loadCachedDocumentEmbeddings(
  root: string,
  namespace: string,
  records: IndexRecord[],
  embedTexts: (texts: string[]) => Promise<number[][]>,
): Promise<Map<string, number[]>> {
  const cache = await readEmbeddingCache(root);
  const missing = new Map<string, string>();
  for (const record of records) {
    const key = embeddingCacheKey(namespace, record.contentHash);
    if (!isVector(cache.vectors[key])) missing.set(key, record.embeddingText);
  }

  if (missing.size > 0) {
    const missingEntries = [...missing.entries()];
    const vectors = await embedTexts(missingEntries.map(([, text]) => text));
    for (let i = 0; i < missingEntries.length; i++) {
      const [key] = missingEntries[i] ?? [];
      const vector = vectors[i];
      if (key && isVector(vector)) cache.vectors[key] = vector;
    }
    await writeEmbeddingCache(root, cache);
  }

  const byId = new Map<string, number[]>();
  for (const record of records) {
    const vector = cache.vectors[embeddingCacheKey(namespace, record.contentHash)];
    if (isVector(vector)) byId.set(record.id, vector);
  }
  return byId;
}

function relationsToText(relations: GoatBrainRelation[] | undefined): string {
  if (!relations) return "";
  return relations.map((relation) => `${relation.type}: ${relation.to}`).join("\n");
}

type EmbeddingCache = {
  version: 1;
  vectors: Record<string, number[]>;
};

const EMBEDDING_CACHE_RELATIVE_PATH = ".brain/embedding-cache.json";

async function readEmbeddingCache(root: string): Promise<EmbeddingCache> {
  try {
    const parsed = JSON.parse(
      await readFile(path.join(root, EMBEDDING_CACHE_RELATIVE_PATH), "utf8"),
    ) as Partial<EmbeddingCache>;
    return parsed.version === 1 && parsed.vectors && typeof parsed.vectors === "object"
      ? { version: 1, vectors: parsed.vectors }
      : emptyEmbeddingCache();
  } catch (error) {
    if (isNotFound(error) || error instanceof SyntaxError) return emptyEmbeddingCache();
    throw error;
  }
}

async function writeEmbeddingCache(root: string, cache: EmbeddingCache): Promise<void> {
  const target = path.join(root, EMBEDDING_CACHE_RELATIVE_PATH);
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${randomUUID()}`;
  await writeFile(tmp, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  await rename(tmp, target);
}

function emptyEmbeddingCache(): EmbeddingCache {
  return { version: 1, vectors: {} };
}

function embeddingCacheKey(namespace: string, contentHash: string): string {
  return `${namespace}:${contentHash}`;
}

function isVector(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "number" && Number.isFinite(item))
  );
}

function isNotFound(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && (error as { code?: string }).code === "ENOENT",
  );
}
