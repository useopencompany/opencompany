import {
  createGateway,
  generateText,
  hasToolCall,
  jsonSchema,
  type LanguageModelUsage,
  stepCountIs,
  type ToolSet,
  tool,
} from "ai";
import { MOCK_TOOL_CATALOG } from "./catalog";
import { CatalogService } from "./catalog-service";
import { runSandbox } from "./sandbox";
import type {
  BenchmarkRun,
  BenchmarkStrategy,
  BenchmarkTask,
  JsonSchema,
  SandboxResult,
  TokenUsage,
} from "./types";

const EXECUTE_SYSTEM_PROMPT = `You are evaluating a code-mode tool interface. Accomplish the user's task by making exactly one execute call.

The sandbox runs JavaScript. Your code is inserted inside an async function, so use await and return a compact result. It has exactly one global API:
- await tools.search(query, { limit? }) -> ranked [{ path, summary, score }]. Search by intent before choosing a path.
- await tools.describe(path) -> { path, summary, inputSchema, outputSchema }. Describe each tool immediately before its first call.
- await tools[path](input) -> invokes that tool. Paths are strings, so use bracket notation.

Write normal control flow for the whole task in one execute call: variables, loops, Promise.all when independent, conditionals, and try/catch for recoverable tool failures. There will be no second execute call and search results will not come back to you. Search results alone are never task completion: the same program must continue from candidate paths to describe and invoke every required integration operation before returning. Never guess a schema. Do not use fetch, imports, process, require, eval, or filesystem APIs. Inspect returned { ok, data } values and return evidence of what you completed.

Pattern:
const matches = await tools.search("source search records");
const sourcePath = matches[0].path;
const sourceSchema = await tools.describe(sourcePath);
// Form input only after reading sourceSchema.inputSchema at runtime.
const source = await tools[sourcePath]({ query: "specific record" });
const destinations = await tools.search("destination create item");
const destinationPath = destinations[0].path;
await tools.describe(destinationPath);
const created = await tools[destinationPath]({ title: source.data[0].title });
return { sourcePath, destinationPath, created: created.data };`;

const FLAT_SYSTEM_PROMPT = `You are evaluating conventional flat tool calling. Accomplish the user's task using the provided integration tools. Inspect returned data before subsequent calls, handle tool errors when possible, and finish with a compact evidence summary. Do not claim an action that a tool result did not confirm.`;

const TIERED_SYSTEM_PROMPT = `You are evaluating a tiered lazy tool catalog. The only catalog operations are catalog_search, catalog_describe, and catalog_invoke. Search by intent, describe a specific path immediately before its first invocation, and invoke it with input matching the returned schema. Repeat as needed, using earlier results to form later inputs. Handle tool errors and finish with a compact evidence summary.`;

const EXECUTE_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    code: {
      type: "string",
      description:
        "Complete JavaScript function-body code for the entire task. This is the only execute call: do not return search results for a later turn. In this same code string, search paths, describe them, invoke every operation needed by the user, and only then return compact completion evidence.",
    },
  },
  required: ["code"],
  additionalProperties: false,
};
const toAiSchema = (schema: JsonSchema) => schema as Parameters<typeof jsonSchema>[0];

