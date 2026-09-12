import type { Trial, Variant } from "./types";
export type RunConfig = { scenarios: string[]; models: string[]; variants: Variant[]; k: number };
export type Report = {
  schemaVersion: "opencompany.bench.v1";
  createdAt: string;
  config: RunConfig;
  fingerprints: Record<string, string>;
  scenarioFingerprints: Record<string, string>;
  trials: Trial[];
  totalCostUsd: number;
  stopped: string | null;
};
export const caseKey = (t: Pick<Trial, "scenario" | "model" | "variant">) =>
  [t.scenario, t.model, t.variant].join("|");
export const trialKey = (t: Pick<Trial, "scenario" | "model" | "variant" | "repeat">) =>
  `${caseKey(t)}|${t.repeat}`;
export function latestTrials(trials: Trial[]): Trial[] {
  const latest = new Map<string, Trial>();
  for (const trial of trials) latest.set(trialKey(trial), trial);
  return [...latest.values()];
}
const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
export function summarize(trials: Trial[], k: number) {
  const latest = latestTrials(trials);
  const complete = latest.filter((t) => t.status !== "interrupted");
  const passed = complete.filter((t) => t.status === "passed").length;
  const known = trials.every((t) => t.costUsd !== null);
  const cost = trials.reduce((sum, t) => sum + t.knownCostUsd, 0);
  return {
    trials: `${complete.length}/${k}`,
    passRate: complete.length ? passed / complete.length : null,
    // One group of k observed trials: all succeed, fail, or not enough observations yet.
    passK: complete.length === k ? Number(passed === k) : null,
    inputTokens: trials.length ? mean(trials.map((t) => t.inputTokens)) : null,
    outputTokens: trials.length ? mean(trials.map((t) => t.outputTokens)) : null,
    costUsd: known ? cost : null,
    costPerSuccess: known && passed ? cost / passed : null,
    p50Ms: trials.length ? median(trials.map((t) => t.durationMs)) : null,
  };
}
export function summarizeModel(report: Report, model: string) {
  const trials = report.trials.filter((t) => t.model === model);
  const cases = report.config.scenarios.flatMap((scenario) =>
    report.config.variants.map((variant) =>
      summarize(
        trials.filter((t) => t.scenario === scenario && t.variant === variant),
        report.config.k,
      ),
    ),
  );
  return {
    model,
    ...summarize(trials, report.config.k * cases.length),
    passK: cases.every((c) => c.passK !== null) ? mean(cases.map((c) => c.passK!)) : null,
  };
}
export function printReport(report: Report) {
  console.table(
    report.trials.map((t) => ({
      scenario: t.scenario,
      model: t.model,
      variant: t.variant,
      trial: t.repeat + 1,
      attempt: t.attempt,
      status: t.status,
      in: t.inputTokens,
      out: t.outputTokens,
      $: t.costUsd === null ? "unknown" : t.costUsd.toFixed(5),
      seconds: (t.durationMs / 1000).toFixed(2),
      steps: t.steps,
      tools: t.toolCalls,
      invalid: t.invalidArguments,
      failures: t.failures.join(", "),
    })),
  );
  const keys = [...new Set(report.trials.map(caseKey))];
  console.table(
    keys.map((key) => ({
      case: key,
      ...summarize(
        report.trials.filter((t) => caseKey(t) === key),
        report.config.k,
      ),
      fingerprint: report.fingerprints[key]?.slice(0, 12),
    })),
  );
  console.table(report.config.models.map((model) => summarizeModel(report, model)));
  console.log(
    `Known gateway cost: $${report.totalCostUsd.toFixed(6)}${report.trials.some((t) => t.costUsd === null) ? " (incomplete cost metadata)" : ""}. ${report.stopped ? `Stopped: ${report.stopped}.` : "Run complete."}`,
  );
}
export function compareReports(
  current: Report,
  baseline: Report,
): { warnings: string[]; rows: Record<string, unknown>[] } {
  const warnings: string[] = [];
  if ([...current.config.models].sort().join() !== [...baseline.config.models].sort().join())
    warnings.push("Model sets differ; only shared cases are paired.");
  if (current.config.k !== baseline.config.k)
    warnings.push("Trial counts differ; pass^k is not comparable.");
  const rows = [];
  for (const scenario of current.config.scenarios)
    for (const model of current.config.models)
      for (const variant of current.config.variants) {
        const key = caseKey({ scenario, model, variant });
        const baseVariant = baseline.config.variants.includes(variant)
          ? variant
          : baseline.config.variants.length === 1
            ? baseline.config.variants[0]!
            : null;
        if (!baseVariant) {
          warnings.push(`No unambiguous baseline variant for ${key}.`);
          continue;
        }
        const baseKey = caseKey({ scenario, model, variant: baseVariant });
        if (!baseline.fingerprints[baseKey]) {
          warnings.push(`No baseline for ${key}.`);
          continue;
        }
        if (baseline.scenarioFingerprints[scenario] !== current.scenarioFingerprints[scenario]) {
          warnings.push(`Scenario changed: ${scenario}; refusing an unpaired comparison.`);
          continue;
        }
        if (current.fingerprints[key] === baseline.fingerprints[baseKey])
          warnings.push(`Fingerprints match for ${key}; configuration is unchanged.`);
        const nowTrials = current.trials.filter((t) => caseKey(t) === key);
        const beforeTrials = baseline.trials.filter((t) => caseKey(t) === baseKey);
        const now = summarize(nowTrials, current.config.k);
        const before = summarize(beforeTrials, baseline.config.k);
        const delta = (a: number | null, b: number | null) =>
          a === null || b === null ? null : a - b;
        const paired = latestTrials(nowTrials).flatMap((n) => {
          const b = latestTrials(beforeTrials).find((t) => t.repeat === n.repeat);
          return b && n.status !== "interrupted" && b.status !== "interrupted" ? [{ n, b }] : [];
        });
        rows.push({
          scenario,
          model,
          variant: `${baseVariant} → ${variant}`,
          paired: paired.length,
          "Δpass^k": current.config.k === baseline.config.k ? delta(now.passK, before.passK) : null,
          "Δinput/trial": paired.length
            ? mean(paired.map(({ n, b }) => n.inputTokens - b.inputTokens))
            : null,
          "Δoutput/trial": paired.length
            ? mean(paired.map(({ n, b }) => n.outputTokens - b.outputTokens))
            : null,
          "Δ$/trial":
            paired.length && paired.every(({ n, b }) => n.costUsd !== null && b.costUsd !== null)
              ? mean(paired.map(({ n, b }) => n.costUsd! - b.costUsd!))
              : null,
          "Δms/trial": paired.length
            ? mean(paired.map(({ n, b }) => n.durationMs - b.durationMs))
            : null,
          fingerprint: `${baseline.fingerprints[baseKey]?.slice(0, 12)} → ${current.fingerprints[key]?.slice(0, 12)}`,
        });
      }
  return { warnings: [...new Set(warnings)], rows };
}
