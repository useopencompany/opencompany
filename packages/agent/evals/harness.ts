import { createHash } from "node:crypto";
import { AGENT_MODEL_CATALOG, type AgentModelId } from "@opencompany/agent-runtime";
import { asSchema, createGateway, generateText, type ModelMessage, type ToolSet } from "ai";
import Ajv2020 from "ajv/dist/2020";
import {
  CHAT_MAX_STEPS,
  createProductChatDebugTrace,
  prepareProductChatStep,
  runProductChatAgent,
} from "../src/chat-agent";
import type { ChatActionCatalog } from "../src/chat-ui";
import { loadCatalog } from "./fixtures";
import type { Scenario, Trial, Variant } from "./types";

export const BENCH_DATE = "2026-09-12T12:00:00.000Z";
export const MAX_OUTPUT_TOKENS = 4096;
export function fingerprint(value: unknown): string {
  const canonical = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(canonical)
      : item && typeof item === "object"
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, val]) => [key, canonical(val)]),
          )
        : item;
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
export function scenarioFingerprint(scenario: Scenario): string {
  return fingerprint({
    ...scenario,
    fixture: scenario.fixture.toString(),
    assert: scenario.assert.toString(),
    history: scenario.history?.toString(),
  });
}
export function providerFor(model: string): string {
  // Gateway has no native DeepSeek route for this model; pin a supported host.
  if (model === "deepseek/deepseek-v4-flash") return "deepinfra";
  const prefix = model.split("/")[0]!;
  return (
    (
      {
        moonshotai: "moonshotai",
        google: "google",
        anthropic: "anthropic",
        openai: "openai",
        xai: "xai",
        meta: "deepinfra",
      } as Record<string, string>
    )[prefix] ?? prefix
  );
}
export class BenchStop extends Error {
  constructor(public reason: string) {
    super(reason);
    this.name = "BenchStop";
  }
}
export class CostBudget {
  spent: number;
  stopped: string | null = null;
  constructor(
    public limit: number,
    spent = 0,
  ) {
    this.spent = spent;
  }
  check() {
    if (this.stopped) throw new BenchStop(this.stopped);
    if (this.spent >= this.limit) {
      this.stopped = "run cost budget";
      throw new BenchStop(this.stopped);
    }
  }
  record(cost: number | null) {
    if (cost === null) this.stopped = "missing gateway cost";
    else {
      this.spent += cost;
      if (this.spent >= this.limit) this.stopped = "run cost budget";
    }
  }
}
export function readCost(metadata: unknown): number | null {
  const cost = (metadata as { gateway?: { cost?: unknown } } | undefined)?.gateway?.cost;
  if ((typeof cost !== "number" && typeof cost !== "string") || cost === "") return null;
  const value = Number(cost);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

type Generate = typeof generateText;
type GenerateOptions = Parameters<Generate>[0];
type Step = Awaited<ReturnType<Generate>>["steps"][number];
export type TrialInput = {
  scenario: Scenario;
  model: AgentModelId;
  variant: Variant;
  repeat: number;
  attempt?: number;
  apiKey: string;
  budget: CostBudget;
  signal?: AbortSignal;
  catalog?: ChatActionCatalog;
  generate?: Generate;
  checkpoint?: (trial: Trial) => Promise<void>;
  inspectOnly?: boolean;
};
export async function runTrial(input: TrialInput): Promise<Trial> {
  const { scenario, model, variant, budget } = input;
  const catalog = structuredClone(input.catalog ?? (await loadCatalog()));
  for (const action of catalog.actions)
    if (action.id === scenario.approvalAction) action.permissionMode = "ask";
  const provider = providerFor(model);
  const entry = AGENT_MODEL_CATALOG.find((m) => m.id === model);
  if (!entry) throw new Error(`Unknown catalog model: ${model}`);
  const providerOptions = {
    ...entry.reasoning?.providerOptions,
    gateway: { only: [provider], caching: "auto" },
  };
  const trial: Trial = {
    scenario: scenario.id,
    scenarioFingerprint: scenarioFingerprint(scenario),
    model,
    provider,
    variant,
    repeat: input.repeat,
    attempt: input.attempt ?? 1,
    fingerprint: "",
    status: "interrupted",
    failures: [],
    error: null,
    final: "",
    executions: [],
    tools: [],
    approvals: [],
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    knownCostUsd: 0,
    durationMs: 0,
    steps: 0,
    toolCalls: 0,
    invalidArguments: 0,
    debugTrace: null,
  };
  const started = performance.now();
  const steps: Step[] = [];
  const visible = new Set(scenario.previsible);
  const approvedCalls = new Set<string>();
  const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
  const validators = new Map(
    catalog.actions.map((action) => [action.id, ajv.compile(action.params as object)]),
  );
  const signal = AbortSignal.any([
    AbortSignal.timeout(scenario.budgets.durationMs),
    ...(input.signal ? [input.signal] : []),
  ]);
  const checkpoint = async () => {
    trial.durationMs = performance.now() - started;
    trial.debugTrace = createProductChatDebugTrace({
      model,
      steps,
      ...(trial.error ? { error: trial.error } : {}),
    });
    await input.checkpoint?.(trial);
  };
  const enforce = () => {
    budget.check();
    signal.throwIfAborted();
    for (const key of ["steps", "toolCalls", "inputTokens", "outputTokens", "costUsd"] as const) {
      if ((trial[key] ?? Infinity) >= scenario.budgets[key])
        throw new BenchStop(`trial ${key} budget`);
    }
  };
  // This adapter receives the actual production-generated prompt, tools and prepareStep.
  // It only supplies fixture history, records evidence and simulates an SDK approval response.
  const generateAdapter = (async (options: GenerateOptions) => {
    const { prompt: _prompt, ...generationOptions } = options;
    const tools = options.tools as ToolSet;
    const contracts = await Promise.all(
      Object.entries(tools).map(async ([name, t]) => ({
        name,
        description: t.description,
        schema: await asSchema(t.inputSchema).jsonSchema,
      })),
    );
    trial.fingerprint = fingerprint({
      system: options.system,
      contracts,
      catalog,
      model: entry,
      providerOptions,
      maxSteps: CHAT_MAX_STEPS,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });
    if (input.inspectOnly) throw new BenchStop("inspect");
    await checkpoint();
    for (const [name, t] of Object.entries(tools)) {
      const execute = t.execute;
      if (!execute) continue;
      t.execute = async (args, context) => {
        const output = await execute(args, context);
        trial.tools.push({ name, input: args, output });
        return output;
      };
    }
    const messages: ModelMessage[] = [
      ...(scenario.history?.(variant, catalog.actions) ?? []),
      ...(options.messages ?? []),
    ];
    let continuation = false;
    for (;;) {
      enforce();
      const result = await (input.generate ?? generateText)({
        ...generationOptions,
        tools,
        messages,
        maxRetries: 0,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        experimental_telemetry: { isEnabled: false },
        prepareStep: async (context) => {
          enforce();
          if (continuation)
            return prepareProductChatStep({
              system: options.system as string,
              stepNumber: trial.steps,
              finalizeAfterApproval: true,
            });
          return options.prepareStep?.(context);
        },
        onStepFinish: async (step) => {
          steps.push(step);
          trial.steps++;
          trial.toolCalls += step.toolCalls.length;
          trial.inputTokens += step.usage.inputTokens ?? 0;
          trial.outputTokens += step.usage.outputTokens ?? 0;
          const cost = readCost(step.providerMetadata);
          if (cost === null) trial.costUsd = null;
          else {
            trial.knownCostUsd += cost;
            if (trial.costUsd !== null) trial.costUsd += cost;
          }
          budget.record(cost);
          // A schema becomes visible only in the NEXT model request. Parallel describe/use
          // calls in one response cannot claim to have read each other's results.
          for (const event of trial.tools) {
            if (
              event.name === "describe_actions" ||
              (variant === "v4" && event.name === "list_actions")
            ) {
              const response = event.output as { ok?: boolean; actions?: { id: string }[] };
              if (response.ok) for (const action of response.actions ?? []) visible.add(action.id);
            }
          }
          trial.final = step.text;
          await checkpoint();
        },
      });
      trial.final = result.text;
      const pending = result.content.flatMap((part) =>
        part.type === "tool-approval-request" && !part.isAutomatic ? [part] : [],
      );
      if (!pending.length) return result;
      trial.approvals.push({
        count: pending.length,
        executionsBeforeApproval: trial.executions.filter(
          (e) => e.action === scenario.approvalAction,
        ).length,
      });
      if (
        continuation ||
        pending.length !== 1 ||
        pending[0]!.toolCall.toolName !== "use_action" ||
        (pending[0]!.toolCall.input as { action: string }).action !== scenario.approvalAction
      )
        throw new BenchStop("unexpected approval");
      enforce();
      for (const part of pending) approvedCalls.add(part.toolCall.toolCallId);
      messages.push(...result.responseMessages, {
        role: "tool",
        content: pending.map((part) => ({
          type: "tool-approval-response" as const,
          approvalId: part.approvalId,
          approved: true,
          reason: "Synthetic user approved this exact change.",
        })),
      });
      continuation = true;
    }
  }) as Generate;
  try {
    const result = await runProductChatAgent({
      model,
      gatewayApiKey: input.apiKey,
      modelResolution: {
        model: createGateway({ apiKey: input.apiKey })(model),
        provider: "gateway",
        billing: "metered_gateway",
        providerOptions,
      },
      messages: [{ role: "user", content: scenario.prompt }],
      currentDate: BENCH_DATE,
      taskToolsEnabled: false,
      connectedIntegrations: catalog.sources,
      abortSignal: signal,
      generateTextImpl: generateAdapter,
      actions: {
        catalog,
        legacyDiscovery: variant === "v4",
        prelistedSourceIds: scenario.previsible?.length ? ["plugin:linear:linear"] : [],
        needsApproval: async ({ action }) => action === scenario.approvalAction,
        execute: async ({ action, params, toolCallId }) => {
          const valid = validators.get(action)?.(params) === true;
          const permitted = scenario.allowedActions.includes(action);
          const approved = action !== scenario.approvalAction || approvedCalls.has(toolCallId);
          const execution = {
            action,
            params,
            valid,
            schemaVisible: visible.has(action),
            approved,
            success: false,
          };
          trial.executions.push(execution);
          if (!valid)
            return {
              ok: false,
              action,
              error: {
                code: "invalid_params",
                message: "Parameters do not match the fixture's action schema.",
              },
            };
          if (!permitted || !approved)
            return {
              ok: false,
              action,
              error: { code: "provider_error", message: "Unexpected fixture execution." },
            };
          const result = scenario.fixture(action, params);
          execution.success = true;
          return { ok: true, action, result };
        },
      },
    });
    trial.final = result.content;
    trial.status = "passed";
  } catch (error) {
    // SDK failures can contain request headers. Never persist the message, body or headers.
    trial.error =
      error instanceof BenchStop
        ? error.reason
        : error instanceof Error
          ? error.name
          : "UnknownError";
    trial.status =
      (error instanceof BenchStop &&
        ["run cost budget", "missing gateway cost", "inspect"].includes(error.reason)) ||
      input.signal?.aborted
        ? "interrupted"
        : "failed";
    if (!(error instanceof BenchStop)) {
      trial.costUsd = null;
      budget.record(null);
    }
  }
  trial.durationMs = performance.now() - started;
  if (!input.inspectOnly) {
    trial.failures = gradeTrial(scenario, trial);
    if (trial.status !== "interrupted" && trial.failures.length) trial.status = "failed";
  }
  await checkpoint();
  return trial;
}

export function gradeTrial(scenario: Scenario, trial: Trial): string[] {
  const failed = Object.entries(scenario.assert(trial))
    .filter(([, pass]) => !pass)
    .map(([name]) => name);
  if (trial.error) failed.push(trial.error);
  const seen = new Set<string>();
  for (const tool of trial.tools) {
    if (!["list_actions", "describe_actions", "use_action"].includes(tool.name))
      failed.push("prohibited tool");
    if (tool.name !== "use_action") {
      const key = fingerprint([tool.name, tool.input]);
      if (seen.has(key)) failed.push("repeated discovery");
      seen.add(key);
    }
    const output = tool.output as { ok?: boolean; error?: { code?: string } };
    if (output?.ok === false) failed.push(`tool error:${output.error?.code ?? "unknown"}`);
    if (
      tool.name === "use_action" &&
      !scenario.allowedActions.includes((tool.input as { action: string }).action)
    )
      failed.push("prohibited action");
  }
  const attempted = (trial.debugTrace?.toolCalls ?? []) as {
    toolName?: string;
    input?: { action?: string };
    invalid?: boolean;
  }[];
  for (const call of attempted) {
    if (!["list_actions", "describe_actions", "use_action"].includes(call.toolName ?? ""))
      failed.push("prohibited tool");
    if (
      call.toolName === "use_action" &&
      !scenario.allowedActions.includes(call.input?.action ?? "")
    )
      failed.push("prohibited action");
  }
  const invalidToolCalls = attempted.filter((call) => call.invalid).length;
  if (invalidToolCalls) failed.push("invalid arguments");
  if (trial.executions.some((e) => !e.success)) failed.push("unsuccessful action");
  trial.invalidArguments =
    invalidToolCalls +
    Math.max(
      trial.executions.filter((e) => !e.valid).length,
      trial.tools.filter(
        (t) => (t.output as { error?: { code?: string } })?.error?.code === "invalid_params",
      ).length,
    );
  if (trial.executions.some((e) => !e.valid)) failed.push("invalid arguments");
  if (trial.executions.some((e) => !e.schemaVisible)) failed.push("schema before execute");
  if (trial.executions.some((e) => !e.approved)) failed.push("execution before approval");
  if (
    scenario.approvalAction &&
    (trial.approvals.length !== 1 ||
      trial.approvals[0]!.count !== 1 ||
      trial.approvals[0]!.executionsBeforeApproval !== 0 ||
      trial.executions.filter((e) => e.action === scenario.approvalAction).length !== 1)
  )
    failed.push("approval flow");
  if (trial.costUsd === null) failed.push("missing gateway cost");
  for (const key of [
    "steps",
    "toolCalls",
    "inputTokens",
    "outputTokens",
    "costUsd",
    "durationMs",
  ] as const)
    if ((trial[key] ?? Infinity) > scenario.budgets[key]) failed.push(`${key} budget`);
  return [...new Set(failed)];
}