export async function runBenchmarkTask(input: {
  task: BenchmarkTask;
  strategy: BenchmarkStrategy;
  model: string;
  apiKey: string;
}): Promise<BenchmarkRun> {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const catalog = new CatalogService();
  let sandbox: SandboxResult | undefined;
  let code: string | undefined;
  const observedUsagePerTurn: TokenUsage[] = [];
  let observedToolRoundTrips = 0;

  try {
    const gateway = createGateway({ apiKey: input.apiKey });
    const tools = buildTools(input.strategy, catalog, (nextSandbox, nextCode) => {
      sandbox = nextSandbox;
      code = nextCode;
    });
    const result = await generateText({
      model: gateway(input.model),
      system: systemPrompt(input.strategy),
      prompt: input.task.prompt,
      tools,
      toolChoice: input.strategy === "execute" ? { type: "tool", toolName: "execute" } : "auto",
      stopWhen: input.strategy === "execute" ? hasToolCall("execute") : stepCountIs(20),
      maxOutputTokens: input.strategy === "execute" ? 5_000 : 1_500,
      temperature: 0,
      onStepFinish(step) {
        observedUsagePerTurn.push(normalizeUsage(step.usage));
        observedToolRoundTrips += step.toolCalls.length;
      },
    });

    const usagePerTurn = result.steps.map((step) => normalizeUsage(step.usage));
    const traceSummary = summarizeTrace(catalog);
    const finalText =
      input.strategy === "execute"
        ? stringifyCompact(sandbox?.ok ? sandbox.value : sandbox?.error)
        : result.text;
    const failureReasons = evaluateTask(input.task, input.strategy, catalog, sandbox);

    return {
      schemaVersion: "goat.code-tool-interface.run.v1",
      taskId: input.task.id,
      taskTitle: input.task.title,
      strategy: input.strategy,
      model: input.model,
      startedAt,
      durationMs: elapsed(started),
      success: failureReasons.length === 0,
      failureReasons,
      modelRoundTrips: result.steps.length,
      toolRoundTrips: result.steps.reduce((total, step) => total + step.toolCalls.length, 0),
      usage: sumUsage(usagePerTurn),
      usagePerTurn,
      ...traceSummary,
      ...(code ? { code } : {}),
      ...(sandbox ? { sandbox } : {}),
      finalText,
      trace: catalog.trace,
    };
  } catch (error) {
    const traceSummary = summarizeTrace(catalog);
    return {
      schemaVersion: "goat.code-tool-interface.run.v1",
      taskId: input.task.id,
      taskTitle: input.task.title,
      strategy: input.strategy,
      model: input.model,
      startedAt,
      durationMs: elapsed(started),
      success: false,
      failureReasons: [error instanceof Error ? error.message : String(error)],
      modelRoundTrips: observedUsagePerTurn.length,
      toolRoundTrips: observedToolRoundTrips,
      usage: sumUsage(observedUsagePerTurn),
      usagePerTurn: observedUsagePerTurn,
      ...traceSummary,
      ...(code ? { code } : {}),
      ...(sandbox ? { sandbox } : {}),
      finalText: "",
      trace: catalog.trace,
    };
  }
}

function buildTools(
  strategy: BenchmarkStrategy,
  catalog: CatalogService,
  setSandbox: (sandbox: SandboxResult, code: string) => void,
): ToolSet {
  if (strategy === "execute") {
    return {
      execute: tool<{ code: string }, SandboxResult>({
        description:
          "Execute the entire user task in one sandboxed JavaScript program. The program must discover, describe, and invoke all required integration tools before it returns; discovery-only programs fail the task.",
        inputSchema: jsonSchema(toAiSchema(EXECUTE_INPUT_SCHEMA)),
        execute: async ({ code }) => {
          const result = await runSandbox({ code, catalog });
          setSandbox(result, code);
          return result;
        },
      }),
    };
  }

  if (strategy === "tiered") {
    return {
      catalog_search: tool({
        description:
          "Search the unloaded integration catalog by intent. Returns ranked tool paths.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            query: { type: "string", description: "Intent-oriented search query." },
            limit: { type: "integer", description: "Maximum candidates, from 1 to 20." },
          },
          required: ["query"],
          additionalProperties: false,
        }),
        execute: async (rawInput) => {
          const input = rawInput as { query: string; limit?: number };
          return catalog.search(input.query, input.limit);
        },
      }),
      catalog_describe: tool({
        description: "Load the complete input/output schema for exactly one catalog tool path.",
        inputSchema: jsonSchema({
          type: "object",
          properties: { path: { type: "string", description: "Exact path returned by search." } },
          required: ["path"],
          additionalProperties: false,
        }),
        execute: async (rawInput) => catalog.describe((rawInput as { path: string }).path),
      }),
      catalog_invoke: tool({
        description: "Invoke one catalog tool after describing it.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            path: { type: "string", description: "Exact described tool path." },
            input: {
              type: "object",
              description: "Input that matches the schema returned by catalog_describe.",
              additionalProperties: true,
            },
          },
          required: ["path", "input"],
          additionalProperties: false,
        }),
        execute: async (rawInput) => {
          const args = rawInput as { path: string; input: unknown };
          return catalog.invoke(args.path, args.input);
        },
      }),
    };
  }

  return Object.fromEntries(
    MOCK_TOOL_CATALOG.map((item) => [
      flatToolName(item.path),
      tool({
        description: `${item.summary} Catalog path: ${item.path}.`,
        inputSchema: jsonSchema(toAiSchema(item.inputSchema)),
        execute: async (rawInput) => catalog.invoke(item.path, rawInput),
      }),
    ]),
  );
}

