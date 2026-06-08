import type { MemoryStatus, MemoryType } from "../schema";
import { blend } from "./blend";
import { lexicalSearch, titleAliasMatch } from "./bm25";
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
  // Graph expansion: follow `related` links + evidence citations/subjects this many hops out
  // from the top text hits, pulling linked neighbors into the result with a decaying boost.
  // 0 (default) keeps retrieval flat — purely text-driven.
  hops?: number;
  // By default retrieval mirrors doctor's integrity view: `merged` redirect stubs and records
  // that fail strict validation are hidden. These opt back in for recovery/debugging.
  includeMerged?: boolean;
  includeInvalid?: boolean;
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

  // 4a) Graph expansion — pull linked neighbors of the top hits into the result with a per-hop
  // decaying boost, so relationship queries surface the connected object (a person's company, a
  // company's decision) even when it didn't match the text directly.
  if ((options.hops ?? 0) > 0) {
    expandAlongGraph(relevanceById, byId, options.hops ?? 0);
  }

  // 4b) Name boost — a query that *is* a record's title/alias foregrounds that record, undoing
  // the rank-flattening of fusion (an exact "Acme Inc" hit should beat an incidental mention).
  applyNameBoost(relevanceById, byId, options.text);

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
  // An explicit `--status merged` is itself a request to see merged stubs.
  const includeMerged = options.includeMerged || options.status === "merged";
  return records.filter((record) => {
    if (!includeMerged && record.status === "merged") return false;
    if (!options.includeInvalid && !record.valid) return false;
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

// Each hop pulls a neighbor in at this fraction of the node that reached it, so a 1-hop neighbor
// of the top hit ranks below the directly-matched hits but above unrelated records.
const HOP_DECAY = 0.5;
// How many top hits seed the expansion — bounds the work and keeps weak matches from dragging in
// their whole neighborhood.
const GRAPH_SEED_LIMIT = 20;
// Name-match weight (see titleAliasMatch): an exact title/alias match adds a full max-relevance,
// guaranteeing it leads; a containment match adds half.
const NAME_BOOST = 1;

// Mutate the relevance map in place, BFS-ing out from the top-ranked hits along the memory graph
// (related links, evidence citations, evidence→subject edges — all treated as undirected). A
// neighbor only present via the graph enters the results; one already ranked keeps its higher
// score. Neighbors outside the filtered candidate set (`byId`) are skipped, so filters still hold.
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

// Undirected adjacency over the candidate set: related↔related, canonical↔cited evidence, and
// evidence↔subject. Edges are added both ways so a query landing on either end can reach the other.
function buildAdjacency(byId: Map<string, IndexRecord>): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (a === b) return;
    (adjacency.get(a) ?? adjacency.set(a, new Set()).get(a))?.add(b);
    (adjacency.get(b) ?? adjacency.set(b, new Set()).get(b))?.add(a);
  };
  for (const record of byId.values()) {
    for (const rel of record.related) link(record.id, rel.target);
    for (const cited of record.citations) link(record.id, cited);
    for (const subject of record.subjects) link(record.id, subject);
  }
  return adjacency;
}

// Add a name-match bump (scaled to the current max relevance) so a query that names a record by
// title/alias floats that record to the top regardless of fusion's rank-flattening.
function applyNameBoost(
  relevance: Map<string, number>,
  byId: Map<string, IndexRecord>,
  text: string,
): void {
  if (!text.trim()) return;
  const maxRelevance = Math.max(0, ...relevance.values()) || 1;
  for (const record of byId.values()) {
    const match = titleAliasMatch(record, text);
    if (match > 0) {
      relevance.set(record.id, (relevance.get(record.id) ?? 0) + match * NAME_BOOST * maxRelevance);
    }
  }
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
