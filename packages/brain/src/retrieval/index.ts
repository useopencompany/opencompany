import type { BrainGraphDirection, BrainKind, BrainRelation } from "../schema";
import { isBrainSkillFolder } from "../skills";
import { blend } from "./blend";
import { createLexicalIndex, lexicalSearch, titleTagMatch } from "./bm25";
import { buildCorpus, type IndexRecord, loadCachedDocumentEmbeddings } from "./corpus";
import { reciprocalRankFusion } from "./fuse";

export {
  BRAIN_WEIGHT_FRESHNESS,
  BRAIN_WEIGHT_RELEVANCE,
  brainFreshness,
} from "./blend";
export { titleTagMatch } from "./bm25";
export { reciprocalRankFusion } from "./fuse";
export { createGateway, type FetchLike, type Gateway, type GatewayConfig } from "./gateway";

export type BrainQueryOptions = {
  text: string;
  folder?: string;
  kind?: BrainKind;
  since?: string;
  limit?: number;
  offset?: number;
  lexicalOnly?: boolean;
  hops?: number;
  graphDirection?: BrainGraphDirection;
  includeInvalid?: boolean;
  includeMerged?: boolean;
  includeArchived?: boolean;
  // Conflict copies (pages carrying a conflicts_with relation, written when a
  // sync loses a same-page race) are pending curation; hidden by default so
  // they cannot outrank or shadow the canonical page.
  includeConflicts?: boolean;
};

export type RetrievalProviders = {
  embedTexts?: (texts: string[]) => Promise<number[][]>;
  embeddingCacheKey?: string;
};

export type BrainQueryHit = {
  id: string;
  folder: string;
  title: string;
  type: string;
  status: string;
  valid: boolean;
  score: number;
  snippet: string;
  compiledTruth: string;
  relationContext: string;
  updatedAt: string;
  matchedBy: "text" | "graph" | "both";
  via?: BrainGraphHop[];
};

export type BrainGraphHop = {
  from: string;
  type: string;
  to: string;
};

export async function queryBrain(
  root: string,
  options: BrainQueryOptions,
  providers: RetrievalProviders = {},
  now: number = Date.now(),
): Promise<BrainQueryHit[]> {
  const all = await buildCorpus(root);
  const candidates = applyFilters(all, options);
  if (candidates.length === 0) return [];
  const byId = new Map(candidates.map((record) => [record.id, record]));
  const useModel = !options.lexicalOnly;

  const lexicalIndex = createLexicalIndex(candidates);
  const lexicalLists = [lexicalSearch(lexicalIndex, options.text).map((hit) => hit.id)].filter(
    (list) => list.length > 0,
  );

  let vectorList: string[] = [];
  if (useModel && providers.embedTexts && options.text.trim()) {
    try {
      vectorList = await vectorSearch(
        root,
        options.text,
        candidates,
        providers.embedTexts,
        providers.embeddingCacheKey ?? "default",
      );
    } catch {}
  }

  const lists = [...lexicalLists, ...(vectorList.length > 0 ? [vectorList] : [])];
  const hasQueryText = options.text.trim().length > 0;
  const relevanceById =
    lists.length === 0
      ? hasQueryText
        ? new Map<string, number>()
        : new Map(candidates.map((record) => [record.id, 1]))
      : reciprocalRankFusion(lists);

  const textMatchIds = new Set(relevanceById.keys());
  const graphPaths = new Map<string, BrainGraphHop[]>();
  if ((options.hops ?? 0) > 0) {
    expandAlongGraph(
      relevanceById,
      graphPaths,
      byId,
      options.hops ?? 0,
      options.graphDirection ?? "both",
    );
  }
  applyNameBoost(relevanceById, byId, options.text);

  const ordered = [...relevanceById.entries()]
    .map(([id, relevance]) => ({ id, relevance }))
    .sort((a, b) => b.relevance - a.relevance);

  const scored = ordered
    .map(({ id, relevance }) => {
      const record = byId.get(id);
      return record ? { record, relevance } : null;
    })
    .filter((item): item is { record: IndexRecord; relevance: number } => item !== null);

  return blend(scored, now)
    .slice(
      Math.max(0, Math.trunc(options.offset ?? 0)),
      Math.max(0, Math.trunc(options.offset ?? 0)) + (options.limit ?? 10),
    )
    .map(({ record, score }) => {
      const via = graphPaths.get(record.id);
      return {
        id: record.id,
        folder: record.folder,
        title: record.title,
        type: record.type,
        status: record.status,
        valid: record.valid,
        score: Number(score.toFixed(4)),
        snippet: snippetFor(record),
        compiledTruth: record.compiledTruth,
        relationContext: record.relationText,
        updatedAt: record.updatedAt,
        matchedBy:
          graphPaths.has(record.id) && textMatchIds.has(record.id)
            ? "both"
            : graphPaths.has(record.id)
              ? "graph"
              : "text",
        ...(via ? { via } : {}),
      };
    });
}

