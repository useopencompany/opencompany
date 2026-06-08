import type { MemoryStatus, MemoryType } from "../schema";
import { blend } from "./blend";
import { lexicalSearch } from "./bm25";
import { buildCorpus, type IndexRecord } from "./corpus";
import { reciprocalRankFusion } from "./fuse";

export type QueryOptions = {
  text: string;
  types?: MemoryType[];
  status?: MemoryStatus;
  folder?: string;
  since?: string;
  limit?: number;
  lexicalOnly?: boolean;
  // Number of `related`-edge hops to expand the result set by (0 = no graph expansion).
  hops?: number;
};

// Optional model-backed stages, injected by the runtime when an AI Gateway key is available.
// When absent (the default / `--lexical-only`), retrieval runs fully offline. `embedTexts`
// embeds a batch (query + candidate docs) so vector search needs no precomputed cache.
export type RetrievalProviders = {
  expand?: (query: string) => Promise<string[]>;
  embedTexts?: (texts: string[]) => Promise<number[][]>;
  rerank?: (query: string, candidates: Array<{ id: string; text: string }>) => Promise<string[]>;
};

export type QueryHit = {
  id: string;
  type: MemoryType;
  status: MemoryStatus;
  score: number;
  snippet: string;
  updatedAt: string;
};

export async function query(
  root: string,
  options: QueryOptions,
  providers: RetrievalProviders = {},
  now: number = Date.now(),
): Promise<QueryHit[]> {
  const all = await buildCorpus(root);
  const candidates = applyFilters(all, options);
  if (candidates.length === 0) return [];

  const byId = new Map(candidates.map((record) => [record.id, record]));
  const useModel = !options.lexicalOnly;

  // 1) Query expansion (model) — broaden underspecified queries.
  const queries = [options.text];
  if (useModel && providers.expand && options.text.trim()) {
    try {
      queries.push(...(await providers.expand(options.text)));
    } catch {
      // Expansion is best-effort; fall back to the literal query.
    }
  }

  // 2) Lexical (BM25) over every query variant; keep each variant's ranking for fusion.
  const lexicalLists = queries
    .map((q) => lexicalSearch(candidates, q).map((hit) => hit.id))
    .filter((list) => list.length > 0);

  // 3) Vector (model) — embed query + candidates, cosine rank.
  let vectorList: string[] = [];
  if (useModel && providers.embedTexts && options.text.trim()) {
    try {
      vectorList = await vectorSearch(options.text, candidates, providers.embedTexts);
    } catch {
      // Vector stage is best-effort; lexical still carries the query.
    }
  }

  // 4) Fuse. With no signal at all (empty query), fall back to a recency listing.
  const lists = [...lexicalLists, ...(vectorList.length > 0 ? [vectorList] : [])];
  let relevanceById: Map<string, number>;
  if (lists.length === 0) {
    relevanceById = new Map(candidates.map((record) => [record.id, 1]));
  } else {
    relevanceById = reciprocalRankFusion(lists);
  }

  // 5) Rerank (model) — reorder the top fused candidates.
  let ordered = [...relevanceById.entries()]
    .map(([id, relevance]) => ({ id, relevance }))
    .sort((a, b) => b.relevance - a.relevance);
  if (useModel && providers.rerank && options.text.trim() && ordered.length > 1) {
    try {
      const top = ordered.slice(0, 20);
      const rankedIds = await providers.rerank(
        options.text,
        top.map(({ id }) => ({ id, text: snippetFor(byId.get(id)) })),
      );
      const rerankRelevance = new Map(rankedIds.map((id, rank) => [id, rankedIds.length - rank]));
      ordered = ordered.map((item) => ({
        id: item.id,
        relevance: rerankRelevance.get(item.id) ?? item.relevance,
      }));
    } catch {
      // Rerank is best-effort.
    }
  }

  // 5b) Graph expansion (opt-in) — fold in memories reachable via `related` edges, up to N hops.
  // Expanded nodes inherit a damped fraction of their parent's relevance so they rank below the
  // direct matches that pulled them in. Only ids that survived the candidate filters are eligible.
  const hops = options.hops ?? 0;
  if (hops > 0 && ordered.length > 0) {
    const HOP_DECAY = 0.5;
    const relevanceByIdExpanded = new Map(ordered.map(({ id, relevance }) => [id, relevance]));
    let frontier = [...ordered];
    for (let hop = 0; hop < hops && frontier.length > 0; hop++) {
      const next: Array<{ id: string; relevance: number }> = [];
      for (const { id, relevance } of frontier) {
        const record = byId.get(id);
        if (!record) continue;
        for (const { target } of record.related) {
          if (relevanceByIdExpanded.has(target) || !byId.has(target)) continue;
          const expandedRelevance = relevance * HOP_DECAY;
          relevanceByIdExpanded.set(target, expandedRelevance);
          next.push({ id: target, relevance: expandedRelevance });
        }
      }
      frontier = next;
    }
    ordered = [...relevanceByIdExpanded.entries()]
      .map(([id, relevance]) => ({ id, relevance }))
      .sort((a, b) => b.relevance - a.relevance);
  }

  // 6) Recency/position blend, then materialize hits.
  const scored = ordered
    .map(({ id, relevance }) => {
      const record = byId.get(id);
      return record ? { record, relevance } : null;
    })
    .filter((item): item is { record: IndexRecord; relevance: number } => item !== null);

  const limit = options.limit ?? 10;
  return blend(scored, now)
    .slice(0, limit)
    .map(({ record, score }) => ({
      id: record.id,
      type: record.type,
      status: record.status,
      score: Number(score.toFixed(4)),
      snippet: snippetFor(record),
      updatedAt: record.updatedAt,
    }));
}

function applyFilters(records: IndexRecord[], options: QueryOptions): IndexRecord[] {
  const typeSet = options.types && options.types.length > 0 ? new Set(options.types) : null;
  const sinceMs = options.since ? Date.parse(options.since) : Number.NaN;
  return records.filter((record) => {
    if (typeSet && !typeSet.has(record.type)) return false;
    if (options.status && record.status !== options.status) return false;
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

async function vectorSearch(
  text: string,
  records: IndexRecord[],
  embedTexts: (texts: string[]) => Promise<number[][]>,
): Promise<string[]> {
  const docText = (record: IndexRecord) =>
    `${record.title}\n${record.compiledTruth}`.trim() || record.id;
  const vectors = await embedTexts([text, ...records.map(docText)]);
  const queryVector = vectors[0];
  if (!queryVector) return [];
  return records
    .map((record, i) => ({ id: record.id, score: cosine(queryVector, vectors[i + 1] ?? []) }))
    .sort((a, b) => b.score - a.score)
    .map((item) => item.id);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function snippetFor(record: IndexRecord | undefined): string {
  if (!record) return "";
  const source = record.compiledTruth || record.timelineText;
  const firstSentence = source.split(/(?<=[.!?])\s/)[0] ?? source;
  return firstSentence.slice(0, 240).trim();
}
