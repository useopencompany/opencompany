import { parseWikiInlineLinks } from "./links";

export type WikiQueryNode = { path: string; title: string; nodeType: "page" | "folder" };
export type WikiQueryPage = { path: string; title: string; content: string };
export type WikiQueryEvaluation = {
  probabilities: number[];
  inputTokens: number;
  costUsd: number;
};
export type WikiQueryEvaluator = (input: {
  question: string;
  stage: "navigate" | "verify";
  candidates: Array<{ path: string; title: string; content?: string; nodeType?: string }>;
  signal: AbortSignal;
}) => Promise<WikiQueryEvaluation>;

export class WikiQueryError extends Error {}

// A query is intentionally small and read-only. Source pointers are returned to
// the parent session, whose connector permissions and approvals remain in force.
export async function queryWiki(input: {
  question: string;
  limit?: number;
  tree: WikiQueryNode[];
  read: (paths: string[]) => Promise<WikiQueryPage[]>;
  evaluate: WikiQueryEvaluator;
}) {
  const question = input.question.trim();
  if (!question || question.length > 8_000) {
    throw new WikiQueryError("query requires a detailed question of 1–8,000 characters.");
  }
  const limit = Math.min(10, Math.max(1, Math.floor(input.limit ?? 10)));
  const started = performance.now();
  const signal = AbortSignal.timeout(20_000);
  const nodes = new Map(input.tree.map((node) => [node.path.replace(/\/$/, ""), node]));
  const children = new Map<string, WikiQueryNode[]>();
  for (const node of nodes.values()) {
    const parent = node.path.split("/").slice(0, -1).join("/");
    const siblings = children.get(parent) ?? [];
    siblings.push(node);
    children.set(parent, siblings);
  }
  const trace: Array<{ stage: string; candidates: number; durationMs: number }> = [];
  let calls = 0;
  let costUsd = 0;
  let inputTokens = 0;
  let reservedUsd = 0;
  let truncated = false;
  const visited = new Set<string>();
  const matches: Array<{ path: string; title: string; relevance: number; sources: string[] }> = [];

  async function score(
    stage: "navigate" | "verify",
    candidates: Parameters<WikiQueryEvaluator>[0]["candidates"],
  ) {
    const scores: Array<{ path: string; probability: number }> = [];
    const batchSize = stage === "navigate" ? 32 : 8;
    for (let i = 0; i < candidates.length; i += batchSize) {
      const batch = candidates.slice(i, i + batchSize);
      // Reserve conservatively before dispatch: one token per UTF-8 byte,
      // doubled for provider overhead, at $0.04/M input tokens. No retries.
      const reserve =
        ((new TextEncoder().encode(JSON.stringify({ question, batch })).length * 2 + 16_000) *
          0.04) /
        1_000_000;
      if (calls >= 20 || reservedUsd + reserve > 0.05 || signal.aborted) {
        truncated = true;
        break;
      }
      reservedUsd += reserve;
      calls++;
      const start = performance.now();
      const result = await input.evaluate({ question, stage, candidates: batch, signal });
      if (
        result.probabilities.length !== batch.length ||
        result.probabilities.some((p) => !Number.isFinite(p) || p < 0 || p > 1) ||
        !Number.isFinite(result.costUsd) ||
        result.costUsd < 0
      ) {
        throw new WikiQueryError("The wiki query model returned an invalid evaluation.");
      }
      costUsd += result.costUsd;
      inputTokens += result.inputTokens;
      if (costUsd > 0.05) throw new WikiQueryError("Wiki query exceeded its cost limit.");
      trace.push({
        stage,
        candidates: batch.length,
        durationMs: Math.round(performance.now() - start),
      });
      batch.forEach((candidate, index) =>
        scores.push({ path: candidate.path, probability: result.probabilities[index]! }),
      );
    }
    return scores.sort((a, b) => b.probability - a.probability || a.path.localeCompare(b.path));
  }

  let frontier = children.get("") ?? [];
  const candidates = new Map<string, number>();
  for (let depth = 0; frontier.length && depth <= 10; depth++) {
    const scores = await score(
      "navigate",
      frontier.map(({ path, title, nodeType }) => ({ path, title: title.slice(0, 200), nodeType })),
    );
    const folders: string[] = [];
    for (const score of scores) {
      if (score.probability < 0.35) continue;
      if (nodes.get(score.path)?.nodeType === "folder") folders.push(score.path);
      else candidates.set(score.path, score.probability);
    }
    if (folders.length > 8) truncated = true;
    frontier = folders.slice(0, 8).flatMap((path) => children.get(path) ?? []);
    if (truncated && calls >= 20) break;
  }
  let pending = [...candidates].sort((a, b) => b[1] - a[1]).map(([path]) => path);
  for (let round = 0; round < 3 && pending.length; round++) {
    const remaining = 48 - visited.size;
    if (pending.length > remaining) truncated = true;
    const paths = [...new Set(pending)]
      .filter((path) => !visited.has(path) && nodes.get(path)?.nodeType === "page")
      .slice(0, remaining);
    if (!paths.length || signal.aborted) {
      truncated ||= signal.aborted;
      break;
    }
    paths.forEach((path) => visited.add(path));
    const pages = await input.read(paths);
    const allowed = new Set(paths);
    const scopedPages = pages.filter((page) => allowed.has(page.path));
    if (scopedPages.some((page) => page.content.length > 12_000)) truncated = true;
    const scores = await score(
      "verify",
      scopedPages.map((page) => ({
        path: page.path,
        title: page.title.slice(0, 200),
        content: page.content.slice(0, 12_000),
      })),
    );
    pending = [];
    for (const score of scores) {
      const page = scopedPages.find((page) => page.path === score.path)!;
      const links = parseWikiInlineLinks(page.content.slice(0, 12_000)).filter(
        (link) => link.valid,
      );
      if (score.probability >= 0.7) {
        matches.push({
          path: page.path,
          title: page.title,
          relevance: score.probability,
          sources: [
            ...new Set(links.filter((link) => link.kind === "source").map((link) => link.target)),
          ].slice(0, 10),
        });
      }
      if (score.probability >= 0.35) {
        for (const link of links.filter((link) => link.kind === "page")) {
          const exact = nodes.get(link.target);
          const byName = exact
            ? [exact]
            : [...nodes.values()].filter((node) => node.path.split("/").at(-1) === link.target);
          if (byName.length === 1 && !visited.has(byName[0]!.path)) pending.push(byName[0]!.path);
        }
      }
    }
  }
  if (pending.some((path) => !visited.has(path))) truncated = true;
  return {
    matches: matches
      .sort((a, b) => b.relevance - a.relevance || a.path.localeCompare(b.path))
      .slice(0, limit),
    stats: {
      model: "typesafe-ai/jev",
      durationMs: Math.round(performance.now() - started),
      calls,
      pagesRead: visited.size,
      inputTokens,
      costUsd,
      truncated,
    },
    trace,
    hint: "Read the matched pages for evidence. Source pointers have not been opened; use the parent session's authorized connectors. Relevance is an uncalibrated model score, not a guarantee of completeness.",
  };
}
