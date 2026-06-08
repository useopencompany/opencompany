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

// How strongly the query names a record by its title or one of its aliases. BM25 already field-
// boosts these, but reciprocal-rank fusion flattens score magnitude into ranks, so an exact
// "Acme Inc" alias hit can lose to an incidental body match. This returns a separate, intent-
// level signal the pipeline folds back in so a query that *is* an entity's name foregrounds that
// entity: 1 for an exact (normalized) title/alias match, 0.5 for a whole-string containment
// match, 0 otherwise.
export function titleAliasMatch(record: IndexRecord, query: string): number {
  const q = normalizeName(query);
  if (!q) return 0;
  const names = [record.title, ...record.aliasList].map(normalizeName).filter(Boolean);
  if (names.some((name) => name === q)) return 1;
  // Containment only counts when the contained name is itself substantial (>= 3 chars), so a
  // 2-letter id can't soft-match every query that happens to include those letters.
  if (names.some((name) => contains(name, q) || contains(q, name))) return 0.5;
  return 0;
}

function contains(haystack: string, needle: string): boolean {
  return needle.length >= 3 && haystack.includes(needle);
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}
