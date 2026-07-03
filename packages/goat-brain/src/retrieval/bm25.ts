import MiniSearch from "minisearch";
import type { IndexRecord } from "./corpus";

const FIELD_BOOSTS = { title: 4, tags: 3, compiledTruth: 2, timelineText: 1 };

export function lexicalSearch(
  records: IndexRecord[],
  query: string,
): Array<{ id: string; score: number }> {
  const trimmed = query.trim();
  if (records.length === 0 || trimmed.length === 0) return [];
  const index = new MiniSearch<IndexRecord>({
    idField: "id",
    fields: ["title", "tags", "compiledTruth", "timelineText"],
    storeFields: ["id"],
    searchOptions: { boost: FIELD_BOOSTS, prefix: true, fuzzy: 0.2, combineWith: "OR" },
  });
  index.addAll(records);
  return index.search(trimmed).map((result) => ({ id: result.id as string, score: result.score }));
}

export function titleTagMatch(record: IndexRecord, query: string): number {
  const q = normalize(query);
  if (!q) return 0;
  const names = [record.title, ...record.tagList].map(normalize).filter(Boolean);
  if (names.some((name) => name === q)) return 1;
  if (names.some((name) => contains(name, q) || contains(q, name))) return 0.5;
  return 0;
}

function contains(haystack: string, needle: string): boolean {
  return needle.length >= 3 && haystack.includes(needle);
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}
