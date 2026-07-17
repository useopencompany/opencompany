import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { MOCK_CATALOG_STATS } from "../code-tool-interface/catalog";
import { ALL_EXPERIMENT_TASKS, BENCHMARK_TASKS } from "../code-tool-interface/tasks";
import type { BenchmarkTask } from "../code-tool-interface/types";
import { runProgressiveBenchmarkTask } from "./benchmark";
import { renderProgressiveReport } from "./report";
import type { ProgressiveBenchmarkFile } from "./types";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  printHelp();
  process.exit(0);
}

const args = parseArgs(process.argv.slice(2));
const apiKey = process.env.VERCEL_AI_GATEWAY_API_KEY?.trim();
if (!apiKey) {
  throw new Error(
    "VERCEL_AI_GATEWAY_API_KEY is required. Run through the repository's development environment or export a development Gateway key.",
  );
}

const runs: ProgressiveBenchmarkFile["runs"] = [];
const total = args.tasks.length * args.repeats;
let completed = 0;
for (let repeat = 0; repeat < args.repeats; repeat += 1) {
  for (const task of args.tasks) {
    completed += 1;
    console.log(`[${completed}/${total}] progressive/${task.id} (repeat ${repeat + 1})`);
    const run = await runProgressiveBenchmarkTask({
      task,
      model: args.model,
      apiKey,
    });
    runs.push(run);
    console.log(
      `  ${run.success ? "PASS" : "FAIL"} · ${run.usage.totalTokens} tokens · ${run.modelRoundTrips} model RT · ${run.loadedTools.length}/${run.invokedTools.length} loaded/invoked`,
    );
    if (!run.success) console.log(`  ${run.failureReasons.join("; ")}`);
  }
}

const file: ProgressiveBenchmarkFile = {
  schemaVersion: "goat.progressive-typed-code.benchmark.v1",
  createdAt: new Date().toISOString(),
  model: args.model,
  repeats: args.repeats,
  catalog: MOCK_CATALOG_STATS,
  tasks: args.tasks,
  runs,
};
const outputPath = resolve(args.outputPath ?? defaultOutputPath(file.createdAt));
const reportPath = outputPath.replace(/\.json$/i, ".md");
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
await writeFile(reportPath, renderProgressiveReport(file), "utf8");
console.log(`\nRaw results: ${outputPath}`);
console.log(`Report: ${reportPath}`);

function parseArgs(argv: string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const [key, inlineValue] = arg.slice(2).split("=", 2);
    const value = inlineValue ?? argv[++index];
    if (!key || !value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    values.set(key, value);
  }

  const taskIds = values
    .get("tasks")
    ?.split(",")
    .map((value) => value.trim());
  const tasks: BenchmarkTask[] = taskIds
    ? taskIds.map((id) => {
        const task = ALL_EXPERIMENT_TASKS.find((candidate) => candidate.id === id);
        if (!task) throw new Error(`Unknown task id: ${id}`);
        return task;
      })
    : BENCHMARK_TASKS;
  const repeats = Number.parseInt(values.get("repeats") ?? "1", 10);
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) {
    throw new Error("--repeats must be an integer from 1 to 20.");
  }
  return {
    tasks,
    repeats,
    model: values.get("model") ?? "anthropic/claude-sonnet-5",
    outputPath: values.get("out"),
  };
}

function printHelp() {
  console.log(`Progressive typed-code benchmark

Usage:
  bun run experiments/progressive-typed-code/run.ts [options]

Options:
  --model MODEL       Gateway model id (default: anthropic/claude-sonnet-5)
  --tasks LIST        Shared task ids or fault-recover-tool-error (default: shared 15)
  --repeats N         Repetitions from 1 to 20 (default: 1)
  --out PATH          Raw JSON output; Markdown is written beside it
`);
}

function defaultOutputPath(createdAt: string) {
  const stamp = createdAt.replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
  return `.context/progressive-typed-code/${stamp}.json`;
}
