import { runAgentCase } from "./agent";
import { createFlatRuntime, createTieredRuntime, estimateInitialContextTokens } from "./exposure";
import { BASE_INTEGRATIONS, createScaledRegistry, registryToolCount } from "./registry";
import { scoreToolSelection } from "./scoring";
import { BENCHMARK_TASKS, SCALE_TASKS } from "./tasks";
import { benchmarkTriggerLatency, matchIntegrations } from "./trigger";
import type {
  AgentCaseResult,
  BenchmarkRun,
  BenchmarkTask,
  ExposureMode,
  MockIntegration,
} from "./types";

export type StaticAnalysis = {
  integrationCount: number;
  toolCount: number;
  taskCount: number;
  triggerIntegrationRecall: number;
  tasksWithTriggerFalseNegative: string[];
  flatEstimatedTokens: number;
  tieredEstimatedTokens: number;
  estimatedTokenReductionPercent: number;
  triggerLatency: ReturnType<typeof benchmarkTriggerLatency>;
  scaling: Array<{
    integrations: number;
    tools: number;
    flatEstimatedTokens: number;
    tieredEstimatedTokens: number;
    reductionPercent: number;
  }>;
};

function mean(values: readonly number[]): number {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

function reduction(flat: number, tiered: number): number {
  return flat === 0 ? 0 : ((flat - tiered) / flat) * 100;
}

export function runStaticAnalysis(
  scaleIntegrationCounts: readonly number[] = [1, 3, 5, 8, 12, 20, 40],
): StaticAnalysis {
  let expectedIntegrations = 0;
  let expandedExpectedIntegrations = 0;
  const tasksWithTriggerFalseNegative: string[] = [];
  for (const task of BENCHMARK_TASKS) {
    const trigger = matchIntegrations(task.prompt, BASE_INTEGRATIONS);
    expectedIntegrations += task.expectedIntegrationIds.length;
    const misses = task.expectedIntegrationIds.filter(
      (integrationId) => !trigger.expandedIntegrationIds.includes(integrationId),
    );
    expandedExpectedIntegrations += task.expectedIntegrationIds.length - misses.length;
    if (misses.length) tasksWithTriggerFalseNegative.push(task.id);
  }

  const taskEstimates = BENCHMARK_TASKS.map((task) => {
    const flat = createFlatRuntime(BASE_INTEGRATIONS);
    const tiered = createTieredRuntime(task.prompt, BASE_INTEGRATIONS);
    return {
      flat: estimateInitialContextTokens(flat, task.prompt),
      tiered: estimateInitialContextTokens(tiered, task.prompt),
    };
  });
  const flatEstimatedTokens = mean(taskEstimates.map((item) => item.flat));
  const tieredEstimatedTokens = mean(taskEstimates.map((item) => item.tiered));

  return {
    integrationCount: BASE_INTEGRATIONS.length,
    toolCount: registryToolCount(BASE_INTEGRATIONS),
    taskCount: BENCHMARK_TASKS.length,
    triggerIntegrationRecall:
      expectedIntegrations === 0 ? 1 : expandedExpectedIntegrations / expectedIntegrations,
    tasksWithTriggerFalseNegative,
    flatEstimatedTokens,
    tieredEstimatedTokens,
    estimatedTokenReductionPercent: reduction(flatEstimatedTokens, tieredEstimatedTokens),
    triggerLatency: benchmarkTriggerLatency(
      BENCHMARK_TASKS.map((task) => task.prompt).join(" "),
      createScaledRegistry(Math.max(...scaleIntegrationCounts)),
    ),
    scaling: scaleIntegrationCounts.map((integrationCount) => {
      const integrations = createScaledRegistry(integrationCount);
      const task = BENCHMARK_TASKS[0]!;
      const flat = estimateInitialContextTokens(createFlatRuntime(integrations), task.prompt);
      const tiered = estimateInitialContextTokens(
        createTieredRuntime(task.prompt, integrations),
        task.prompt,
      );
      return {
        integrations: integrationCount,
        tools: registryToolCount(integrations),
        flatEstimatedTokens: flat,
        tieredEstimatedTokens: tiered,
        reductionPercent: reduction(flat, tiered),
      };
    }),
  };
}

function emptyFailureResult(input: {
  task: BenchmarkTask;
  mode: ExposureMode;
  integrations: readonly MockIntegration[];
  model: string;
  error: unknown;
}): AgentCaseResult {
  const runtime =
    input.mode === "flat"
      ? createFlatRuntime(input.integrations)
      : createTieredRuntime(input.task.prompt, input.integrations);
  const triggerFalseNegative =
    input.mode === "tiered" &&
    input.task.expectedIntegrationIds.some(
      (integrationId) => !runtime.trigger.expandedIntegrationIds.includes(integrationId),
    );
  return {
    taskId: input.task.id,
    category: input.task.category,
    mode: input.mode,
    model: input.model,
    integrationCount: input.integrations.length,
    exposedCallableToolCount: runtime.exposedCallableToolCount,
    registryToolCount: registryToolCount(input.integrations),
    estimatedInitialContextTokens: estimateInitialContextTokens(runtime, input.task.prompt),
    deterministicTrigger: runtime.trigger,
    steps: [],
    totalInputTokens: 0,
    totalOutputTokens: 0,
    durationMs: 0,
    observedToolCalls: [],
    expansionTrace: runtime.expansionTrace,
    modelRequestedLevel2OutsideAuto: false,
    triggerFalseNegative,
    recoveredFromTriggerFalseNegative: false,
    score: scoreToolSelection(input.task, []),
    finalText: "",
    error: input.error instanceof Error ? input.error.message : String(input.error),
  };
}

async function runOne(input: {
  task: BenchmarkTask;
  mode: ExposureMode;
  integrations: readonly MockIntegration[];
  model: string;
  gatewayApiKey: string;
}): Promise<AgentCaseResult> {
  try {
    return await runAgentCase(input);
  } catch (error) {
    return emptyFailureResult({ ...input, error });
  }
}

function modeOrder(index: number, repetition: number): ExposureMode[] {
  return (index + repetition) % 2 === 0 ? ["tiered", "flat"] : ["flat", "tiered"];
}

export async function runLiveBenchmark(input: {
  gatewayApiKey: string;
  model: string;
  tasks?: readonly BenchmarkTask[];
  taskRepetitions?: number;
  scaleIntegrationCounts?: readonly number[];
  onProgress?: (message: string) => void;
}): Promise<BenchmarkRun> {
  const tasks = input.tasks ?? BENCHMARK_TASKS;
  const taskRepetitions = input.taskRepetitions ?? 1;
  const scaleIntegrationCounts = [...(input.scaleIntegrationCounts ?? [1, 3, 5, 8, 12])];
  const mainSuite: AgentCaseResult[] = [];
  const scaleSuite: AgentCaseResult[] = [];

  for (let repetition = 0; repetition < taskRepetitions; repetition += 1) {
    for (const [index, task] of tasks.entries()) {
      for (const mode of modeOrder(index, repetition)) {
        input.onProgress?.(
          `main ${mainSuite.length + 1}/${tasks.length * taskRepetitions * 2}: ${task.id} (${mode})`,
        );
        mainSuite.push(
          await runOne({
            task,
            mode,
            integrations: BASE_INTEGRATIONS,
            model: input.model,
            gatewayApiKey: input.gatewayApiKey,
          }),
        );
      }
    }
  }

  for (const integrationCount of scaleIntegrationCounts) {
    const integrations = createScaledRegistry(integrationCount);
    for (const [index, task] of SCALE_TASKS.entries()) {
      for (const mode of modeOrder(index, integrationCount)) {
        input.onProgress?.(`scale ${integrationCount} integrations: ${task.id} (${mode})`);
        scaleSuite.push(
          await runOne({
            task,
            mode,
            integrations,
            model: input.model,
            gatewayApiKey: input.gatewayApiKey,
          }),
        );
      }
    }
  }

  return {
    schemaVersion: "goat.tool-exposure-benchmark.v1",
    createdAt: new Date().toISOString(),
    model: input.model,
    taskRepetitions,
    scaleIntegrationCounts,
    environment: {
      runtime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.version}`,
      platform: process.platform,
      architecture: process.arch,
    },
    mainSuite,
    scaleSuite,
  };
}

export function summarizeCases(cases: readonly AgentCaseResult[]) {
  return (["tiered", "flat"] as const).map((mode) => {
    const selected = cases.filter((result) => result.mode === mode);
    const successful = selected.filter((result) => !result.error);
    return {
      mode,
      runs: selected.length,
      errors: selected.length - successful.length,
      exactAccuracy: successful.length
        ? successful.filter((result) => result.score.exact).length / successful.length
        : 0,
      meanRecall: mean(successful.map((result) => result.score.recall)),
      meanPrecision: mean(successful.map((result) => result.score.precision)),
      meanInputTokens: mean(successful.map((result) => result.totalInputTokens)),
      meanEstimatedInitialContextTokens: mean(
        successful.map((result) => result.estimatedInitialContextTokens),
      ),
      meanDurationMs: mean(successful.map((result) => result.durationMs)),
      level2RequestRate: successful.length
        ? successful.filter((result) => result.modelRequestedLevel2OutsideAuto).length /
          successful.length
        : 0,
      triggerFalseNegatives: successful.filter((result) => result.triggerFalseNegative).length,
      recoveredTriggerFalseNegatives: successful.filter(
        (result) => result.recoveredFromTriggerFalseNegative,
      ).length,
    };
  });
}