function applyFilters(records: IndexRecord[], options: BrainQueryOptions): IndexRecord[] {
  const sinceMs = options.since ? Date.parse(options.since) : Number.NaN;
  const kind = options.kind ?? "page";
  if (options.since && Number.isNaN(sinceMs)) {
    throw new Error(`Invalid "since" value: ${options.since}`);
  }
  return records.filter((record) => {
    if (record.kind !== kind) return false;
    if (!options.includeInvalid && !record.valid) return false;
    if (!options.includeMerged && record.status === "merged") return false;
    if (!options.includeArchived && record.status === "archived") return false;
    if (
      !options.includeConflicts &&
      record.relations.some((relation) => relation.type === "conflicts_with")
    ) {
      return false;
    }
    if (
      options.folder &&
      record.folder !== options.folder &&
      !record.folder.startsWith(`${options.folder}/`)
    ) {
      return false;
    }
    if (!options.folder && isBrainSkillFolder(record.folder)) return false;
    if (!Number.isNaN(sinceMs)) {
      const updated = Date.parse(record.updatedAt);
      if (Number.isNaN(updated) || updated < sinceMs) return false;
    }
    return true;
  });
}

const HOP_DECAY = 0.5;
const GRAPH_SEED_LIMIT = 20;

function expandAlongGraph(
  relevance: Map<string, number>,
  graphPaths: Map<string, BrainGraphHop[]>,
  byId: Map<string, IndexRecord>,
  hops: number,
  direction: BrainGraphDirection,
): void {
  const adjacency = buildAdjacency(byId, direction);
  let frontier = [...relevance.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, GRAPH_SEED_LIMIT)
    .map(([id, score]) => ({ id, score, path: [] as BrainGraphHop[] }));

  for (let hop = 0; hop < hops && frontier.length > 0; hop++) {
    const next: Array<{ id: string; score: number; path: BrainGraphHop[] }> = [];
    for (const { id, score, path } of frontier) {
      const boosted = score * HOP_DECAY;
      for (const edge of adjacency.get(id) ?? []) {
        if (!byId.has(edge.to)) continue;
        if (boosted > (relevance.get(edge.to) ?? 0)) {
          const nextPath = [...path, edge];
          relevance.set(edge.to, boosted);
          graphPaths.set(edge.to, nextPath);
          next.push({ id: edge.to, score: boosted, path: nextPath });
        }
      }
    }
    frontier = next;
  }
}

function buildAdjacency(
  byId: Map<string, IndexRecord>,
  direction: BrainGraphDirection,
): Map<string, BrainGraphHop[]> {
  const adjacency = new Map<string, BrainGraphHop[]>();
  const link = (a: string, type: string, b: string) => {
    if (a === b) return;
    const forward = { from: a, type, to: b };
    const reverse = { from: b, type, to: a };
    if (direction === "out" || direction === "both") {
      (adjacency.get(a) ?? adjacency.set(a, []).get(a))?.push(forward);
    }
    if (direction === "in" || direction === "both") {
      (adjacency.get(b) ?? adjacency.set(b, []).get(b))?.push(reverse);
    }
  };
  for (const record of byId.values()) {
    for (const relation of record.relations as BrainRelation[])
      link(record.id, relation.type, relation.to);
    for (const target of record.wikiLinks) link(record.id, "wiki_link", target);
    for (const target of record.evidenceLinks) link(record.id, "cites", target);
  }
  return adjacency;
}

function applyNameBoost(
  relevance: Map<string, number>,
  byId: Map<string, IndexRecord>,
  text: string,
): void {
  if (!text.trim()) return;
  let maxRelevance = 0;
  for (const value of relevance.values()) maxRelevance = Math.max(maxRelevance, value);
  maxRelevance = maxRelevance || 1;
  for (const record of byId.values()) {
    const match = titleTagMatch(record, text);
    if (match > 0) relevance.set(record.id, (relevance.get(record.id) ?? 0) + match * maxRelevance);
  }
}

async function vectorSearch(
  root: string,
  text: string,
  records: IndexRecord[],
  embedTexts: (texts: string[]) => Promise<number[][]>,
  embeddingCacheKey: string,
): Promise<string[]> {
  const [queryVector] = await embedTexts([text]);
  if (!queryVector) return [];
  const documentVectors = await loadCachedDocumentEmbeddings(
    root,
    embeddingCacheKey,
    records,
    embedTexts,
  );
  return records
    .map((record) => ({
      id: record.id,
      score: cosine(queryVector, documentVectors.get(record.id) ?? []),
    }))
    .sort((a, b) => b.score - a.score)
    .map((item) => item.id);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let am = 0;
  let bm = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    am += av * av;
    bm += bv * bv;
  }
  const denom = Math.sqrt(am) * Math.sqrt(bm);
  return denom === 0 ? 0 : dot / denom;
}

function snippetFor(record: IndexRecord): string {
  const truth = record.compiledTruth.trim();
  if (!truth) return "_No compiled truth yet._";
  return truth.length <= 1200
    ? truth
    : `${truth.slice(0, 1200).trimEnd()}... [truncated; run goat-brain get ${record.id}]`;
}
