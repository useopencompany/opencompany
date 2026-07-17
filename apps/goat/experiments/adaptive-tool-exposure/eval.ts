import { createGateway, generateText, jsonSchema, stepCountIs, type ToolSet, tool } from "ai";
import { analyzeAdaptiveToolQuery, renderAdaptiveLevel0 } from "./activation";
import { ADAPTIVE_EVAL_TASKS } from "./eval-tasks";
import type {
  AdaptiveEvalCase,
  AdaptiveEvalMode,
  AdaptiveEvalRun,
  AdaptiveEvalScore,
  AdaptiveEvalSummary,
  AdaptiveEvalTask,
} from "./eval-types";
import { ADAPTIVE_TOOL_REGISTRY } from "./registry";
import {
  adaptiveSystemPrompt,
  createAdaptiveToolRuntime,
  executeAdaptiveSimulatedTool,
} from "./runtime";
import type {
  AdaptiveExposureSnapshot,
  AdaptiveObservedCall,
  AdaptiveStepMeasurement,
  AdaptiveToolDefinition,
} from "./types";

const SEARCH_TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: {
      type: "string",
      description:
        "Describe the operation and object needed, including the integration when known.",
    },
    integration: {
      type: "string",
      description: "Optional integration ID from Level 0.",
    },
  },
  required: ["query"],
} as const;

const CALL_TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    pointer: { type: "string", description: "Exact tool:// pointer returned by search_tools." },
    arguments: { type: "object", additionalProperties: true },
  },
  required: ["pointer", "arguments"],
} as const;

const INSPECT_TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    pointer: { type: "string", description: "Exact tool:// pointer returned by search_tools." },
  },
  required: ["pointer"],
} as const;

type RuntimeTrace = {
  tools: ToolSet;
  calls: AdaptiveObservedCall[];
  catalogSearches: { query: string; integration?: string; resultPointers: string[] }[];
  explicitLevel1Expansions: () => number;
  explicitLevel2Expansions: () => number;
};

type StaticTaskMeasurement = {
  taskId: string;
  category: AdaptiveEvalTask["category"];
  expectedIntegrations: number;
  activatedIntegrations: number;
  integrationRecall: number;
  integrationPrecision: number;
  expectedTools: number;
  candidateTools: number;
  candidateToolRecall: number;
  activationLatencyMs: number;
  falseNegativeIntegrationIds: string[];
  falsePositiveIntegrationIds: string[];
  missingCandidateToolPointers: string[];
};

export type AdaptiveStaticEvaluation = {
  registry: { integrations: number; tools: number };
  tasks: number;
  meanIntegrationRecall: number;
  meanIntegrationPrecision: number;
  meanCandidateToolRecall: number;
  tasksWithTriggerFalseNegatives: string[];
  tasksWithCandidateMisses: string[];
  activationLatency: { meanMs: number; p50Ms: number; p95Ms: number; samples: number };
  meanEstimatedContextTokens: Record<AdaptiveEvalMode, number>;
  taskMeasurements: StaticTaskMeasurement[];
  scaling: Array<{
    integrations: number;
    tools: number;
    flatTokens: number;
    searchTokens: number;
    adaptiveTokens: number;
    adaptiveReductionPercent: number;
  }>;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function estimateTokens(value: unknown) {
  return Math.ceil(new TextEncoder().encode(JSON.stringify(value)).byteLength / 4);
}

function compactLevel0() {
  return ADAPTIVE_TOOL_REGISTRY.map((integration) => ({
    name: integration.name,
    summary: integration.summary,
    pointer: integration.pointer,
  }));
}

function genericSearchSurface() {
  return {
    level0: compactLevel0(),
    engineTools: [
      { name: "search_tools", schema: SEARCH_TOOL_SCHEMA },
      { name: "inspect_tool", schema: INSPECT_TOOL_SCHEMA },
      { name: "call_tool", schema: CALL_TOOL_SCHEMA },
    ],
  };
}

function flatSurface() {
  return ADAPTIVE_TOOL_REGISTRY.flatMap((integration) =>
    integration.tools.map((toolDefinition) => ({
      name: `${integration.id}__${toolDefinition.name}`,
      description: toolDefinition.description,
      inputSchema: toolDefinition.inputSchema,
      example: toolDefinition.example,
    })),
  );
}

export function estimatedContextTokens(mode: AdaptiveEvalMode, snapshot: AdaptiveExposureSnapshot) {
  if (mode === "flat") return estimateTokens(flatSurface());
  if (mode === "search") return estimateTokens(genericSearchSurface());
  return snapshot.estimatedAdaptiveTokens;
}

function words(value: string) {
  return new Set(value.toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) ?? []);
}

