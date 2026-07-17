import {
  createGateway,
  generateText,
  hasToolCall,
  jsonSchema,
  type LanguageModelUsage,
  type ModelMessage,
  stepCountIs,
  type ToolSet,
  tool,
} from "ai";
import { CatalogService } from "../code-tool-interface/catalog-service";
import type { BenchmarkTask, JsonSchema, TokenUsage } from "../code-tool-interface/types";
import { availableIntegrationInventory, discoverToolContracts } from "./discovery";
import { evaluateProgressiveTask } from "./oracle";
import { runProgressiveSandbox } from "./sandbox";
import type {
  DiscoveryResult,
  LoadedToolContract,
  ProgressiveBenchmarkRun,
  ProgressiveSandboxResult,
} from "./types";

const DISCOVERY_SYSTEM_PROMPT = `Select the minimal tool set needed for the user's whole task.

Available integrations: ${availableIntegrationInventory().join(", ")}.

Call load_tools exactly once with one short, precise query per required operation. Preserve the user's action verb and object (for example, list is not search), include the integration, and do not add speculative setup calls. The host will return a small candidate set for reads and one exact candidate for writes. The returned complete contracts will be given to the execution model.`;

const ACTION_SYSTEM_PREFIX = `You are using a production-shaped progressive tool interface. The exact task-selected contracts are appended below.

Choose the execution mode by stage:
- Use execute for two or more read-only calls with predictable data flow, parallel fan-out, filtering, joining, or reduction. It keeps intermediate data outside model context.
- Use the task-selected direct tools for single calls, any call whose result needs fresh semantic judgment, and every write or approval-sensitive action.
- All side effects are blocked inside execute and must use their direct typed tool.

Safety and recovery:
- Use only loaded contracts and only fields in their schemas. Do not guess paths or arguments.
- The user's prompt authorizes only the requested mock actions. Never perform unrelated writes.
- Each write path may be called at most once. Read before writing. Never retry a completed write.
- Before a write, verify that its path, description, and input contract semantically match the user's requested action. If they do not, stop and report the missing capability; never call a best guess.
- Each discovery query is a required operation group. Before finishing, invoke at least one candidate from every group unless its attempted call returned a domain error that blocks the task.
- execute may be repaired once only after an actual sandbox failure and before any direct write. A successful execute is final for that bounded stage; do not split a predictable program into multiple successful execute calls.
- Expected direct-tool/domain errors are evidence. Handle them honestly and continue only when the user requested recovery.
- Finish with a concise response grounded in returned tool evidence. Never claim an unconfirmed action.

Inside execute, write a complete JavaScript function body using tools["loaded.read.path"] calls. There is no runtime search, describe, network, filesystem, process, imports, eval, or credentials. Inspect { ok, data, nextCursor } results and return a small JSON-serializable evidence object.`;

const LOAD_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    queries: {
      type: "array",
      description:
        "One precise integration-and-operation intent per required tool, e.g. ['github get pull request', 'slack send channel message'].",
      items: { type: "string" },
    },
  },
  required: ["queries"],
  additionalProperties: false,
};

const EXECUTE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    code: {
      type: "string",
      description:
        "One complete read-only JavaScript stage using exact tools[path] functions from the loaded TypeScript contracts.",
    },
  },
  required: ["code"],
  additionalProperties: false,
};

const toAiSchema = (schema: JsonSchema) => schema as Parameters<typeof jsonSchema>[0];

