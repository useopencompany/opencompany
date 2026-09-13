import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentModelId } from "@opencompany/agent-runtime";
import { z } from "zod";
import { HELP, parseCli } from "./cli";
import { CostBudget, fingerprint, runTrial, scenarioFingerprint } from "./harness";
import {
  caseKey,
  compareReports,
  latestTrials,
  printReport,
  type Report,
  trialKey,
} from "./report";
import { scenarios } from "./scenarios";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const reportSchema = z.object({
  schemaVersion: z.literal("opencompany.bench.v1"),
  createdAt: z.string(),
  config: z.object({
    scenarios: z.array(z.string()).min(1),
    models: z.array(z.string()).min(1),
    variants: z.array(z.enum(["v4", "v5"])).min(1),
    k: z.number().int().positive(),
  }),
  fingerprints: z.record(z.string(), z.string()),
  scenarioFingerprints: z.record(z.string(), z.string()),
  trials: z.array(
    z
      .object({
        scenario: z.string(),
        model: z.string(),
        variant: z.enum(["v4", "v5"]),
        repeat: z.number().int().nonnegative(),
        attempt: z.number().int().positive(),
        status: z.enum(["passed", "failed", "interrupted"]),
        knownCostUsd: z.number().nonnegative(),
        costUsd: z.number().nonnegative().nullable(),
        inputTokens: z.number().nonnegative(),
        outputTokens: z.number().nonnegative(),
        durationMs: z.number().nonnegative(),
        failures: z.array(z.string()),
        scenarioFingerprint: z.string(),
        fingerprint: z.string(),
        provider: z.string(),
        final: z.string(),
        error: z.string().nullable(),
        steps: z.number().int().nonnegative(),
        toolCalls: z.number().int().nonnegative(),
        invalidArguments: z.number().int().nonnegative(),
        executions: z.array(
          z.object({
            action: z.string(),
            params: z.record(z.string(), z.unknown()),
            valid: z.boolean(),
            schemaVisible: z.boolean(),
            approved: z.boolean(),
            success: z.boolean(),
          }),
        ),
        tools: z.array(z.object({ name: z.string(), input: z.unknown(), output: z.unknown() })),
        approvals: z.array(
          z.object({
            count: z.number().int().nonnegative(),
            executionsBeforeApproval: z.number().int().nonnegative(),
          }),
        ),
        debugTrace: z
          .object({ schemaVersion: z.literal("opencompany.chat.debug.v1"), model: z.string() })
          .passthrough()
          .nullable(),
      })
      .passthrough(),
  ),
  totalCostUsd: z.number().nonnegative(),
  stopped: z.string().nullable(),
});
export async function readReport(path: string): Promise<Report> {
  const report = reportSchema.parse(JSON.parse(await readFile(path, "utf8"))) as Report;
  if (
    Math.abs(
      report.totalCostUsd - report.trials.reduce((sum, trial) => sum + trial.knownCostUsd, 0),
    ) > 1e-8
  )
    throw new Error("Report total does not match trial costs.");
  const seen = new Set<string>();
  for (const trial of report.trials) {
    const key = `${trialKey(trial)}|${trial.attempt}`;
    if (
      seen.has(key) ||
      !report.config.scenarios.includes(trial.scenario) ||
      !report.config.models.includes(trial.model) ||
      !report.config.variants.includes(trial.variant) ||
      trial.repeat >= report.config.k ||
      trial.fingerprint !== report.fingerprints[caseKey(trial)] ||
      trial.scenarioFingerprint !== report.scenarioFingerprints[trial.scenario]
    )
      throw new Error("Report contains duplicate or mismatched trial configuration.");
    seen.add(key);
  }
  return report;
}
export async function writeReport(path: string, report: Report) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}
export async function main(args: string[]): Promise<number> {
  let options = parseCli(args);
  if (options.help) {
    console.log(HELP);
    return 0;
  }
  if (options.list) {
    console.table(
      options.scenarios.map((s) => ({ id: s.id, tags: s.tags.join(", "), ...s.budgets })),
    );
    return 0;
  }
  const path = resolve(
    root,
    options.resume ?? `.context/bench/${new Date().toISOString().replaceAll(":", "-")}.json`,
  );
  const previous = options.resume ? await readReport(path) : null;
  if (previous) {
    const inherited = parseCli([
      "--scenarios",
      previous.config.scenarios.join(","),
      "--models",
      previous.config.models.join(","),
      "--variant",
      previous.config.variants.join(","),
      "--k",
      String(previous.config.k),
    ]);
    for (const key of ["scenarios", "models", "variant", "k"] as const)
      if (options.explicit[key] !== undefined) {
        const field = key === "variant" ? "variants" : key;
        if (fingerprint(options[field]) !== fingerprint(inherited[field]))
          throw new Error(`Cannot change --${key} when resuming.`);
      }
    options = {
      ...options,
      scenarios: inherited.scenarios,
      models: inherited.models,
      variants: inherited.variants,
      k: inherited.k,
    };
  }
  const baseline = options.compare ? await readReport(resolve(root, options.compare)) : null;
  const apiKey = process.env.VERCEL_AI_GATEWAY_API_KEY;
  if (!apiKey) throw new Error("VERCEL_AI_GATEWAY_API_KEY is required for this metered benchmark.");
  const report: Report = previous ?? {
    schemaVersion: "opencompany.bench.v1",
    createdAt: new Date().toISOString(),
    config: {
      scenarios: options.scenarios.map((s) => s.id),
      models: options.models,
      variants: options.variants,
      k: options.k,
    },
    fingerprints: {},
    scenarioFingerprints: {},
    trials: [],
    totalCostUsd: 0,
    stopped: null,
  };
  const budget = new CostBudget(options.budgetUsd, report.totalCostUsd);
  const abort = new AbortController();
  const interrupt = () => {
    budget.stopped = "interrupted by user";
    abort.abort();
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  let writes = Promise.resolve();
  const persist = () => {
    report.totalCostUsd = report.trials.reduce((sum, trial) => sum + trial.knownCostUsd, 0);
    report.stopped = budget.stopped;
    // Serialize immutable snapshots: concurrent trials must never overwrite newer evidence.
    const snapshot = structuredClone(report);
    writes = writes.then(() => writeReport(path, snapshot));
    return writes;
  };
  try {
    for (const scenario of options.scenarios) {
      const scenarioHash = scenarioFingerprint(scenario);
      if (previous && report.scenarioFingerprints[scenario.id] !== scenarioHash)
        throw new Error(`Cannot resume: scenario changed (${scenario.id}).`);
      report.scenarioFingerprints[scenario.id] = scenarioHash;
      for (const model of options.models)
        for (const variant of options.variants) {
          const inspected = await runTrial({
            scenario,
            model: model as AgentModelId,
            variant,
            repeat: 0,
            apiKey,
            budget,
            inspectOnly: true,
          });
          if (!inspected.fingerprint)
            throw new Error(`Cannot inspect harness configuration: ${inspected.error}`);
          const key = caseKey(inspected);
          if (previous && report.fingerprints[key] !== inspected.fingerprint)
            throw new Error(`Cannot resume: harness/model fingerprint changed (${key}).`);
          report.fingerprints[key] = inspected.fingerprint;
        }
    }
    await persist();
    const jobs: {
      scenario: (typeof scenarios)[number];
      model: AgentModelId;
      variant: "v4" | "v5";
      repeat: number;
    }[] = [];
    for (let repeat = 0; repeat < options.k; repeat++)
      for (const model of options.models)
        for (const scenario of options.scenarios)
          for (const variant of repeat % 2 ? [...options.variants].reverse() : options.variants) {
            const job = { scenario, model: model as AgentModelId, variant, repeat };
            if (
              !latestTrials(report.trials).some(
                (t) =>
                  trialKey(t) === trialKey({ ...job, scenario: scenario.id }) &&
                  t.status !== "interrupted",
              )
            )
              jobs.push(job);
          }
    console.log(`${jobs.length} pending trials; budget $${options.budgetUsd}; report ${path}`);
    await Promise.all(
      Array.from({ length: Math.min(options.concurrency, jobs.length) }, async () => {
        while (jobs.length && !budget.stopped) {
          try {
            budget.check();
          } catch {
            break;
          }
          const job = jobs.shift()!;
          const key = trialKey({ ...job, scenario: job.scenario.id });
          const attempt = report.trials.filter((t) => trialKey(t) === key).length + 1;
          let index = -1;
          await runTrial({
            ...job,
            attempt,
            apiKey,
            budget,
            signal: abort.signal,
            checkpoint: async (trial) => {
              if (index === -1) {
                index = report.trials.length;
                report.trials.push(structuredClone(trial));
              } else report.trials[index] = structuredClone(trial);
              await persist();
            },
          });
          const trial = report.trials[index]!;
          console.log(
            `${trial.scenario} ${trial.model} ${trial.variant} #${trial.repeat + 1}: ${trial.status} ($${trial.knownCostUsd.toFixed(5)})${trial.failures.length ? ` — ${trial.failures.join(", ")}` : ""}`,
          );
        }
      }),
    );
    await persist();
    printReport(report);
    if (baseline) {
      const comparison = compareReports(report, baseline);
      for (const warning of comparison.warnings) console.warn(warning);
      console.table(comparison.rows);
    }
    const complete = latestTrials(report.trials).filter((t) => t.status !== "interrupted");
    const expected =
      options.k * options.models.length * options.scenarios.length * options.variants.length;
    if (options.saveBaseline) {
      if (complete.length !== expected)
        console.warn("Baseline was not replaced: run is incomplete. Resume the report first.");
      else await writeReport(resolve(root, options.saveBaseline), report);
    }
    if (budget.stopped || complete.length !== expected) {
      console.log(`Resume: bun run bench --resume ${path} --budget-usd <larger cumulative cap>`);
      return 2;
    }
    return complete.every((t) => t.status === "passed") ? 0 : 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    await writes;
  }
}
