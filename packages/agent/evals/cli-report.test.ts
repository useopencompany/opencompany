import { describe, expect, it } from "vitest";
import { DEFAULT_MODELS, parseCli } from "./cli";
import { compareReports, latestTrials, type Report, summarize } from "./report";
import type { Trial } from "./types";

export function sampleTrial(overrides: Partial<Trial> = {}): Trial {
  return {
    scenario: "unavailable",
    scenarioFingerprint: "scenario",
    model: "moonshotai/kimi-k2.6",
    provider: "moonshotai",
    variant: "v5",
    repeat: 0,
    attempt: 1,
    fingerprint: "config",
    status: "passed",
    failures: [],
    error: null,
    final: "Unavailable",
    executions: [],
    tools: [],
    approvals: [],
    inputTokens: 100,
    outputTokens: 20,
    costUsd: 0.01,
    knownCostUsd: 0.01,
    durationMs: 500,
    steps: 1,
    toolCalls: 0,
    invalidArguments: 0,
    debugTrace: null,
    ...overrides,
  };
}
export function sampleReport(trials = [sampleTrial()]): Report {
  return {
    schemaVersion: "opencompany.bench.v1",
    createdAt: "2026-09-12",
    config: {
      scenarios: ["unavailable"],
      models: ["moonshotai/kimi-k2.6"],
      variants: ["v5"],
      k: 1,
    },
    fingerprints: { "unavailable|moonshotai/kimi-k2.6|v5": "config" },
    scenarioFingerprints: { unavailable: "scenario" },
    trials,
    totalCostUsd: trials.reduce((s, t) => s + t.knownCostUsd, 0),
    stopped: null,
  };
}

describe("benchmark CLI", () => {
  it("defaults to four repeats of a small production answer-model set", () => {
    const options = parseCli([]);
    expect(options.k).toBe(4);
    expect(options.models).toEqual(DEFAULT_MODELS);
    expect(options.scenarios).toHaveLength(8);
    expect(options.variants).toEqual(["v5"]);
  });
  it("filters id/tag unions and optional baseline paths", () => {
    const options = parseCli([
      "--scenarios",
      "linear-file-issue,tag:safety",
      "--save-baseline",
      "--compare",
      "old.json",
      "--variant",
      "v4,v5",
    ]);
    expect(options.scenarios.map((s) => s.id)).toEqual([
      "unavailable",
      "approval-resume",
      "linear-file-issue",
      "linear-ambiguous-update",
    ]);
    expect(options.saveBaseline).toBe(".context/bench/baseline.json");
    expect(options.compare).toBe("old.json");
  });
  it.each([
    ["--k", "0"],
    ["--k", "2.5"],
    ["--budget-usd", "NaN"],
    ["--concurrency", "0"],
    ["--models", "unknown/model"],
    ["--scenarios", "tag:missing"],
    ["--variant", "v6"],
    ["--typo"],
  ])("rejects invalid flags before calling a model: %j", (...args) =>
    expect(() => parseCli(args)).toThrow(),
  );
});

describe("benchmark reports", () => {
  it("requires all k trials for pass^k, and includes failed and interrupted costs", () => {
    const trials = [
      sampleTrial({ status: "interrupted" }),
      sampleTrial({ attempt: 2 }),
      sampleTrial({ repeat: 1, status: "failed" }),
    ];
    expect(latestTrials(trials)).toHaveLength(2);
    expect(summarize(trials, 4)).toMatchObject({
      trials: "2/4",
      passK: null,
      passRate: 0.5,
      costUsd: 0.03,
      costPerSuccess: 0.03,
    });
    expect(summarize(trials, 2).passK).toBe(0);
    expect(summarize([sampleTrial(), sampleTrial({ repeat: 1 })], 2).passK).toBe(1);
  });
  it("compares identical cases, warns on matching fingerprints and rejects scenario drift", () => {
    const baseline = sampleReport();
    const current = sampleReport([
      sampleTrial({
        inputTokens: 80,
        outputTokens: 10,
        costUsd: 0.005,
        knownCostUsd: 0.005,
        durationMs: 400,
      }),
    ]);
    const compared = compareReports(current, baseline);
    expect(compared.warnings[0]).toContain("Fingerprints match");
    expect(compared.rows[0]).toMatchObject({
      paired: 1,
      "Δinput/trial": -20,
      "Δoutput/trial": -10,
      "Δ$/trial": -0.005,
      "Δms/trial": -100,
    });
    current.scenarioFingerprints.unavailable = "changed";
    expect(compareReports(current, baseline).rows).toHaveLength(0);
  });
  it("pairs a v5 candidate with a single v4 baseline and flags different models/k", () => {
    const baseline = sampleReport([sampleTrial({ variant: "v4", fingerprint: "old" })]);
    baseline.config.variants = ["v4"];
    baseline.config.k = 4;
    baseline.config.models.push("anthropic/claude-sonnet-5");
    baseline.fingerprints = { "unavailable|moonshotai/kimi-k2.6|v4": "old" };
    const compared = compareReports(sampleReport(), baseline);
    expect(compared.rows[0]).toMatchObject({ variant: "v4 → v5", "Δpass^k": null });
    expect(compared.warnings).toHaveLength(2);
  });
});
