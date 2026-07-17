import { createGateway, generateText, stepCountIs } from "ai";
import { createFlatRuntime, createTieredRuntime, estimateInitialContextTokens } from "./exposure";
import { registryToolCount } from "./registry";
import { scoreToolSelection } from "./scoring";
import type {
  AgentCaseResult,
  BenchmarkTask,
  ExpansionTraceEvent,
  ExposureMode,
  MockIntegration,
  StepMeasurement,
} from "./types";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function callInput(call: unknown): UnknownRecord {
  const value = record(call);
  return record(value.input ?? value.args);
}

function callName(call: unknown): string {
  const value = record(call);
  return String(value.toolName ?? value.name ?? "unknown");
}

function expandedNodesForStep(
  stepIndex: number,
  calls: readonly unknown[],
  initialTrace: readonly ExpansionTraceEvent[],
): string[] {
  const nodes =
    stepIndex === 0
      ? initialTrace
          .filter((event) => event.reason === "deterministic_trigger")
          .map((event) => `L1:${event.integrationId} (deterministic_trigger)`)
      : [];
  for (const call of calls) {
    const name = callName(call);
    const input = callInput(call);
    if (name === "expand_integration") {
      nodes.push(`L1:${String(input.integration ?? "unknown")} (model_request)`);
    } else if (name === "expand_tool") {
      nodes.push(
        `L2:${String(input.integration ?? "unknown")}.${String(input.tool ?? "unknown")} (model_request)`,
      );
    } else if (name === "call_integration_tool") {
      nodes.push(
        `L2:${String(input.integration ?? "unknown")}.${String(input.tool ?? "unknown")} (call_time)`,
      );
    }
  }
  return nodes;
}

function stepMeasurements(steps: readonly unknown[], initialTrace: readonly ExpansionTraceEvent[]) {
  return steps.map((rawStep, index): StepMeasurement => {
    const step = record(rawStep);
    const usage = record(step.usage);
    const calls = Array.isArray(step.toolCalls) ? step.toolCalls : [];
    return {
      step: index,
      inputTokens: finiteNumber(usage.inputTokens),
      outputTokens: finiteNumber(usage.outputTokens),
      totalTokens: finiteNumber(usage.totalTokens),
      modelToolCalls: calls.map(callName),
      expandedNodes: expandedNodesForStep(index, calls, initialTrace),
    };
  });
}

function sumKnown(steps: readonly StepMeasurement[], field: "inputTokens" | "outputTokens") {
  return steps.reduce((total, step) => total + (step[field] ?? 0), 0);
}

export async function runAgentCase(input: {
  task: BenchmarkTask;
  mode: ExposureMode;
  integrations: readonly MockIntegration[];
  model: string;
  gatewayApiKey: string;
  maxSteps?: number;
}): Promise<AgentCaseResult> {
  const runtime =
    input.mode === "flat"
      ? createFlatRuntime(input.integrations)
      : createTieredRuntime(input.task.prompt, input.integrations);
  const initialTrace = [...runtime.expansionTrace];
  const startedAt = performance.now();
  const gateway = createGateway({ apiKey: input.gatewayApiKey });
  const result = await generateText({
    model: gateway(input.model),
    system: runtime.systemPrompt,
    messages: [{ role: "user", content: input.task.prompt }],
    tools: runtime.tools,
    stopWhen: stepCountIs(input.maxSteps ?? 10),
    maxOutputTokens: 800,
  });
  const durationMs = performance.now() - startedAt;
  const steps = stepMeasurements(result.steps, initialTrace);
  const score = scoreToolSelection(input.task, runtime.observedToolCalls);
  const falseNegativeIntegrationIds =
    input.mode === "tiered"
      ? input.task.expectedIntegrationIds.filter(
          (integrationId) => !runtime.trigger.expandedIntegrationIds.includes(integrationId),
        )
      : [];
  const triggerFalseNegative = falseNegativeIntegrationIds.length > 0;
  const recoveredFromTriggerFalseNegative =
    triggerFalseNegative &&
    falseNegativeIntegrationIds.every((integrationId) =>
      runtime.observedToolCalls.some((call) => call.valid && call.integrationId === integrationId),
    );
  // The deterministic trigger only expands Level 0 -> Level 1. Any model-requested
  // Level-2 node is therefore an explicit expansion beyond the auto-expanded view.
  const modelRequestedLevel2OutsideAuto = runtime.expansionTrace.some(
    (event) => event.level === 2 && event.reason === "model_request",
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
    steps,
    totalInputTokens: sumKnown(steps, "inputTokens"),
    totalOutputTokens: sumKnown(steps, "outputTokens"),
    durationMs,
    observedToolCalls: runtime.observedToolCalls,
    expansionTrace: runtime.expansionTrace,
    modelRequestedLevel2OutsideAuto,
    triggerFalseNegative,
    recoveredFromTriggerFalseNegative,
    score,
    finalText: result.text,
  };
}
