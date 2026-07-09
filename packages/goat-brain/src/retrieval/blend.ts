import type { IndexRecord } from "./corpus";

export const GOAT_BRAIN_WEIGHT_RELEVANCE = 0.85;
export const GOAT_BRAIN_WEIGHT_FRESHNESS = 0.15;
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
        GOAT_BRAIN_WEIGHT_RELEVANCE * (relevance / maxRelevance) +
        GOAT_BRAIN_WEIGHT_FRESHNESS * goatBrainFreshness(record.updatedAt, now),
    }))
    .sort((a, b) => b.score - a.score);
}

// Recency decay shared by every retrieval surface (CLI corpus ranking and the DB read plane).
export function goatBrainFreshness(updatedAt: string | Date, now: number): number {
  const updated = updatedAt instanceof Date ? updatedAt.getTime() : Date.parse(updatedAt);
  if (Number.isNaN(updated)) return 0;
  const ageDays = Math.max(0, (now - updated) / (1000 * 60 * 60 * 24));
  return 0.5 ** (ageDays / HALF_LIFE_DAYS);
}
