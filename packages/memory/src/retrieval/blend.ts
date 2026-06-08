import type { IndexRecord } from "./corpus";

// Position/freshness-aware blend. The fused relevance score is combined with a freshness score
// that decays with the age of the compiled truth, so a slightly-less-relevant but current
// record can edge out a stale one. Weights are deliberately gentle (relevance dominates).
const WEIGHT_RELEVANCE = 0.8;
const WEIGHT_FRESHNESS = 0.2;
const HALF_LIFE_DAYS = 90;

// Status multipliers on the freshness term: a `draft` is unfinished (uncited scratch truth), so
// it sits below a comparable `active` record without being hidden; `deprecated` is pushed down
// harder. `merged` stubs are excluded upstream (see retrieval filters), so they never reach here.
const STATUS_FRESHNESS_WEIGHT: Partial<Record<IndexRecord["status"], number>> = {
  draft: 0.5,
  deprecated: 0.25,
};

export function freshnessScore(record: IndexRecord, now: number): number {
  if (!record.updatedAt) return 0;
  const updated = Date.parse(record.updatedAt);
  if (Number.isNaN(updated)) return 0;
  const ageDays = Math.max(0, (now - updated) / (1000 * 60 * 60 * 24));
  const decay = 0.5 ** (ageDays / HALF_LIFE_DAYS);
  return decay * (STATUS_FRESHNESS_WEIGHT[record.status] ?? 1);
}

// Normalize relevance scores to [0,1] (max-scaling) so the freshness term is comparable across
// queries regardless of the raw lexical/fused score magnitude.
export function blend(
  scored: Array<{ record: IndexRecord; relevance: number }>,
  now: number,
): Array<{ record: IndexRecord; score: number }> {
  const maxRelevance = scored.reduce((max, item) => Math.max(max, item.relevance), 0) || 1;
  return scored
    .map(({ record, relevance }) => ({
      record,
      score:
        WEIGHT_RELEVANCE * (relevance / maxRelevance) +
        WEIGHT_FRESHNESS * freshnessScore(record, now),
    }))
    .sort((a, b) => b.score - a.score);
}
