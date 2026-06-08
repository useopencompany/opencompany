import MiniSearch from "minisearch";
import type { IndexRecord } from "./corpus";

// Field-boosted lexical (BM25-style) search via minisearch. Title/aliases rank highest, then
// compiled truth (current belief), then timeline text (raw history) — a simple stand-in for
// position-aware weighting. Pure and key-free; this is the `--lexical-only` floor.
const FIELD_BOOSTS = { title: 4, aliases: 4, compiledTruth: 2, timelineText: 1 };

export type LexicalHit = { id: string; score: number };

export function lexicalSearch(records: IndexRecord[], query: string): LexicalHit[] {
  const trimmed = query.trim();
  if (records.length === 0 || trimmed.length === 0) return [];

  const index = new MiniSearch<IndexRecord>({
    idField: "id",
    fields: ["title", "aliases", "compiledTruth", "timelineText"],
    storeFields: ["id"],
    searchOptions: { boost: FIELD_BOOSTS, prefix: true, fuzzy: 0.2, combineWith: "OR" },
  });
  index.addAll(records);

  return index.search(trimmed).map((result) => ({ id: result.id as string, score: result.score }));
}