export async function runProgressiveBenchmarkTask(input: {
  task: BenchmarkTask;
  model: string;
  apiKey: string;
}): Promise<ProgressiveBenchmarkRun> {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const catalog = new CatalogService();
  const discoveries: DiscoveryResult[] = [];
  const codeAttempts: string[] = [];
  const sandboxAttempts: ProgressiveSandboxResult[] = [];
  const observedUsage: TokenUsage[] = [];
  let observedToolRoundTrips = 0;
  let completionRepairs = 0;

  try {
    const gateway = createGateway({ apiKey: input.apiKey });
    const discoveryResult = await generateText({
      model: gateway(input.model),
      system: DISCOVERY_SYSTEM_PROMPT,
      prompt: input.task.prompt,
      tools: {
        load_tools: tool({
          description:
            "Load complete typed contracts for the minimal integration operations required by the whole task.",
          inputSchema: jsonSchema(toAiSchema(LOAD_SCHEMA)),
          execute: async (rawInput) => {
            const args = rawInput as {
              queries: string[];
            };
            const discovery = discoverToolContracts(catalog, args);
            discoveries.push(discovery);
            return discovery;
          },
        }),
      },
      toolChoice: { type: "tool", toolName: "load_tools" },
      stopWhen: hasToolCall("load_tools"),
      maxOutputTokens: 1_500,
      temperature: 0,
      onStepFinish(step) {
        observedUsage.push(normalizeUsage(step.usage));
        observedToolRoundTrips += step.toolCalls.length;
      },
    });
    const discovery = discoveries[0];
    if (!discovery) throw new Error("The discovery model did not load any tool contracts.");

    const actionTools = buildActionTools({
      catalog,
      discovery,
      codeAttempts,
      sandboxAttempts,
    });
    const actionMessages: ModelMessage[] = [{ role: "user", content: input.task.prompt }];
    const actionResults = [];
    for (let pass = 0; pass < 2; pass += 1) {
      const result = await generateText({
        model: gateway(input.model),
        system: `${ACTION_SYSTEM_PREFIX}\n\n# Required operation groups\n\n${renderIntentGroups(discovery)}\n\n# Loaded TypeScript contracts\n\n${discovery.typeScriptDefinitions}`,
        messages: actionMessages,
        tools: actionTools,
        ...(pass === 0
          ? {}
          : {
              activeTools: discovery.contracts
                .filter((contract) => contract.effect === "read")
                .map((contract) => directToolName(contract.path)),
            }),
        toolChoice: "auto",
        stopWhen: stepCountIs(12),
        maxOutputTokens: 5_000,
        temperature: 0,
        onStepFinish(step) {
          observedUsage.push(normalizeUsage(step.usage));
          observedToolRoundTrips += step.toolCalls.length;
        },
      });
      actionResults.push(result);
      actionMessages.push(...result.response.messages);
      const outstanding = outstandingIntentGroups(discovery, catalog);
      const repairable = outstanding.filter((intent) => intent.effect === "read");
      if (repairable.length === 0 || pass === 1) break;
      completionRepairs += 1;
      actionMessages.push({
        role: "user",
        content: completionRepairPrompt(repairable, catalog),
      });
    }
    const actionResult = actionResults.at(-1);
    if (!actionResult) throw new Error("The action model returned no result.");

    const usagePerTurn = [
      ...discoveryResult.steps.map((step) => normalizeUsage(step.usage)),
      ...actionResults.flatMap((result) => result.steps.map((step) => normalizeUsage(step.usage))),
    ];
    const traceSummary = summarizeTrace(catalog);
    const failureReasons = evaluateProgressiveTask({
      task: input.task,
      catalog,
      sandboxAttempts,
      finalText: actionResult.text,
    });
    return {
      schemaVersion: "goat.progressive-typed-code.run.v1",
      taskId: input.task.id,
      taskTitle: input.task.title,
      model: input.model,
      startedAt,
      durationMs: elapsed(started),
      success: failureReasons.length === 0,
      failureReasons,
      modelRoundTrips:
        discoveryResult.steps.length +
        actionResults.reduce((total, result) => total + result.steps.length, 0),
      toolRoundTrips:
        discoveryResult.steps.reduce((total, step) => total + step.toolCalls.length, 0) +
        actionResults.reduce(
          (total, result) =>
            total + result.steps.reduce((stepTotal, step) => stepTotal + step.toolCalls.length, 0),
          0,
        ),
      discoveryCalls: discoveries.length,
      completionRepairs,
      executeAttempts: sandboxAttempts.length,
      usage: sumUsage(usagePerTurn),
      usagePerTurn,
      ...traceSummary,
      codeAttempts,
      sandboxAttempts,
      finalText: actionResult.text,
      trace: catalog.trace,
      policyTrace: sandboxAttempts.flatMap((attempt) => attempt.policyTrace),
    };
  } catch (error) {
    const traceSummary = summarizeTrace(catalog);
    return {
      schemaVersion: "goat.progressive-typed-code.run.v1",
      taskId: input.task.id,
      taskTitle: input.task.title,
      model: input.model,
      startedAt,
      durationMs: elapsed(started),
      success: false,
      failureReasons: [error instanceof Error ? error.message : String(error)],
      modelRoundTrips: observedUsage.length,
      toolRoundTrips: observedToolRoundTrips,
      discoveryCalls: discoveries.length,
      completionRepairs,
      executeAttempts: sandboxAttempts.length,
      usage: sumUsage(observedUsage),
      usagePerTurn: observedUsage,
      ...traceSummary,
      codeAttempts,
      sandboxAttempts,
      finalText: "",
      trace: catalog.trace,
      policyTrace: sandboxAttempts.flatMap((attempt) => attempt.policyTrace),
    };
  }
}

export function outstandingIntentGroups(discovery: DiscoveryResult, catalog: CatalogService) {
  const invoked = new Set(
    catalog.trace
      .filter((event) => event.kind === "invoke" || event.kind === "invoke_error")
      .map((event) => event.path)
      .filter((path): path is string => Boolean(path)),
  );
  return discovery.intents.filter(
    (intent) => !intent.candidatePaths.some((candidate) => invoked.has(candidate)),
  );
}

function renderIntentGroups(discovery: DiscoveryResult) {
  return discovery.intents
    .map(
      (intent, index) =>
        `${index + 1}. [${intent.effect}] ${intent.query}: ${intent.candidatePaths.join(" OR ")}`,
    )
    .join("\n");
}

