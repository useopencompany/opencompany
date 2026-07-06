import type { IndexRecord } from "./corpus";

const WEIGHT_RELEVANCE = 0.85;
const WEIGHT_FRESHNESS = 0.15;
const HALF_LIFE_DAYS = 90;

export function blend(
  scored: Array<{ record: IndexRecord; relevance: number }>,
  now: number,
): Array<{ record: IndexRecord; score: number }> {
  const maxRelevance = scored.reduce((max, item) => Math.max(max, item.relevance), 0) || 1;
  return scored
    .map(({ record, relevance }) => ({
      record,
      score:
        WEIGHT_RELEVANCE * (relevance / maxRelevance) + WEIGHT_FRESHNESS * freshness(record, now),
    }))
    .sort((a, b) => b.score - a.score);
}

function freshness(record: IndexRecord, now: number): number {
  const updated = Date.parse(record.updatedAt);
  if (Number.isNaN(updated)) return 0;
  const ageDays = Math.max(0, (now - updated) / (1000 * 60 * 60 * 24));
  return 0.5 ** (ageDays / HALF_LIFE_DAYS);
}