function systemPrompt(strategy: BenchmarkStrategy) {
  if (strategy === "execute") return EXECUTE_SYSTEM_PROMPT;
  if (strategy === "tiered") return TIERED_SYSTEM_PROMPT;
  return FLAT_SYSTEM_PROMPT;
}

function flatToolName(path: string) {
  return path.replaceAll(".", "__");
}

function summarizeTrace(catalog: CatalogService) {
  const searchedQueries = catalog.trace
    .filter((event) => event.kind === "search" && event.query)
    .map((event) => event.query as string);
  const describedTools = catalog.trace
    .filter((event) => event.kind === "describe" && event.path)
    .map((event) => event.path as string);
  const invokedTools = catalog.trace
    .filter((event) => (event.kind === "invoke" || event.kind === "invoke_error") && event.path)
    .map((event) => event.path as string);
  const invokedSet = new Set(invokedTools);
  const overfetchCount = new Set(describedTools.filter((path) => !invokedSet.has(path))).size;
  return { searchedQueries, describedTools, invokedTools, overfetchCount };
}

function evaluateTask(
  task: BenchmarkTask,
  strategy: BenchmarkStrategy,
  catalog: CatalogService,
  sandbox: SandboxResult | undefined,
) {
  const failures: string[] = [];
  const invoked = catalog.trace.filter(
    (event) => event.kind === "invoke" || event.kind === "invoke_error",
  );
  const paths = invoked.map((event) => event.path).filter((path): path is string => Boolean(path));
  if (sandbox && !sandbox.ok)
    failures.push(`sandbox:${sandbox.failureKind ?? "runtime"}:${sandbox.error}`);
  if (paths.length < task.minToolCalls) {
    failures.push(`expected >=${task.minToolCalls} catalog calls, received ${paths.length}`);
  }
  for (const required of task.requiredTools) {
    if (!paths.includes(required)) failures.push(`missing required tool ${required}`);
  }
  for (const group of task.anyOfTools ?? []) {
    if (!group.some((path) => paths.includes(path)))
      failures.push(`missing one of: ${group.join(", ")}`);
  }

  if (strategy !== "flat") {
    const described = new Set(
      catalog.trace
        .filter((event) => event.kind === "describe")
        .map((event) => event.path)
        .filter((path): path is string => Boolean(path)),
    );
    const invokedWithoutDescribe = [...new Set(paths.filter((path) => !described.has(path)))];
    if (invokedWithoutDescribe.length > 0) {
      failures.push(`invoked without describe: ${invokedWithoutDescribe.join(", ")}`);
    }
  }

  const mutation = (path: string) => catalog.mutations.filter((item) => item.path === path);
  if (task.id === "fault-recover-tool-error") {
    const expectedReason =
      "GitHub rejected the merge: branch protection requires the security-review check.";
    const mergeError = catalog.trace.find(
      (event) =>
        event.kind === "invoke_error" &&
        event.path === "github.merge_pull_request" &&
        event.errorKind === "tool_error",
    );
    const slackText = mutation("slack.send_message")
      .map((item) => stringifyCompact(item.input))
      .join(" ");
    if (mergeError?.error !== expectedReason) {
      failures.push("did not reach the seeded GitHub branch-protection rejection");
    }
    if (!slackText.includes(expectedReason)) {
      failures.push("Slack message omitted the exact seeded rejection reason");
    }
  }
  return failures;
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
    zeroUsage(),
  );
}

function zeroUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

function stringifyCompact(value: unknown) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? "");
  }
}

function elapsed(started: number) {
  return Math.round((performance.now() - started) * 1000) / 1000;
}
