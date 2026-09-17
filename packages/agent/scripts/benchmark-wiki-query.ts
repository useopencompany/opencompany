import { open, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { queryWiki } from "@opencompany/wiki";
import { createWikiQueryEvaluator } from "../src/wiki-query-evaluator";

// Private snapshots and labels stay outside git. Results include paths; publish
// only aggregate metrics and anonymized question IDs in the public report.
const [datasetPath, questionsPath, outputPath, repeatsArg = "3"] = process.argv.slice(2);
if (!datasetPath || !questionsPath || !outputPath)
  throw new Error(
    "Usage: benchmark-wiki-query.ts dataset.json questions.json output.json [repeats]",
  );
const dataset = JSON.parse(await readFile(datasetPath, "utf8"));
const questions = JSON.parse(await readFile(questionsPath, "utf8"));
const repeats = Number(repeatsArg);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 5 || questions.length > 20)
  throw new Error("Benchmark limited to 20 questions × 5 repetitions.");
const evaluate = createWikiQueryEvaluator(process.env.VERCEL_AI_GATEWAY_API_KEY ?? "");
const rows: unknown[] = [];
// Reserve the full $0.05 query envelope before each run, including failed calls.
// The $0.10 safety allowance covers the initial smoke test and price rounding.
const ledgerPath = join(dirname(outputPath), "budget.json");
const lockPath = `${ledgerPath}.lock`;
const lock = await open(lockPath, "wx", 0o600);
try {
  await writeFile(outputPath, "{}", { flag: "wx", mode: 0o600 });
  let reservedUsd = 0.1;
  try {
    reservedUsd = JSON.parse(await readFile(ledgerPath, "utf8")).reservedUsd;
    if (!Number.isFinite(reservedUsd) || reservedUsd < 0.1)
      throw new Error("Invalid budget ledger");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (let repeat = 0; repeat < repeats; repeat++) {
    for (const question of questions) {
      if (reservedUsd + 0.05 > 5) throw new Error("The $5 experiment budget is exhausted.");
      reservedUsd += 0.05;
      await writeFile(ledgerPath, JSON.stringify({ reservedUsd }), { mode: 0o600 });
      await writeFile(outputPath, JSON.stringify({ reservedUsd, rows }, null, 2));
      const result = await queryWiki({
        question: question.question,
        tree: dataset.nodes.map((node: { path: string; title: string; type: string }) => ({
          path: node.path.replace(/\/$/, ""),
          title: node.title,
          nodeType: node.type,
        })),
        read: async (paths) =>
          dataset.pages
            .filter((page: { path: string }) => paths.includes(page.path))
            .map((page: { path: string; title: string; body: string }) => ({
              path: page.path,
              title: page.title,
              content: page.body,
            })),
        evaluate,
      });
      const hits = new Set(result.matches.map((match) => match.path));
      const anchorRecall = question.anchors.length
        ? question.anchors.filter((path: string) => hits.has(path)).length / question.anchors.length
        : null;
      rows.push({ id: question.id, repeat, anchorRecall, ...result });
      await writeFile(outputPath, JSON.stringify({ reservedUsd, rows }, null, 2));
      console.log(
        JSON.stringify({
          id: question.id,
          repeat,
          anchorRecall,
          matches: result.matches.length,
          ...result.stats,
        }),
      );
    }
  }
} finally {
  await lock.close();
  await unlink(lockPath);
}
