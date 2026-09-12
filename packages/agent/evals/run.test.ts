import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrialInput } from "./harness";
import type { Report } from "./report";
import type { Trial } from "./types";

const state = vi.hoisted(() => ({ calls: 0, hash: "config" }));
vi.mock("./harness", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./harness")>();
  return {
    ...actual,
    runTrial: async (input: TrialInput): Promise<Trial> => {
      if (!input.inspectOnly) state.calls++;
      const result: Trial = {
        scenario: input.scenario.id,
        scenarioFingerprint: actual.scenarioFingerprint(input.scenario),
        model: input.model,
        provider: "moonshotai",
        variant: input.variant,
        repeat: input.repeat,
        attempt: input.attempt ?? 1,
        fingerprint: state.hash,
        status: input.inspectOnly ? "interrupted" : "passed",
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
      };
      if (!input.inspectOnly) {
        input.budget.record(0.01);
        await input.checkpoint?.(result);
      }
      return result;
    },
  };
});

import { scenarioFingerprint } from "./harness";
import { main, readReport, writeReport } from "./run";
import { scenarios } from "./scenarios";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-bench-"));
  state.calls = 0;
  state.hash = "config";
  vi.stubEnv("VERCEL_AI_GATEWAY_API_KEY", "synthetic-key");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "table").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});
function emptyReport(): Report {
  return {
    schemaVersion: "opencompany.bench.v1",
    createdAt: "2026-09-12",
    config: {
      scenarios: ["unavailable"],
      models: ["moonshotai/kimi-k2.6"],
      variants: ["v5"],
      k: 2,
    },
    fingerprints: { "unavailable|moonshotai/kimi-k2.6|v5": "config" },
    scenarioFingerprints: {
      unavailable: scenarioFingerprint(scenarios.find((s) => s.id === "unavailable")!),
    },
    trials: [],
    totalCostUsd: 0,
    stopped: null,
  };
}
describe("durable benchmark runs", () => {
  it("lists without credentials, generation or report writes", async () => {
    vi.stubEnv("VERCEL_AI_GATEWAY_API_KEY", "");
    expect(await main(["--list"])).toBe(0);
    expect(state.calls).toBe(0);
  });
  it("stops at a zero budget, resumes unfinished jobs and skips completed jobs", async () => {
    const path = join(dir, "resume.json");
    await writeReport(path, emptyReport());
    expect(await main(["--resume", path, "--budget-usd", "0"])).toBe(2);
    expect(state.calls).toBe(0);
    expect(await main(["--resume", path, "--budget-usd", "1", "--concurrency", "2"])).toBe(0);
    expect(state.calls).toBe(2);
    expect((await readReport(path)).totalCostUsd).toBe(0.02);
    expect(await main(["--resume", path, "--budget-usd", "1", "--compare", path])).toBe(0);
    expect(state.calls).toBe(2);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Fingerprints match"));
  });
  it("retains interrupted attempts and their costs when resuming", async () => {
    const path = join(dir, "resume.json");
    await writeReport(path, emptyReport());
    await main(["--resume", path]);
    const previous = await readReport(path);
    previous.trials[1]!.status = "interrupted";
    await writeReport(path, previous);
    state.calls = 0;
    expect(await main(["--resume", path])).toBe(0);
    const resumed = await readReport(path);
    expect(state.calls).toBe(1);
    expect(resumed.trials).toHaveLength(3);
    expect(resumed.trials[2]).toMatchObject({ repeat: 1, attempt: 2 });
    expect(resumed.totalCostUsd).toBe(0.03);
  });
  it("rejects config or fingerprint changes before generation and preserves the report", async () => {
    const path = join(dir, "resume.json");
    await writeReport(path, emptyReport());
    const before = await readFile(path, "utf8");
    await expect(main(["--resume", path, "--k", "3"])).rejects.toThrow("Cannot change --k");
    state.hash = "changed";
    await expect(main(["--resume", path])).rejects.toThrow("fingerprint changed");
    expect(state.calls).toBe(0);
    expect(await readFile(path, "utf8")).toBe(before);
  });
  it("validates reports and refuses to replace a baseline with an incomplete run", async () => {
    const path = join(dir, "resume.json");
    const baseline = join(dir, "baseline.json");
    await writeReport(path, emptyReport());
    await writeFile(baseline, "keep me");
    await main(["--resume", path, "--budget-usd", "0", "--save-baseline", baseline]);
    expect(await readFile(baseline, "utf8")).toBe("keep me");
    await writeFile(path, JSON.stringify({ ...emptyReport(), totalCostUsd: 100 }));
    await expect(readReport(path)).rejects.toThrow("total does not match");
    await writeFile(path, "{}");
    await expect(readReport(path)).rejects.toThrow();
  });
});
