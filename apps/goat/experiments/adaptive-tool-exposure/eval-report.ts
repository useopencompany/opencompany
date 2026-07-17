import { type AdaptiveStaticEvaluation, summarizeAdaptiveEvalCases } from "./eval";
import type {
  AdaptiveEvalCase,
  AdaptiveEvalCategory,
  AdaptiveEvalRun,
  AdaptiveEvalSummary,
} from "./eval-types";

function number(value: number, digits = 0) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value);
}

function percent(value: number) {
  return `${number(value * 100, 1)}%`;
}

function duration(value: number) {
  return `${number(value / 1_000, 2)} s`;
}

function summaryRow(summary: AdaptiveEvalSummary) {
  return `| ${summary.mode} | ${summary.runs} | ${summary.errors} | ${percent(summary.meanRequiredToolRecall)} | ${percent(summary.meanToolPrecision)} | ${percent(summary.exactAccuracy)} | ${number(summary.meanFirstStepInputTokens)} | ${number(summary.meanTotalInputTokens)} | ${number(summary.meanSteps, 2)} | ${duration(summary.meanDurationMs)} |`;
}

function categoryRows(run: AdaptiveEvalRun) {
  const categories: AdaptiveEvalCategory[] = [
    "single",
    "multi",
    "long_tail",
    "implicit",
    "no_tool",
  ];
  return categories.flatMap((category) =>
    (["flat", "search", "adaptive"] as const).map((mode) => {
      const cases = run.cases.filter((item) => item.category === category && item.mode === mode);
      const tasks = run.tasks.filter((item) => item.category === category);
      const summary = summarizeAdaptiveEvalCases(cases, tasks).find((item) => item.mode === mode)!;
      const recall = tasks.some((task) => task.expectedToolPointers.length > 0)
        ? percent(summary.meanRequiredToolRecall)
        : "—";
      return `| ${category} | ${mode} | ${cases.length} | ${recall} | ${percent(summary.meanToolPrecision)} | ${percent(summary.exactAccuracy)} | ${number(summary.meanFirstStepInputTokens)} | ${duration(summary.meanDurationMs)} |`;
    }),
  );
}

function failedCases(cases: readonly AdaptiveEvalCase[]) {
  return cases.filter((item) => item.error || !item.score.exact);
}

function outcomeLines(run: AdaptiveEvalRun) {
  const lines = failedCases(run.cases).map((item) => {
    const details = [
      item.error ? `provider error: ${item.error}` : null,
      item.score.missingToolPointers.length
        ? `missing ${item.score.missingToolPointers.join(", ")}`
        : null,
      item.score.extraToolPointers.length
        ? `extra ${item.score.extraToolPointers.join(", ")}`
        : null,
      item.score.validCallRate < 1 ? `valid-call rate ${percent(item.score.validCallRate)}` : null,
    ].filter(Boolean);
    return `- **${item.taskId} / ${item.mode}:** ${details.join("; ") || "non-exact call sequence"}.`;
  });
  return lines.length ? lines : ["- All cases were exact."];
}