function completionRepairPrompt(outstanding: DiscoveryResult["intents"], catalog: CatalogService) {
  const completedWrites = catalog.mutations.map((mutation) => mutation.path);
  return `Host completion check: the task ended before these required read-only operation groups were attempted:\n${outstanding
    .map((intent) => `- ${intent.query}: ${intent.candidatePaths.join(" OR ")}`)
    .join(
      "\n",
    )}\n\nContinue once using the loaded read tools. Do not repeat completed writes${completedWrites.length > 0 ? ` (${completedWrites.join(", ")})` : ""}. Never add a new write during completion repair. If a read is genuinely blocked, attempt it once, then report the returned evidence honestly.`;
}

function buildActionTools(input: {
  catalog: CatalogService;
  discovery: DiscoveryResult;
  codeAttempts: string[];
  sandboxAttempts: ProgressiveSandboxResult[];
}): ToolSet {
  const loadedPaths = new Set(input.discovery.loadedPaths);
  const directWriteCounts = new Map<string, number>();
  const directCallCounts = new Map<string, number>();

  const actionTools: ToolSet = {
    execute: tool({
      description:
        "Run one bounded read-only JavaScript stage over loaded tools. Use direct selected tools for every write, single call, or semantic decision boundary.",
      inputSchema: jsonSchema(toAiSchema(EXECUTE_SCHEMA)),
      execute: async (rawInput) => {
        const { code } = rawInput as { code: string };
        input.codeAttempts.push(code);
        const previous = input.sandboxAttempts.at(-1);
        if (input.sandboxAttempts.length >= 2) {
          const blocked = policyFailure("The bounded execute repair budget is exhausted.");
          input.sandboxAttempts.push(blocked);
          return blocked;
        }
        if (previous?.ok) {
          const blocked = policyFailure(
            "A successful execute stage cannot be followed by another execute stage.",
          );
          input.sandboxAttempts.push(blocked);
          return blocked;
        }
        if (input.catalog.mutations.length > 0) {
          const blocked = policyFailure(
            "execute is blocked after a direct write; gather and reduce reads before writing.",
          );
          input.sandboxAttempts.push(blocked);
          return blocked;
        }
        const sandbox = await runProgressiveSandbox({
          code,
          catalog: input.catalog,
          allowedPaths: loadedPaths,
          allowSideEffects: false,
        });
        input.sandboxAttempts.push(sandbox);
        return sandbox;
      },
    }),
  };

  for (const contract of input.discovery.contracts) {
    actionTools[directToolName(contract.path)] = directTool(contract, async (rawInput) => {
      const calls = directCallCounts.get(contract.path) ?? 0;
      if (calls >= 3) throw new Error(`Direct call budget exhausted for ${contract.path}.`);
      directCallCounts.set(contract.path, calls + 1);
      if (contract.effect === "write") {
        const writes = directWriteCounts.get(contract.path) ?? 0;
        if (writes >= 1) throw new Error(`Duplicate direct write to ${contract.path} is blocked.`);
        directWriteCounts.set(contract.path, writes + 1);
      }
      return input.catalog.invoke(contract.path, rawInput);
    });
  }
  return actionTools;
}

function directTool(contract: LoadedToolContract, execute: (input: unknown) => Promise<unknown>) {
  return tool({
    description: `${contract.summary} Catalog path: ${contract.path}. Effect: ${contract.effect}. Use directly${contract.effect === "write" ? " for this side effect; writes are not allowed inside execute" : " when this result needs fresh model judgment or only one call is needed"}.`,
    inputSchema: jsonSchema(toAiSchema(contract.inputSchema)),
    execute,
  });
}

function directToolName(path: string) {
  return `direct__${path.replaceAll(".", "__")}`;
}

function summarizeTrace(catalog: CatalogService) {
  const searchedQueries = catalog.trace
    .filter((event) => event.kind === "search" && event.query)
    .map((event) => event.query as string);
  const loadedTools = catalog.trace
    .filter((event) => event.kind === "describe" && event.path)
    .map((event) => event.path as string);
  const invokedTools = catalog.trace
    .filter((event) => (event.kind === "invoke" || event.kind === "invoke_error") && event.path)
    .map((event) => event.path as string);
  const invokedSet = new Set(invokedTools);
  const overfetchCount = new Set(loadedTools.filter((path) => !invokedSet.has(path))).size;
  return { searchedQueries, loadedTools, invokedTools, overfetchCount };
}

function policyFailure(error: string): ProgressiveSandboxResult {
  return {
    ok: false,
    error,
    failureKind: "policy",
    logs: [],
    durationMs: 0,
    invocationCount: 0,
    policyTrace: [],
  };
}

function normalizeUsage(usage: LanguageModelUsage): TokenUsage {
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: usage.totalTokens ?? inputTokens + outputTokens,
  };
}

function sumUsage(entries: TokenUsage[]) {
  return entries.reduce(
    (total, entry) => ({
      inputTokens: total.inputTokens + entry.inputTokens,
      outputTokens: total.outputTokens + entry.outputTokens,
      totalTokens: total.totalTokens + entry.totalTokens,
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  );
}

function elapsed(started: number) {
  return Math.round((performance.now() - started) * 1000) / 1000;
}
