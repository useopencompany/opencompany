// Reciprocal Rank Fusion: combine several ranked id lists into one, rewarding items that rank
// highly across lists without needing their raw scores to be comparable. `k` damps the
// contribution of low ranks (60 is the conventional default).
const RRF_K = 60;

export function reciprocalRankFusion(lists: string[][], k: number = RRF_K): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
    });
  }
  return scores;
}
