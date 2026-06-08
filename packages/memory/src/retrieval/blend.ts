import type { IndexRecord } from "./corpus";

// Position/recency-aware blend. The fused relevance score is combined with a recency score
// that decays with the age of the compiled truth (its `updated_at`), so a slightly-less-relevant
// but current record can edge out a stale one. Weights are deliberately gentle (relevance dominates).
const WEIGHT_RELEVANCE = 0.8;
const WEIGHT_RECENCY = 0.2;
const HALF_LIFE_DAYS = 90;

export function recencyScore(record: IndexRecord, now: number): number {
  if (!record.updatedAt) return 0;
  const updated = Date.parse(record.updatedAt);
  if (Number.isNaN(updated)) return 0;
  const ageDays = Math.max(0, (now - updated) / (1000 * 60 * 60 * 24));
  const decay = 0.5 ** (ageDays / HALF_LIFE_DAYS);
  // Deprecated records are pushed down; everything else rides the decay curve.
  return record.status === "deprecated" ? decay * 0.25 : decay;
}

// Normalize relevance scores to [0,1] (max-scaling) so the recency term is comparable across
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
        WEIGHT_RECENCY * recencyScore(record, now),
    }))
    .sort((a, b) => b.score - a.score);
}
