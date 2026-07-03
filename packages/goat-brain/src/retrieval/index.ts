import type { GoatBrainRelation } from "../schema";
import { blend } from "./blend";
import { lexicalSearch, titleTagMatch } from "./bm25";
import { buildCorpus, type IndexRecord } from "./corpus";
import { reciprocalRankFusion } from "./fuse";

export type GoatBrainQueryOptions = {
  text: string;
  folder?: string;
  since?: string;
  limit?: number;
  lexicalOnly?: boolean;
  hops?: number;
  includeInvalid?: boolean;
};

export type RetrievalProviders = {
  expand?: (query: string) => Promise<string[]>;
  embedTexts?: (texts: string[]) => Promise<number[][]>;
  rerank?: (query: string, candidates: Array<{ id: string; text: string }>) => Promise<string[]>;
};

export type GoatBrainQueryHit = {
  id: string;
  folder: string;
  title: string;
  score: number;
  snippet: string;
  updatedAt: string;
};

export async function queryGoatBrain(
  root: string,
  options: GoatBrainQueryOptions,
  providers: RetrievalProviders = {},
  now: number = Date.now(),
): Promise<GoatBrainQueryHit[]> {
  const all = await buildCorpus(root);
  const candidates = applyFilters(all, options);
  if (candidates.length === 0) return [];
  const byId = new Map(candidates.map((record) => [record.id, record]));
  const useModel = !options.lexicalOnly;

  const queries = [options.text];
  if (useModel && providers.expand && options.text.trim()) {
    try {
      queries.push(...(await providers.expand(options.text)));
    } catch {}
  }

  const lexicalLists = queries
    .map((text) => lexicalSearch(candidates, text).map((hit) => hit.id))
    .filter((list) => list.length > 0);

  let vectorList: string[] = [];
  if (useModel && providers.embedTexts && options.text.trim()) {
    try {
      vectorList = await vectorSearch(options.text, candidates, providers.embedTexts);
    } catch {}
  }

  const lists = [...lexicalLists, ...(vectorList.length > 0 ? [vectorList] : [])];
  const relevanceById =
    lists.length === 0
      ? new Map(candidates.map((record) => [record.id, 1]))
      : reciprocalRankFusion(lists);

  if ((options.hops ?? 0) > 0) expandAlongGraph(relevanceById, byId, options.hops ?? 0);
  applyNameBoost(relevanceById, byId, options.text);

  let ordered = [...relevanceById.entries()]
    .map(([id, relevance]) => ({ id, relevance }))
    .sort((a, b) => b.relevance - a.relevance);
  if (useModel && providers.rerank && options.text.trim() && ordered.length > 1) {
    try {
      const top = ordered.slice(0, 20);
      const rankedIds = await providers.rerank(
        options.text,
        top.map(({ id }) => ({ id, text: rerankTextFor(byId.get(id)) })),
      );
      const rerankRelevance = new Map(rankedIds.map((id, rank) => [id, rankedIds.length - rank]));
      ordered = ordered.map((item) => ({
        id: item.id,
        relevance: rerankRelevance.get(item.id) ?? item.relevance,
      }));
    } catch {}
  }

  const scored = ordered
    .map(({ id, relevance }) => {
      const record = byId.get(id);
      return record ? { record, relevance } : null;
    })
    .filter((item): item is { record: IndexRecord; relevance: number } => item !== null);

  return blend(scored, now)
    .slice(0, options.limit ?? 10)
    .map(({ record, score }) => ({
      id: record.id,
      folder: record.folder,
      title: record.title,
      score: Number(score.toFixed(4)),
      snippet: snippetFor(record),
      updatedAt: record.updatedAt,
    }));
}

function applyFilters(records: IndexRecord[], options: GoatBrainQueryOptions): IndexRecord[] {
  const sinceMs = options.since ? Date.parse(options.since) : Number.NaN;
  return records.filter((record) => {
    if (!options.includeInvalid && !record.valid) return false;
    if (
      options.folder &&
      record.folder !== options.folder &&
      !record.folder.startsWith(`${options.folder}/`)
    ) {
      return false;
    }
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
  byId: Map<string, IndexRecord>,
  hops: number,
): void {
  const adjacency = buildAdjacency(byId);
  let frontier = [...relevance.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, GRAPH_SEED_LIMIT)
    .map(([id, score]) => ({ id, score }));

  for (let hop = 0; hop < hops && frontier.length > 0; hop++) {
    const next: Array<{ id: string; score: number }> = [];
    for (const { id, score } of frontier) {
      const boosted = score * HOP_DECAY;
      for (const neighbor of adjacency.get(id) ?? []) {
        if (!byId.has(neighbor)) continue;
        if (boosted > (relevance.get(neighbor) ?? 0)) {
          relevance.set(neighbor, boosted);
          next.push({ id: neighbor, score: boosted });
        }
      }
    }
    frontier = next;
  }
}

function buildAdjacency(byId: Map<string, IndexRecord>): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (a === b) return;
    (adjacency.get(a) ?? adjacency.set(a, new Set()).get(a))?.add(b);
    (adjacency.get(b) ?? adjacency.set(b, new Set()).get(b))?.add(a);
  };
  for (const record of byId.values()) {
    for (const relation of record.related as GoatBrainRelation[]) link(record.id, relation.target);
  }
  return adjacency;
}

function applyNameBoost(
  relevance: Map<string, number>,
  byId: Map<string, IndexRecord>,
  text: string,
): void {
  if (!text.trim()) return;
  const maxRelevance = Math.max(0, ...relevance.values()) || 1;
  for (const record of byId.values()) {
    const match = titleTagMatch(record, text);
    if (match > 0) relevance.set(record.id, (relevance.get(record.id) ?? 0) + match * maxRelevance);
  }
}

async function vectorSearch(
  text: string,
  records: IndexRecord[],
  embedTexts: (texts: string[]) => Promise<number[][]>,
): Promise<string[]> {
  const vectors = await embedTexts([
    text,
    ...records.map((record) => `${record.title}\n${record.compiledTruth}`.trim() || record.id),
  ]);
  const queryVector = vectors[0];
  if (!queryVector) return [];
  return records
    .map((record, i) => ({ id: record.id, score: cosine(queryVector, vectors[i + 1] ?? []) }))
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

function rerankTextFor(record: IndexRecord | undefined): string {
  if (!record) return "";
  return [
    `Title: ${record.title}`,
    record.compiledTruth ? `Compiled truth:\n${truncate(record.compiledTruth, 1200)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function snippetFor(record: IndexRecord): string {
  const truth = record.compiledTruth.trim();
  if (!truth) return "_No compiled truth yet._";
  return truth.length <= 1200
    ? truth
    : `${truth.slice(0, 1200).trimEnd()}... [truncated; run goat-brain get ${record.id}]`;
}

function truncate(value: string, limit: number) {
  return value.length <= limit ? value : `${value.slice(0, limit).trimEnd()}...`;
}
