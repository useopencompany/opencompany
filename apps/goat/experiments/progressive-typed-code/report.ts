import type { ProgressiveBenchmarkFile, ProgressiveBenchmarkRun } from "./types";

export function renderProgressiveReport(file: ProgressiveBenchmarkFile) {
  const runs = file.runs;
  const successful = runs.filter((run) => run.success);
  const lines = [
    "# Progressive typed-code benchmark",
    "",
    `- Generated: ${file.createdAt}`,
    `- Model: \`${file.model}\``,
    `- Corpus: ${new Set(runs.map((run) => run.taskId)).size} tasks × ${file.repeats} repeat(s)`,
    `- Catalog: ${file.catalog.integrations} integrations, ${file.catalog.tools} tools`,
    "",
    "## Aggregate",
    "",
    "| Success | Input tokens/task | Output tokens/task | Total tokens/task | Model round-trips/task | Discovery calls/task | Completion repairs/task | Execute attempts/task | Loaded/invoked | Over-fetch/task |",
    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    `| ${percent(successful.length / runs.length)} (${successful.length}/${runs.length}) | ${integer(mean(runs, (run) => run.usage.inputTokens))} | ${integer(mean(runs, (run) => run.usage.outputTokens))} | ${integer(mean(runs, (run) => run.usage.totalTokens))} | ${decimal(mean(runs, (run) => run.modelRoundTrips))} | ${decimal(mean(runs, (run) => run.discoveryCalls))} | ${decimal(mean(runs, (run) => run.completionRepairs))} | ${decimal(mean(runs, (run) => run.executeAttempts))} | ${sum(runs, (run) => run.loadedTools.length)}/${sum(runs, (run) => run.invokedTools.length)} | ${decimal(mean(runs, (run) => run.overfetchCount))} |`,
    "",
    "Every successful task includes progressive discovery, a dynamically typed action phase (direct calls and/or bounded programmatic execution), and a final assistant response. Model round-trips therefore count the complete user-visible loop.",
    "",
    "## Per task",
    "",
    "| Task | Pass | Input | Output | Total | Model RT | Discovery | Execute attempts | Loaded | Invoked | Failure |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const run of runs) {
    lines.push(
      `| ${escapeCell(run.taskId)} | ${run.success ? "yes" : "no"} | ${integer(run.usage.inputTokens)} | ${integer(run.usage.outputTokens)} | ${integer(run.usage.totalTokens)} | ${run.modelRoundTrips} | ${run.discoveryCalls} | ${run.executeAttempts} | ${run.loadedTools.length} | ${run.invokedTools.length} | ${escapeCell(run.failureReasons.join("; "))} |`,
    );
  }

  const repaired = runs.filter((run) => run.executeAttempts > 1);
  lines.push("", "## Repairs and policy", "");
  lines.push(
    repaired.length === 0
      ? "No run used the bounded repair attempt."
      : `${repaired.length}/${runs.length} runs used more than one execute attempt.`,
  );
  for (const run of repaired) {
    lines.push(
      `- \`${run.taskId}\`: ${run.sandboxAttempts.map((attempt) => `${attempt.ok ? "ok" : attempt.failureKind}:${attempt.error ?? ""}`).join(" → ")}`,
    );
  }
  const denied = runs.flatMap((run) =>
    run.policyTrace
      .filter((event) => event.decision === "deny")
      .map((event) => ({ taskId: run.taskId, event })),
  );
  lines.push(
    denied.length === 0
      ? "No sandbox invocation was denied by the capability policy."
      : `${denied.length} sandbox invocation(s) were denied by policy:`,
  );
  for (const { taskId, event } of denied) {
    lines.push(`- \`${taskId}/${event.path}\`: ${event.reason}`);
  }

  lines.push("", "## Reliability failures", "");
  const failed = runs.filter((run) => !run.success);
  if (failed.length === 0) lines.push("All runs satisfied the deterministic task oracle.");
  for (const run of failed) {
    lines.push(`- \`${run.taskId}\`: ${run.failureReasons.join("; ")}`);
  }

  lines.push(
    "",
    "## Interpretation guardrails",
    "",
    "- This uses deterministic mock tools. It does not validate real auth, pagination, rate limits, data variance, or approval UX.",
    "- The capability policy is production-shaped, but the Node child plus `node:vm` is not a production multi-tenant isolation boundary.",
    "- Production rollout still requires held-out adversarial and real-shaped integration evaluations; compare multiple models and repetitions rather than relying on one report.",
    "",
  );
  return lines.join("\n");
}

function mean(runs: ProgressiveBenchmarkRun[], read: (run: ProgressiveBenchmarkRun) => number) {
  return runs.length === 0 ? 0 : sum(runs, read) / runs.length;
}

function sum(runs: ProgressiveBenchmarkRun[], read: (run: ProgressiveBenchmarkRun) => number) {
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
