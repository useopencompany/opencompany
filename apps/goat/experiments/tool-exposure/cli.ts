import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { runLiveBenchmark, runStaticAnalysis, summarizeCases } from "./benchmark";
import { selectTasks } from "./tasks";

type Options = {
  command: "analyze" | "live";
  model: string;
  output: string;
  taskIds: string[];
  repetitions: number;
  scales: number[];
};

function parsePositiveInteger(value: string, flag: string): number {
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
    output: resolve(".context/tool-exposure-benchmark.json"),
    taskIds: ["all"],
    repetitions: 1,
    scales: [1, 3, 5, 8, 12],
  };
  for (
    let index = command === "live" || argv[0] === "analyze" ? 1 : 0;
    index < argv.length;
    index += 1
  ) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--model" && value) options.model = value;
    else if (flag === "--output" && value) options.output = resolve(value);
    else if (flag === "--tasks" && value) options.taskIds = value.split(",").filter(Boolean);
    else if (flag === "--repetitions" && value) {
      options.repetitions = parsePositiveInteger(value, flag);
    } else if (flag === "--scales" && value) {
      options.scales = value.split(",").map((item) => parsePositiveInteger(item, flag));
    } else {
      throw new Error(`Unknown or incomplete argument: ${flag ?? "(missing)"}`);
    }
    index += 1;
  }
  return options;
}

function printHelp() {
  console.log(`Tool exposure experiment

Usage:
  bun run experiment:tool-exposure -- analyze [--scales 1,3,5,8,12]
  bun run experiment:tool-exposure -- live [--model MODEL] [--tasks all|id,id] [--repetitions N] [--scales 1,3,5] [--output PATH]

The live command requires VERCEL_AI_GATEWAY_API_KEY. The default output is gitignored under .context.`);
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    return;
  }
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "analyze") {
    console.log(JSON.stringify(runStaticAnalysis(options.scales), null, 2));
    return;
  }

  const gatewayApiKey = process.env.VERCEL_AI_GATEWAY_API_KEY?.trim();
  if (!gatewayApiKey) {
    throw new Error("VERCEL_AI_GATEWAY_API_KEY is required for the live benchmark.");
  }
  const run = await runLiveBenchmark({
    gatewayApiKey,
    model: options.model,
    tasks: selectTasks(options.taskIds),
    taskRepetitions: options.repetitions,
    scaleIntegrationCounts: options.scales,
    onProgress: (message) => console.log(message),
  });
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(run, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify(
      { main: summarizeCases(run.mainSuite), scale: summarizeCases(run.scaleSuite) },
      null,
      2,
    ),
  );
  console.log(`Raw result: ${options.output}`);
}

await main();
