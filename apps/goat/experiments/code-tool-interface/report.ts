import type { BenchmarkFile, BenchmarkRun, BenchmarkStrategy } from "./types";

const STRATEGIES: BenchmarkStrategy[] = ["execute", "flat", "tiered"];

export function renderBenchmarkReport(file: BenchmarkFile) {
  const lines = [
    "# Code tool-interface benchmark",
    "",
    `- Generated: ${file.createdAt}`,
    `- Model: \`${file.model}\``,
    `- Corpus: ${new Set(file.runs.map((run) => run.taskId)).size} tasks × ${file.repeats} repeat(s)`,
    `- Catalog: ${file.catalog.integrations} integrations, ${file.catalog.tools} tools`,
    "",
    "## Aggregate",
    "",
    "| Strategy | Success | Input tokens/task | Total tokens/task | Model round-trips/task | Tool round-trips/task | Described/invoked | Over-fetch/task |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];

  for (const strategy of STRATEGIES) {
    const runs = file.runs.filter((run) => run.strategy === strategy);
    if (runs.length === 0) continue;
    const described = sum(runs, (run) => run.describedTools.length);
    const invoked = sum(runs, (run) => run.invokedTools.length);
    lines.push(
      `| ${strategy} | ${percent(runs.filter((run) => run.success).length / runs.length)} (${runs.filter((run) => run.success).length}/${runs.length}) | ${integer(mean(runs, (run) => run.usage.inputTokens))} | ${integer(mean(runs, (run) => run.usage.totalTokens))} | ${decimal(mean(runs, (run) => run.modelRoundTrips))} | ${decimal(mean(runs, (run) => run.toolRoundTrips))} | ${described}/${invoked} | ${decimal(mean(runs, (run) => run.overfetchCount))} |`,
    );
  }

  lines.push(
    "",
    "`model round-trips` counts provider requests (AI SDK steps). `tool round-trips` counts model-visible tool calls. Catalog calls made inside one execute program are reported separately as invoked tools and do not add model round-trips.",
    "",
    "## Per task",
    "",
    "| Task | Strategy | Pass | Input | Output | Model RT | Tool RT | Catalog calls | Described | Failure |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
  );

  for (const run of file.runs) {
    lines.push(
      `| ${escapeCell(run.taskId)} | ${run.strategy} | ${run.success ? "yes" : "no"} | ${integer(run.usage.inputTokens)} | ${integer(run.usage.outputTokens)} | ${run.modelRoundTrips} | ${run.toolRoundTrips} | ${run.invokedTools.length} | ${run.describedTools.length} | ${escapeCell(run.failureReasons.join("; "))} |`,
    );
  }

  const executeRuns = file.runs.filter((run) => run.strategy === "execute");
  const codeFailures = executeRuns.filter((run) => run.sandbox && !run.sandbox.ok);
  lines.push(
    "",
    "## Code-generation failures",
    "",
    codeFailures.length === 0
      ? `No sandbox code failures in ${executeRuns.length} execute runs.`
      : `${codeFailures.length}/${executeRuns.length} execute runs failed in the sandbox:`,
  );
  for (const run of codeFailures) {
    lines.push(
      `- \`${run.taskId}\`: ${run.sandbox?.failureKind ?? "unknown"} — ${run.sandbox?.error ?? "unknown error"}`,
    );
  }

  const failedRuns = file.runs.filter((run) => !run.success);
  lines.push("", "## Reliability failures", "");
  if (failedRuns.length === 0) lines.push("All runs satisfied the deterministic task oracle.");
  for (const run of failedRuns) {
    lines.push(`- \`${run.strategy}/${run.taskId}\`: ${run.failureReasons.join("; ")}`);
  }

  lines.push(
    "",
    "## Interpretation guardrails",
    "",
    "- This is a deterministic mock benchmark, not evidence about real integration latency, auth, pagination, or data variance.",
    "- One run per task is directional. Use at least 5 repeats and more than one model before making a product decision.",
    "- The tiered comparator measures lazy search/describe/invoke turns; it is not a full planner-managed LCM implementation.",
    "- The execute sandbox is an R&D boundary only. Node worker isolation plus `node:vm` is not safe for hostile multi-tenant code.",
    "",
  );
  return lines.join("\n");
}

function mean(runs: BenchmarkRun[], read: (run: BenchmarkRun) => number) {
  return runs.length === 0 ? 0 : sum(runs, read) / runs.length;
}

function sum(runs: BenchmarkRun[], read: (run: BenchmarkRun) => number) {
  return runs.reduce((total, run) => total + read(run), 0);
}

function integer(value: number) {
  return Math.round(value).toLocaleString("en-US");
}

function decimal(value: number) {
  return value.toFixed(2);
}

function percent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function escapeCell(value: string) {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}