function phraseMatch(haystack: string, phrase: string) {
  const normalizedHaystack = haystack.toLowerCase();
  const normalizedPhrase = phrase.toLowerCase();
  return normalizedPhrase.includes(" ")
    ? normalizedHaystack.includes(normalizedPhrase)
    : words(normalizedHaystack).has(normalizedPhrase);
}

function searchScore(toolDefinition: AdaptiveToolDefinition, query: string) {
  let score = 0;
  if (phraseMatch(query, toolDefinition.name.replaceAll("_", " "))) score += 100;
  for (const operation of toolDefinition.operationAliases) {
    if (phraseMatch(query, operation)) score += 45;
  }
  for (const object of toolDefinition.objectAliases) {
    if (phraseMatch(query, object)) score += 24;
  }
  const queryWords = words(query);
  const descriptionWords = words(`${toolDefinition.name} ${toolDefinition.description}`);
  for (const queryWord of queryWords) {
    if (queryWord.length > 2 && descriptionWords.has(queryWord)) score += 5;
  }
  return score;
}

function signature(toolDefinition: AdaptiveToolDefinition) {
  const schema = toolDefinition.inputSchema as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  const required = new Set(schema.required ?? []);
  return Object.keys(schema.properties ?? {})
    .map((name) => (required.has(name) ? name : `${name}?`))
    .join(", ");
}

export function searchAdaptiveToolCatalog(input: {
  query: string;
  integration?: string;
  limit?: number;
}) {
  const integrationFilter = input.integration?.trim().toLowerCase();
  const integrations = integrationFilter
    ? ADAPTIVE_TOOL_REGISTRY.filter(
        (integration) =>
          integration.id === integrationFilter ||
          integration.name.toLowerCase() === integrationFilter ||
          integration.aliases.some((alias) => alias.toLowerCase() === integrationFilter),
      )
    : ADAPTIVE_TOOL_REGISTRY;
  const matches = integrations
    .flatMap((integration) =>
      integration.tools.map((toolDefinition) => ({
        integration,
        toolDefinition,
        score:
          searchScore(toolDefinition, input.query) +
          (phraseMatch(input.query, integration.id) || phraseMatch(input.query, integration.name)
            ? 30
            : 0),
      })),
    )
    .toSorted(
      (left, right) =>
        right.score - left.score ||
        right.toolDefinition.popularity - left.toolDefinition.popularity ||
        left.toolDefinition.pointer.localeCompare(right.toolDefinition.pointer),
    );
  const positiveMatches = matches.filter((match) => match.score > 0);
  return (positiveMatches.length ? positiveMatches : matches)
    .slice(0, input.limit ?? 8)
    .map(({ integration, toolDefinition, score }) => ({
      pointer: toolDefinition.pointer,
      integration: integration.name,
      signature: `${toolDefinition.name}(${signature(toolDefinition)})`,
      description: toolDefinition.description,
      sideEffect: toolDefinition.sideEffect,
      outputKind: toolDefinition.outputKind,
      score,
    }));
}

function fullDefinition(pointer: string) {
  for (const integration of ADAPTIVE_TOOL_REGISTRY) {
    const toolDefinition = integration.tools.find((tool) => tool.pointer === pointer);
    if (!toolDefinition) continue;
    return {
      pointer,
      name: toolDefinition.name,
      description: toolDefinition.description,
      inputSchema: toolDefinition.inputSchema,
      example: toolDefinition.example,
      sideEffect: toolDefinition.sideEffect,
      outputKind: toolDefinition.outputKind,
    };
  }
  return null;
}