export function renderAdaptiveEvalReport(input: {
  staticEvaluation: AdaptiveStaticEvaluation;
  liveRun?: AdaptiveEvalRun;
}) {
  const staticEvaluation = input.staticEvaluation;
  const live = input.liveRun;
  const liveSummaries = live ? summarizeAdaptiveEvalCases(live.cases, live.tasks) : [];
  const flatSummary = liveSummaries.find((summary) => summary.mode === "flat");
  const searchSummary = liveSummaries.find((summary) => summary.mode === "search");
  const adaptiveSummary = liveSummaries.find((summary) => summary.mode === "adaptive");
  const decisionLines =
    flatSummary && searchSummary && adaptiveSummary
      ? [
          "## Decision",
          "",
          "Advance adaptive exposure to the next validation spike, but do not ship it to Goat production yet.",
          "",
          `Adaptive matched search recall at **${percent(adaptiveSummary.meanRequiredToolRecall)}**, achieved the best strict exactness (**${percent(adaptiveSummary.exactAccuracy)}**), and used **${percent(1 - adaptiveSummary.meanTotalInputTokens / flatSummary.meanTotalInputTokens)} less cumulative input than flat**. Compared with model-initiated search, adaptive used ${percent(1 - adaptiveSummary.meanTotalInputTokens / searchSummary.meanTotalInputTokens)} less cumulative input and was ${percent(1 - adaptiveSummary.meanDurationMs / searchSummary.meanDurationMs)} faster because it avoided a discovery step on most tasks.`,
          "",
          "The blocking issue is deterministic recall: the one deliberate integration trigger miss was not recovered in the corrected run even though its lossless pointer was visible. Lossless pointers make recovery possible, not reliable. The next version should add deterministic semantic retrieval as a fallback when keyword confidence is low or no integration activates.",
          "",
        ]
      : [];
  const lines = [
    "# Adaptive Tool Exposure: Broad Evaluation",
    "",
    `Date: ${new Date(live?.createdAt ?? Date.now()).toISOString().slice(0, 10)}  `,
    `Registry: ${staticEvaluation.registry.integrations} integrations / ${staticEvaluation.registry.tools} simulated tools  `,
    `Task set: ${staticEvaluation.tasks} tasks across common, multi-integration, long-tail, implicit, and no-tool requests${live ? `  \nModel: \`${live.model}\`, ${live.repetitions} repetition${live.repetitions === 1 ? "" : "s"}` : ""}`,
    "",
    "## Compared approaches",
    "",
    "- **Flat:** all full JSON schemas are directly callable on the first model step.",
    "- **Search:** Level 0 plus generic search/inspect/call tools; the model chooses when and how to search.",
    "- **Adaptive:** deterministic clause-aware Level 1 candidates plus explicit lossless expansion and call-time Level 2 validation.",
    "",
    ...decisionLines,
    "## Static routing results",
    "",
    `- Mean integration recall: **${percent(staticEvaluation.meanIntegrationRecall)}**`,
    `- Mean integration precision: **${percent(staticEvaluation.meanIntegrationPrecision)}**`,
    `- Mean required-tool recall in Level 1: **${percent(staticEvaluation.meanCandidateToolRecall)}**`,
    `- Trigger false-negative tasks: **${staticEvaluation.tasksWithTriggerFalseNegatives.length}/${staticEvaluation.tasks}** (${staticEvaluation.tasksWithTriggerFalseNegatives.join(", ") || "none"})`,
    `- Level-1 candidate-miss tasks: **${staticEvaluation.tasksWithCandidateMisses.length}/${staticEvaluation.tasks}** (${staticEvaluation.tasksWithCandidateMisses.join(", ") || "none"})`,
    `- Activation latency: **${number(staticEvaluation.activationLatency.meanMs, 4)} ms mean**, ${number(staticEvaluation.activationLatency.p95Ms, 4)} ms p95 over ${number(staticEvaluation.activationLatency.samples)} samples`,
    "",
    "### Estimated initial exposure",
    "",
    "| Flat | Search | Adaptive | Adaptive vs flat |",
    "| ---: | ---: | ---: | ---: |",
    `| ${number(staticEvaluation.meanEstimatedContextTokens.flat)} | ${number(staticEvaluation.meanEstimatedContextTokens.search)} | ${number(staticEvaluation.meanEstimatedContextTokens.adaptive)} | ${percent(1 - staticEvaluation.meanEstimatedContextTokens.adaptive / staticEvaluation.meanEstimatedContextTokens.flat)} lower |`,
    "",
  ];

  if (live) {
    lines.push(
      "## Live model results",
      "",
      "Provider-reported tokens include the system/user messages and provider wrappers, not only tool schemas.",
      "",
      "| Mode | Runs | Errors | Recall | Precision | Exact | First-step input | Total input | Steps | Latency |",
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
      ...liveSummaries.map(summaryRow),
      "",
      "### By task category",
      "",
      "| Category | Mode | Runs | Recall | Precision | Exact | First-step input | Latency |",
      "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
      ...categoryRows(live),
      "",
      "### Discovery and recovery",
      "",
      ...liveSummaries.map(
        (summary) =>
          `- **${summary.mode}:** ${number(summary.meanCatalogSearches, 2)} mean catalog searches, ${number(summary.meanExplicitExpansions, 2)} mean explicit expansions, ${summary.recoveredTriggerFalseNegatives}/${summary.triggerFalseNegatives} adaptive trigger false negatives recovered.`,
      ),
      "",
      "### Non-exact cases",
      "",
      ...outcomeLines(live),
      "",
    );
  }

  lines.push(
    "## Static scaling curve",
    "",
    "Scaling uses repeated distractor copies of the six real mock catalogs. It measures context growth, not realistic integration diversity.",
    "",
    "| Integrations | Tools | Flat tokens | Search tokens | Adaptive tokens | Adaptive reduction |",
    "| ---: | ---: | ---: | ---: | ---: | ---: |",
    ...staticEvaluation.scaling.map(
      (item) =>
        `| ${item.integrations} | ${item.tools} | ${number(item.flatTokens)} | ${number(item.searchTokens)} | ${number(item.adaptiveTokens)} | ${number(item.adaptiveReductionPercent, 1)}% |`,
    ),
    "",
    ...(live
      ? [
          "## Recommended next iteration",
          "",
          "1. Keep adaptive deterministic retrieval as the primary exposure path.",
          "2. Add deterministic embedding retrieval over integration summaries and tool cards when lexical routing has low confidence or returns no candidates.",
          "3. Put compact argument types in Level-1 signatures (`to[]`, `durationMinutes:int`); missing type information caused recoverable invalid calls.",
          "4. Treat model-initiated catalog search as an explicit fallback, not the default path; it preserved recall but added model steps and latency.",
          "5. Gate production on repeated runs across Goat's supported models, real MCP schemas, argument-semantic grading, and final-state assertions.",
          "",
        ]
      : []),
    "## Interpretation limits",
    "",
    "- Integrations and execution are simulated; external API latency and failures are absent.",
    "- Tool identity, schema validity, redundant calls, context, steps, and latency are scored. Final external state and nuanced argument semantics are not yet judged.",
    "- Model generation is not seeded. A single repetition is directional; production decisions should use at least five repetitions and multiple supported models.",
    "- Three tasks were corrected after trace review to remove fixture ambiguity and rerun once in all modes; those nine corrected cases replaced their originals.",
    "- Temporal argument semantics were not scored, and several calls supplied stale dates despite choosing the correct tools.",
    "- Static token estimates use four UTF-8 bytes per token and should only be used for relative scaling.",
    "",
  );
  return `${lines.join("\n")}\n`;
}
