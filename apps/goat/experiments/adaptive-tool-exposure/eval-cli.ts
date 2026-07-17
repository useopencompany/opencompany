import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { runAdaptiveStaticEvaluation, runLiveAdaptiveEvaluation } from "./eval";
import { renderAdaptiveEvalReport } from "./eval-report";
import { selectAdaptiveEvalTasks } from "./eval-tasks";

type Options = {
  command: "analyze" | "live";
  model: string;
  repetitions: number;
  taskIds: string[];
  output: string;
  report?: string;
};

function positiveInteger(value: string, flag: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`${flag} must be a positive integer.`);
  return parsed;
}

function parseArgs(argv: readonly string[]): Options {
  const command = argv[0] === "live" ? "live" : "analyze";
  const options: Options = {
    command,
    model: "anthropic/claude-sonnet-5",
    repetitions: 1,
    taskIds: ["all"],
    output: resolve(".context/adaptive-tool-exposure-eval.json"),
  };
  for (
    let index = argv[0] === "live" || argv[0] === "analyze" ? 1 : 0;
    index < argv.length;
    index += 2
  ) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--model" && value) options.model = value;
    else if (flag === "--repetitions" && value) options.repetitions = positiveInteger(value, flag);
    else if (flag === "--tasks" && value) options.taskIds = value.split(",").filter(Boolean);
    else if (flag === "--output" && value) options.output = resolve(value);
    else if (flag === "--report" && value) options.report = resolve(value);
    else throw new Error(`Unknown or incomplete argument: ${flag ?? "(missing)"}`);
  }
  return options;
}

async function write(path: string, contents: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
}

function help() {
  console.log(`Adaptive tool exposure evaluation

Usage:
  bun run eval-cli.ts analyze [--tasks all|id,id] [--output PATH] [--report PATH]
  bun run eval-cli.ts live [--model MODEL] [--tasks all|id,id] [--repetitions N] [--output PATH] [--report PATH]

The live command requires VERCEL_AI_GATEWAY_API_KEY. Tool execution remains simulated.`);
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    help();
    return;
  }
  const options = parseArgs(process.argv.slice(2));
  const tasks = selectAdaptiveEvalTasks(options.taskIds);
  const staticEvaluation = runAdaptiveStaticEvaluation({ tasks });
  if (options.command === "analyze") {
    await write(options.output, `${JSON.stringify({ staticEvaluation }, null, 2)}\n`);
    const report = renderAdaptiveEvalReport({ staticEvaluation });
    if (options.report) await write(options.report, report);
    console.log(JSON.stringify(staticEvaluation, null, 2));
    console.log(`Static result: ${options.output}`);
    if (options.report) console.log(`Report: ${options.report}`);
    return;
  }

  const gatewayApiKey = process.env.VERCEL_AI_GATEWAY_API_KEY?.trim();
  if (!gatewayApiKey)
    throw new Error("VERCEL_AI_GATEWAY_API_KEY is required for the live evaluation.");
  const liveRun = await runLiveAdaptiveEvaluation({
    gatewayApiKey,
    model: options.model,
    repetitions: options.repetitions,
    tasks,
    onProgress: (message) => console.log(message),
  });
  await write(options.output, `${JSON.stringify({ staticEvaluation, liveRun }, null, 2)}\n`);
  const report = renderAdaptiveEvalReport({ staticEvaluation, liveRun });
  if (options.report) await write(options.report, report);
  console.log(JSON.stringify({ summaries: liveRun.summaries }, null, 2));
  console.log(`Raw result: ${options.output}`);
  if (options.report) console.log(`Report: ${options.report}`);
}

await main();