function createFlatEvalRuntime(): RuntimeTrace {
  const calls: AdaptiveObservedCall[] = [];
  const tools: ToolSet = {};
  for (const integration of ADAPTIVE_TOOL_REGISTRY) {
    for (const toolDefinition of integration.tools) {
      tools[`${integration.id}__${toolDefinition.name}`] = tool({
        description: `${toolDefinition.description} Simulated ${integration.name} tool.`,
        inputSchema: jsonSchema(toolDefinition.inputSchema as never),
        execute: async (rawInput: unknown) => {
          const execution = executeAdaptiveSimulatedTool(toolDefinition.pointer, rawInput);
          calls.push(execution.observed);
          return execution.response;
        },
      } as never) as ToolSet[string];
    }
  }
  return {
    tools,
    calls,
    catalogSearches: [],
    explicitLevel1Expansions: () => 0,
    explicitLevel2Expansions: () => 0,
  };
}

function createSearchEvalRuntime(): RuntimeTrace {
  const calls: AdaptiveObservedCall[] = [];
  const catalogSearches: RuntimeTrace["catalogSearches"] = [];
  let level2Expansions = 0;
  const tools: ToolSet = {
    search_tools: tool({
      description:
        "Search the simulated tool catalog by operation and object. Call this before call_tool; repeat with a different query if needed.",
      inputSchema: jsonSchema(SEARCH_TOOL_SCHEMA as never),
      execute: async (rawInput: unknown) => {
        const input = record(rawInput);
        const query = String(input.query ?? "");
        const integration = typeof input.integration === "string" ? input.integration : undefined;
        const matches = searchAdaptiveToolCatalog({
          query,
          ...(integration ? { integration } : {}),
        });
        catalogSearches.push({
          query,
          ...(integration ? { integration } : {}),
          resultPointers: matches.map((match) => match.pointer),
        });
        return { matches };
      },
    } as never) as ToolSet[string],
    inspect_tool: tool({
      description:
        "Load the full schema and example for a tool:// pointer returned by search_tools.",
      inputSchema: jsonSchema(INSPECT_TOOL_SCHEMA as never),
      execute: async (rawInput: unknown) => {
        const pointer = String(record(rawInput).pointer ?? "");
        const definition = fullDefinition(pointer);
        if (!definition) return { ok: false, error: `Unknown tool pointer: ${pointer}` };
        level2Expansions += 1;
        return { ok: true, definition };
      },
    } as never) as ToolSet[string],
    call_tool: tool({
      description:
        "Execute a simulated tool by an exact tool:// pointer returned by search_tools. Full-schema validation occurs at call time.",
      inputSchema: jsonSchema(CALL_TOOL_SCHEMA as never),
      execute: async (rawInput: unknown) => {
        const input = record(rawInput);
        const execution = executeAdaptiveSimulatedTool(
          String(input.pointer ?? ""),
          input.arguments,
        );
        calls.push(execution.observed);
        return execution.response;
      },
    } as never) as ToolSet[string],
  };
  return {
    tools,
    calls,
    catalogSearches,
    explicitLevel1Expansions: () => catalogSearches.length,
    explicitLevel2Expansions: () => level2Expansions,
  };
}

function createAdaptiveEvalRuntime(): RuntimeTrace {
  const runtime = createAdaptiveToolRuntime();
  return {
    tools: runtime.tools,
    calls: runtime.calls,
    catalogSearches: [],
    explicitLevel1Expansions: () =>
      runtime.expansions.filter((expansion) => expansion.level === 1).length,
    explicitLevel2Expansions: () =>
      runtime.expansions.filter(
        (expansion) => expansion.level === 2 && expansion.reason === "model_request",
      ).length,
  };
}

function systemPrompt(mode: AdaptiveEvalMode, snapshot: AdaptiveExposureSnapshot) {
  const shared = `You are running a controlled integration-agent evaluation. Complete the user's request with the simulated tools. Never claim an operation happened unless its tool returned success. Tool calls are mock-only. Use earlier results when later calls depend on them. Do not call tools when the user asks only for writing, explanation, or summarization. Finish with a concise answer.`;
  if (mode === "adaptive") return `${shared}\n\n${adaptiveSystemPrompt(snapshot)}`;
  if (mode === "search") {
    return `${shared}

Only Level 0 is initially visible. Decide when to call search_tools to discover compact candidates. Use inspect_tool only if a compact signature is insufficient, then call_tool with the exact pointer. Search again when one result set does not cover the whole request.

Level 0:
${renderAdaptiveLevel0()}`;
  }
  return `${shared}\n\nEvery simulated integration tool is directly callable with its full schema.`;
}

function createRuntime(mode: AdaptiveEvalMode) {
  if (mode === "flat") return createFlatEvalRuntime();
  if (mode === "search") return createSearchEvalRuntime();
  return createAdaptiveEvalRuntime();
}

function numberOrZero(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function measurements(rawSteps: readonly unknown[]): AdaptiveStepMeasurement[] {
  return rawSteps.map((rawStep, step) => {
    const value = record(rawStep);
    const usage = record(value.usage);
    const toolCalls = Array.isArray(value.toolCalls) ? value.toolCalls : [];
    return {
      step,
      inputTokens: numberOrZero(usage.inputTokens),
      outputTokens: numberOrZero(usage.outputTokens),
      modelToolCalls: toolCalls.map((call) => String(record(call).toolName ?? "unknown")),
    };
  });
}

function mean(values: readonly number[]) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

export function scoreAdaptiveEvalCase(
  task: AdaptiveEvalTask,
  calls: readonly AdaptiveObservedCall[],
): AdaptiveEvalScore {
  const validPointers = calls.filter((call) => call.valid).map((call) => call.pointer);
  const validPointerSet = new Set(validPointers);
  const expectedSet = new Set(task.expectedToolPointers);
  const matchedCallCount = validPointers.filter((pointer) => expectedSet.has(pointer)).length;
  const missingToolPointers = task.expectedToolPointers.filter(
    (pointer) => !validPointerSet.has(pointer),
  );
  const extraToolPointers = validPointers.filter((pointer) => !expectedSet.has(pointer));
  const requiredToolRecall = task.expectedToolPointers.length
    ? (task.expectedToolPointers.length - missingToolPointers.length) /
      task.expectedToolPointers.length
    : 1;
  const toolPrecision = validPointers.length ? matchedCallCount / validPointers.length : 1;
  const validCallRate = calls.length ? calls.filter((call) => call.valid).length / calls.length : 1;
  return {
    requiredToolRecall,
    toolPrecision,
    exact:
      missingToolPointers.length === 0 &&
      extraToolPointers.length === 0 &&
      validPointers.length === task.expectedToolPointers.length &&
      validCallRate === 1,
    validCallRate,
    missingToolPointers,
    extraToolPointers,
  };
}

function triggerMisses(task: AdaptiveEvalTask, snapshot: AdaptiveExposureSnapshot) {
  const activated = new Set(snapshot.integrations.map((integration) => integration.id));
  return task.expectedIntegrationIds.filter((integrationId) => !activated.has(integrationId));
}

async function runEvalCase(input: {
  task: AdaptiveEvalTask;
  mode: AdaptiveEvalMode;
  model: string;
  gatewayApiKey: string;
}): Promise<AdaptiveEvalCase> {
  const snapshot = analyzeAdaptiveToolQuery(input.task.prompt);
  const runtime = createRuntime(input.mode);
  const gateway = createGateway({ apiKey: input.gatewayApiKey });
  const startedAt = performance.now();
  try {
    const result = await generateText({
      model: gateway(input.model),
      system: systemPrompt(input.mode, snapshot),
      messages: [{ role: "user", content: input.task.prompt }],
      tools: runtime.tools,
      stopWhen: stepCountIs(12),
      maxOutputTokens: 700,
      temperature: 0,
    });
    const steps = measurements(result.steps);
    const misses = triggerMisses(input.task, snapshot);
    const score = scoreAdaptiveEvalCase(input.task, runtime.calls);
    return {
      taskId: input.task.id,
      category: input.task.category,
      mode: input.mode,
      model: input.model,
      exposure: snapshot,
      estimatedInitialContextTokens: estimatedContextTokens(input.mode, snapshot),
      firstStepInputTokens: steps[0]?.inputTokens ?? 0,
      totalInputTokens: steps.reduce((total, step) => total + (step.inputTokens ?? 0), 0),
      totalOutputTokens: steps.reduce((total, step) => total + (step.outputTokens ?? 0), 0),
      durationMs: performance.now() - startedAt,
      steps,
      calls: runtime.calls,
      catalogSearches: runtime.catalogSearches.length,
      explicitLevel1Expansions: runtime.explicitLevel1Expansions(),
      explicitLevel2Expansions: runtime.explicitLevel2Expansions(),
      triggerFalseNegative: input.mode === "adaptive" && misses.length > 0,
      recoveredTriggerFalseNegative:
        input.mode === "adaptive" && misses.length > 0 && score.requiredToolRecall === 1,
      finalText: result.text,
      score,
    };
  } catch (error) {
    const misses = triggerMisses(input.task, snapshot);
    return {
      taskId: input.task.id,
      category: input.task.category,
      mode: input.mode,
      model: input.model,
      exposure: snapshot,
      estimatedInitialContextTokens: estimatedContextTokens(input.mode, snapshot),
      firstStepInputTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      durationMs: performance.now() - startedAt,
      steps: [],
      calls: runtime.calls,
      catalogSearches: runtime.catalogSearches.length,
      explicitLevel1Expansions: runtime.explicitLevel1Expansions(),
      explicitLevel2Expansions: runtime.explicitLevel2Expansions(),
      triggerFalseNegative: input.mode === "adaptive" && misses.length > 0,
      recoveredTriggerFalseNegative: false,
      finalText: "",
      score: scoreAdaptiveEvalCase(input.task, runtime.calls),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function summarizeAdaptiveEvalCases(
  cases: readonly AdaptiveEvalCase[],
  tasks: readonly AdaptiveEvalTask[] = ADAPTIVE_EVAL_TASKS,
): AdaptiveEvalSummary[] {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  return (["flat", "search", "adaptive"] as const).map((mode) => {
    const selected = cases.filter((item) => item.mode === mode);
    const successful = selected.filter((item) => !item.error);
    let expectedTools = 0;
    let matchedExpectedTools = 0;
    let validCalls = 0;
    let matchedValidCalls = 0;
    let allCalls = 0;
    for (const item of successful) {
      const expected = new Set(taskById.get(item.taskId)?.expectedToolPointers ?? []);
      const validPointers = item.calls.filter((call) => call.valid).map((call) => call.pointer);
      expectedTools += expected.size;
      matchedExpectedTools += [...expected].filter((pointer) =>
        validPointers.includes(pointer),
      ).length;
      validCalls += validPointers.length;
      matchedValidCalls += validPointers.filter((pointer) => expected.has(pointer)).length;
      allCalls += item.calls.length;
    }
    return {
      mode,
      runs: selected.length,
      errors: selected.length - successful.length,
      meanRequiredToolRecall: expectedTools ? matchedExpectedTools / expectedTools : 1,
      meanToolPrecision: validCalls ? matchedValidCalls / validCalls : 1,
      exactAccuracy: successful.length
        ? successful.filter((item) => item.score.exact).length / successful.length
        : 0,
      meanValidCallRate: allCalls ? validCalls / allCalls : 1,
      meanFirstStepInputTokens: mean(successful.map((item) => item.firstStepInputTokens)),
      meanTotalInputTokens: mean(successful.map((item) => item.totalInputTokens)),
      meanSteps: mean(successful.map((item) => item.steps.length)),
      meanDurationMs: mean(successful.map((item) => item.durationMs)),
      triggerFalseNegatives: successful.filter((item) => item.triggerFalseNegative).length,
      recoveredTriggerFalseNegatives: successful.filter(
        (item) => item.recoveredTriggerFalseNegative,
      ).length,
      meanCatalogSearches: mean(successful.map((item) => item.catalogSearches)),
      meanExplicitExpansions: mean(
        successful.map((item) => item.explicitLevel1Expansions + item.explicitLevel2Expansions),
      ),
    };
  });
}

function modeOrder(taskIndex: number, repetition: number): AdaptiveEvalMode[] {
  const modes: AdaptiveEvalMode[] = ["flat", "search", "adaptive"];
  const offset = (taskIndex + repetition) % modes.length;
  return [...modes.slice(offset), ...modes.slice(0, offset)];
}

export async function runLiveAdaptiveEvaluation(input: {
  gatewayApiKey: string;
  model: string;
  tasks?: readonly AdaptiveEvalTask[];
  repetitions?: number;
  onProgress?: (message: string) => void;
}): Promise<AdaptiveEvalRun> {
  const tasks = [...(input.tasks ?? ADAPTIVE_EVAL_TASKS)];
  const repetitions = input.repetitions ?? 1;
  const cases: AdaptiveEvalCase[] = [];
  const total = tasks.length * repetitions * 3;
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    for (const [taskIndex, task] of tasks.entries()) {
      for (const mode of modeOrder(taskIndex, repetition)) {
        input.onProgress?.(
          `${cases.length + 1}/${total} ${task.id} (${mode}, repetition ${repetition + 1})`,
        );
        cases.push(
          await runEvalCase({
            task,
            mode,
            model: input.model,
            gatewayApiKey: input.gatewayApiKey,
          }),
        );
      }
    }
  }
  return {
    schemaVersion: "goat.adaptive-tool-exposure-eval.v1",
    createdAt: new Date().toISOString(),
    model: input.model,
    repetitions,
    tasks,
    cases,
    summaries: summarizeAdaptiveEvalCases(cases, tasks),
  };
}

function precision(expected: readonly string[], observed: readonly string[]) {
  if (!observed.length) return expected.length ? 0 : 1;
  const expectedSet = new Set(expected);
  return observed.filter((value) => expectedSet.has(value)).length / observed.length;
}

function recall(expected: readonly string[], observed: readonly string[]) {
  if (!expected.length) return 1;
  const observedSet = new Set(observed);
  return expected.filter((value) => observedSet.has(value)).length / expected.length;
}

function percentile(values: readonly number[], percentileValue: number) {
  if (!values.length) return 0;
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(percentileValue * sorted.length))] ?? 0;
}

function scaledRegistryShape(integrationCount: number) {
  return Array.from({ length: integrationCount }, (_, index) => {
    const source = ADAPTIVE_TOOL_REGISTRY[index % ADAPTIVE_TOOL_REGISTRY.length]!;
    const suffix = index < ADAPTIVE_TOOL_REGISTRY.length ? "" : `-${index + 1}`;
    return {
      name: `${source.name}${suffix ? ` clone ${index + 1}` : ""}`,
      summary: source.summary,
      pointer: `integration://${source.id}${suffix}`,
      tools: source.tools.map((toolDefinition) => ({
        name: `${source.id}${suffix}__${toolDefinition.name}`,
        description: toolDefinition.description,
        inputSchema: toolDefinition.inputSchema,
        example: toolDefinition.example,
      })),
    };
  });
}

function scalingMeasurement(integrationCount: number) {
  const registry = scaledRegistryShape(integrationCount);
  const snapshot = analyzeAdaptiveToolQuery("Search Slack for launch risks.");
  const level0 = registry.map(({ name, summary, pointer }) => ({ name, summary, pointer }));
  const level1 = snapshot.integrations.map((integration) => ({
    pointer: integration.pointer,
    tools: integration.tools.map((toolDefinition) => ({
      pointer: toolDefinition.pointer,
      signature: toolDefinition.signature,
      description: toolDefinition.description,
    })),
  }));
  const flatTokens = estimateTokens(registry.flatMap((integration) => integration.tools));
  const searchTokens = estimateTokens({
    level0,
    engineTools: genericSearchSurface().engineTools,
  });
  const adaptiveTokens = estimateTokens({
    level0,
    level1,
    engineTools: ["expand_integration", "inspect_tool", "call_tool"],
  });
  return {
    integrations: integrationCount,
    tools: registry.reduce((total, integration) => total + integration.tools.length, 0),
    flatTokens,
    searchTokens,
    adaptiveTokens,
    adaptiveReductionPercent:
      flatTokens === 0 ? 0 : ((flatTokens - adaptiveTokens) / flatTokens) * 100,
  };
}

export function runAdaptiveStaticEvaluation(input?: {
  tasks?: readonly AdaptiveEvalTask[];
  latencyIterations?: number;
  scales?: readonly number[];
}): AdaptiveStaticEvaluation {
  const tasks = [...(input?.tasks ?? ADAPTIVE_EVAL_TASKS)];
  const latencyIterations = input?.latencyIterations ?? 200;
  const snapshots = tasks.map((task) => ({
    task,
    snapshot: analyzeAdaptiveToolQuery(task.prompt),
  }));
  const taskMeasurements = snapshots.map(({ task, snapshot }) => {
    const activatedIds = snapshot.integrations.map((integration) => integration.id);
    const candidatePointers = snapshot.integrations.flatMap((integration) =>
      integration.tools.map((toolDefinition) => toolDefinition.pointer),
    );
    return {
      taskId: task.id,
      category: task.category,
      expectedIntegrations: task.expectedIntegrationIds.length,
      activatedIntegrations: activatedIds.length,
      integrationRecall: recall(task.expectedIntegrationIds, activatedIds),
      integrationPrecision: precision(task.expectedIntegrationIds, activatedIds),
      expectedTools: task.expectedToolPointers.length,
      candidateTools: candidatePointers.length,
      candidateToolRecall: recall(task.expectedToolPointers, candidatePointers),
      activationLatencyMs: snapshot.activationLatencyMs,
      falseNegativeIntegrationIds: task.expectedIntegrationIds.filter(
        (integrationId) => !activatedIds.includes(integrationId),
      ),
      falsePositiveIntegrationIds: activatedIds.filter(
        (integrationId) => !task.expectedIntegrationIds.includes(integrationId),
      ),
      missingCandidateToolPointers: task.expectedToolPointers.filter(
        (pointer) => !candidatePointers.includes(pointer),
      ),
    };
  });

  const latencySamples: number[] = [];
  for (let iteration = 0; iteration < latencyIterations; iteration += 1) {
    for (const task of tasks) {
      latencySamples.push(analyzeAdaptiveToolQuery(task.prompt).activationLatencyMs);
    }
  }
  const meanEstimatedContextTokens = {
    flat: mean(snapshots.map(({ snapshot }) => estimatedContextTokens("flat", snapshot))),
    search: mean(snapshots.map(({ snapshot }) => estimatedContextTokens("search", snapshot))),
    adaptive: mean(snapshots.map(({ snapshot }) => estimatedContextTokens("adaptive", snapshot))),
  };
  return {
    registry: {
      integrations: ADAPTIVE_TOOL_REGISTRY.length,
      tools: ADAPTIVE_TOOL_REGISTRY.reduce(
        (total, integration) => total + integration.tools.length,
        0,
      ),
    },
    tasks: tasks.length,
    meanIntegrationRecall: mean(taskMeasurements.map((item) => item.integrationRecall)),
    meanIntegrationPrecision: mean(taskMeasurements.map((item) => item.integrationPrecision)),
    meanCandidateToolRecall: mean(taskMeasurements.map((item) => item.candidateToolRecall)),
    tasksWithTriggerFalseNegatives: taskMeasurements
      .filter((item) => item.falseNegativeIntegrationIds.length > 0)
      .map((item) => item.taskId),
    tasksWithCandidateMisses: taskMeasurements
      .filter((item) => item.missingCandidateToolPointers.length > 0)
      .map((item) => item.taskId),
    activationLatency: {
      meanMs: mean(latencySamples),
      p50Ms: percentile(latencySamples, 0.5),
      p95Ms: percentile(latencySamples, 0.95),
      samples: latencySamples.length,
    },
    meanEstimatedContextTokens,
    taskMeasurements,
    scaling: (input?.scales ?? [1, 3, 6, 12, 24, 48, 96]).map(scalingMeasurement),
  };
}
