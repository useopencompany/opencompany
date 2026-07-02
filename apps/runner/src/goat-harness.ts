import { shellQuote } from "@opencompany/agent-runtime";
import type {
  GoatHarnessSpec,
  GoatHarnessToolId,
  GoatTaskDebugTrace,
  goatTasks,
} from "@opencompany/db/goat-schema";
import { createLogger } from "@opencompany/observability";
import type { RunnerEnv } from "./env";
import { createGoatToolToken } from "./goat-tool-auth";
import { armSandboxIdleTimeout, commandExitResult, createOrConnectSandbox } from "./sandbox";

const logger = createLogger({ service: "opencompany-runner", runtime: "goat-harness" });

const GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";
const GOAT_PLANNER_MODEL = "openai/gpt-5.4-mini";
const GOAT_HARNESS_PATH = "/tmp/goat-harness.mjs";
const GOAT_HARNESS_TIMEOUT_MS = 10 * 60 * 1000;
const GOAT_TOOL_TOKEN_TTL_MS = GOAT_HARNESS_TIMEOUT_MS + 60_000;
const DEFAULT_GOAT_HARNESS_TOOLS: GoatHarnessToolId[] = ["exa", "goat_result"];
const GOAT_GOOGLE_HARNESS_TOOLS = new Set<GoatHarnessToolId>(["gmail", "google_calendar"]);

function goatHarnessSpecResponseSchema(availableTools: readonly GoatHarnessToolId[]) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      prompt: { type: "string" },
      model: { type: "string" },
      tools: {
        type: "array",
        items: { type: "string", enum: availableTools },
        minItems: 2,
        maxItems: availableTools.length,
      },
      resultMode: { type: "string", enum: ["freeform"] },
    },
    required: ["prompt", "model", "tools", "resultMode"],
  } as const;
}

type GoatTask = typeof goatTasks.$inferSelect;

export type GoatTaskExecutorInput = {
  task: GoatTask;
  env: RunnerEnv;
  signal: AbortSignal;
  reportStage: (
    stage: GoatTask["stage"],
    patch?: Partial<Pick<GoatTask, "harnessSpec" | "sandboxId">>,
  ) => Promise<void>;
};

export type GoatTaskExecutorResult = {
  result: string;
  harnessSpec: GoatHarnessSpec;
  debugTrace: GoatTaskDebugTrace;
  sandboxId: string;
};

export type FetchLike = typeof fetch;

export async function executeGoatTask(
  input: GoatTaskExecutorInput,
): Promise<GoatTaskExecutorResult> {
  if (!input.env.exaApiKey) {
    throw new Error("EXA_API_KEY is required for Goat tasks.");
  }

  await input.reportStage("planning");
  const availableTools = normalizeAvailableHarnessTools(input.task.harnessSpec.tools);
  const planned = await planGoatHarnessForTask({
    prompt: input.task.prompt,
    model: input.task.model,
    availableTools,
    gatewayApiKey: input.env.vercelAiGatewayApiKey,
    signal: input.signal,
  });
  const harnessSpec = planned.harnessSpec;
  await input.reportStage("sandboxing", { harnessSpec });
  assertNotAborted(input.signal);

  const sandbox = await createOrConnectSandbox({
    sandboxId: input.task.sandboxId,
    template: input.env.e2bTemplate,
    envs: {},
    idleTimeoutMs: input.env.e2bSandboxIdleTimeoutMs,
  });
  await armSandboxIdleTimeout(sandbox, input.env.e2bSandboxIdleTimeoutMs);
  await input.reportStage("running", { harnessSpec, sandboxId: sandbox.sandboxId });

  await sandbox.files.write(GOAT_HARNESS_PATH, buildGoatHarnessScript());
  const commandResult = await runGoatHarnessCommand({
    sandbox,
    harnessSpec,
    task: input.task,
    env: input.env,
  });
  const parsed = parseGoatHarnessOutput(String(commandResult.stdout ?? ""));
  const debugTrace = mergeDebugTrace(planned.debugTrace, parsed.debugTrace);
  if (!parsed.ok) {
    const stderr = String(commandResult.stderr ?? "").trim();
    const exitCode =
      typeof commandResult.exitCode === "number" && commandResult.exitCode !== 0
        ? `Goat harness failed (exit ${commandResult.exitCode}): `
        : "";
    throw new GoatHarnessRunError(
      stderr ? `${exitCode}${parsed.error}\n${stderr}` : `${exitCode}${parsed.error}`,
      debugTrace,
    );
  }

  logger.info("Goat harness completed", {
    event: "opencompany.goat_harness_completed",
    task_id: input.task.id,
    sandbox_id: sandbox.sandboxId,
  });

  return {
    result: parsed.result,
    harnessSpec,
    debugTrace,
    sandboxId: sandbox.sandboxId,
  };
}

async function runGoatHarnessCommand(input: {
  sandbox: Awaited<ReturnType<typeof createOrConnectSandbox>>;
  harnessSpec: GoatHarnessSpec;
  task: GoatTask;
  env: RunnerEnv;
}): Promise<{ stdout?: unknown; stderr?: unknown; exitCode?: number | null }> {
  try {
    const bridgeEnv = goatToolBridgeEnv(input);
    return await input.sandbox.commands.run(`node ${shellQuote(GOAT_HARNESS_PATH)}`, {
      timeoutMs: GOAT_HARNESS_TIMEOUT_MS,
      envs: {
        VERCEL_AI_GATEWAY_API_KEY: input.env.vercelAiGatewayApiKey,
        EXA_API_KEY: input.env.exaApiKey ?? "",
        GOAT_MODEL: input.harnessSpec.model ?? input.task.model,
        GOAT_PROMPT: input.harnessSpec.prompt ?? input.task.prompt,
        GOAT_HARNESS_SPEC: JSON.stringify(input.harnessSpec),
        ...bridgeEnv,
      },
    });
  } catch (error) {
    const exitResult = commandExitResult(error);
    if (exitResult) return exitResult;
    throw error;
  }
}

export async function planGoatHarness(input: {
  prompt: string;
  model: string;
  gatewayApiKey: string;
  availableTools?: readonly GoatHarnessToolId[];
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}): Promise<GoatHarnessSpec> {
  return (await planGoatHarnessForTask(input)).harnessSpec;
}

async function planGoatHarnessForTask(input: {
  prompt: string;
  model: string;
  gatewayApiKey: string;
  availableTools?: readonly GoatHarnessToolId[];
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}): Promise<{ harnessSpec: GoatHarnessSpec; debugTrace: GoatTaskDebugTrace }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const availableTools = normalizeAvailableHarnessTools(input.availableTools);
  const schema = goatHarnessSpecResponseSchema(availableTools);
  const messages = [
    {
      role: "system",
      content: `Return only JSON for a Goat just-in-time harness spec. Schema: {"prompt":string,"model":string,"tools":${JSON.stringify(
        availableTools,
      )},"resultMode":"freeform"}. Tool ids are provider-level only. Always include "exa" and "goat_result". Include "gmail" only if the task needs Gmail. Include "google_calendar" only if the task needs Calendar. Do not add operation-level tool names, shell tools, files, or network targets.`,
    },
    {
      role: "user",
      content: `Selected model: ${input.model}\n\nTask:\n${input.prompt}`,
    },
  ];
  const responseFormat = {
    type: "json_schema",
    json_schema: {
      name: "goat_harness_spec",
      schema,
      strict: true,
    },
  };
  const response = await fetchImpl(`${GATEWAY_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.gatewayApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GOAT_PLANNER_MODEL,
      stream: false,
      temperature: 0,
      response_format: responseFormat,
      messages,
    }),
    ...(input.signal ? { signal: input.signal } : {}),
  });

  const body = await safeJson(response);
  if (!response.ok) {
    throw new Error(
      `Goat harness planning failed (${response.status}): ${gatewayErrorDetail(
        body,
        response.statusText,
      )}`,
    );
  }

  const content = readAssistantContent(body);
  return {
    harnessSpec: normalizeHarnessSpec(
      parseHarnessSpec(content),
      {
        prompt: input.prompt,
        model: input.model,
      },
      availableTools,
    ),
    debugTrace: {
      schemaVersion: "goat.debug.v1",
      planner: {
        model: GOAT_PLANNER_MODEL,
        request: {
          messages,
          responseFormat,
        },
        response: {
          content,
        },
      },
    },
  };
}

export type GoatHarnessOutput =
  | { ok: true; result: string; debugTrace?: GoatTaskDebugTrace }
  | { ok: false; error: string; debugTrace?: GoatTaskDebugTrace };

export function parseGoatHarnessOutput(stdout: string): GoatHarnessOutput {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line) continue;
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== "object") continue;
      const record = parsed as Record<string, unknown>;
      if (record.ok === true) {
        const result = typeof record.result === "string" ? record.result : record.text;
        if (typeof result === "string" && result.trim()) {
          const debugTrace = readDebugTrace(record.debugTrace);
          return {
            ok: true,
            result: result.trim(),
            ...(debugTrace ? { debugTrace } : {}),
          };
        }
      }
      if (record.ok === false) {
        const error = typeof record.error === "string" ? record.error : "Goat harness failed.";
        const debugTrace = readDebugTrace(record.debugTrace);
        return { ok: false, error, ...(debugTrace ? { debugTrace } : {}) };
      }
    } catch {
      // Ignore log lines that merely look like JSON.
    }
  }

  const fallback = stdout.trim();
  if (fallback) return { ok: true, result: fallback };
  return { ok: false, error: "Goat harness did not return a result." };
}

class GoatHarnessRunError extends Error {
  debugTrace: GoatTaskDebugTrace;

  constructor(message: string, debugTrace: GoatTaskDebugTrace) {
    super(message);
    this.name = "GoatHarnessRunError";
    this.debugTrace = debugTrace;
  }
}

function readDebugTrace(value: unknown): GoatTaskDebugTrace | undefined {
  return value && typeof value === "object" ? (value as GoatTaskDebugTrace) : undefined;
}

function mergeDebugTrace(
  plannerTrace: GoatTaskDebugTrace,
  harnessTrace: GoatTaskDebugTrace | undefined,
): GoatTaskDebugTrace {
  const merged: GoatTaskDebugTrace = {
    schemaVersion: "goat.debug.v1",
  };
  if (plannerTrace.planner) merged.planner = plannerTrace.planner;
  if (harnessTrace?.harness) merged.harness = harnessTrace.harness;
  return merged;
}

function normalizeHarnessSpec(
  raw: Partial<GoatHarnessSpec> | null,
  fallback: { prompt: string; model: string },
  availableTools: readonly GoatHarnessToolId[],
): GoatHarnessSpec {
  const available = normalizeAvailableHarnessTools(availableTools);
  const rawTools = Array.isArray(raw?.tools) ? raw.tools : [];
  const selected = new Set<GoatHarnessToolId>(["exa", "goat_result"]);
  for (const tool of rawTools) {
    const normalized = normalizeHarnessToolId(tool);
    if (normalized && available.includes(normalized)) selected.add(normalized);
  }

  return {
    prompt:
      typeof raw?.prompt === "string" && raw.prompt.trim() ? raw.prompt.trim() : fallback.prompt,
    model: fallback.model,
    tools: available.filter((tool) => selected.has(tool)),
    resultMode: "freeform",
  };
}

function normalizeAvailableHarnessTools(value: unknown): GoatHarnessToolId[] {
  const selected = new Set<GoatHarnessToolId>(DEFAULT_GOAT_HARNESS_TOOLS);
  if (Array.isArray(value)) {
    for (const item of value) {
      const normalized = normalizeHarnessToolId(item);
      if (normalized) selected.add(normalized);
    }
  }
  const ordered: GoatHarnessToolId[] = ["exa", "gmail", "google_calendar", "goat_result"];
  return ordered.filter((tool) => selected.has(tool));
}

function normalizeHarnessToolId(value: unknown): GoatHarnessToolId | null {
  if (value === "exa" || value === "exa_search") return "exa";
  if (value === "gmail") return "gmail";
  if (value === "google_calendar") return "google_calendar";
  if (value === "goat_result") return "goat_result";
  return null;
}

function goatToolBridgeEnv(input: {
  harnessSpec: GoatHarnessSpec;
  task: GoatTask;
  env: RunnerEnv;
}) {
  const tools = normalizeAvailableHarnessTools(input.harnessSpec.tools);
  const needsBridge = tools.some((tool) => GOAT_GOOGLE_HARNESS_TOOLS.has(tool));
  if (!needsBridge || !input.env.publicUrl) return {};
  return {
    GOAT_TOOL_BASE_URL: `${input.env.publicUrl.replace(/\/+$/, "")}/goat/tools/${encodeURIComponent(
      input.task.id,
    )}`,
    GOAT_TOOL_TOKEN: createGoatToolToken({
      taskId: input.task.id,
      userWorkosId: input.task.userWorkosId,
      secret: input.env.internalToken,
      expiresInMs: GOAT_TOOL_TOKEN_TTL_MS,
    }),
  };
}

function parseHarnessSpec(content: string | null): Partial<GoatHarnessSpec> | null {
  if (!content) return null;
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Partial<GoatHarnessSpec>) : null;
  } catch {
    return null;
  }
}

async function safeJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function readAssistantContent(body: unknown) {
  if (!body || typeof body !== "object") return null;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return null;
  const first = choices[0] as { message?: { content?: unknown } } | undefined;
  return typeof first?.message?.content === "string" ? first.message.content : null;
}

function gatewayErrorDetail(body: unknown, fallback: string) {
  if (body && typeof body === "object") {
    const error = (body as { error?: unknown }).error;
    if (error && typeof error === "object") {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) return message.trim();
    }
  }
  if (typeof body === "string" && body.trim()) return body.trim().slice(0, 1_000);
  return fallback;
}

function assertNotAborted(signal: AbortSignal) {
  if (signal.aborted) {
    throw new Error("Goat task was aborted.");
  }
}

function buildGoatHarnessScript() {
  return `
const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/chat/completions";
const EXA_SEARCH_URL = "https://api.exa.ai/search";
const MAX_TOOL_STEPS = 8;

const gatewayKey = requiredEnv("VERCEL_AI_GATEWAY_API_KEY");
const exaKey = requiredEnv("EXA_API_KEY");
const model = requiredEnv("GOAT_MODEL");
const prompt = requiredEnv("GOAT_PROMPT");
const harnessSpec = parseHarnessSpecEnv();
const enabledProviders = new Set(Array.isArray(harnessSpec.tools) ? harnessSpec.tools : []);
const goatToolBaseUrl = process.env.GOAT_TOOL_BASE_URL || "";
const goatToolToken = process.env.GOAT_TOOL_TOKEN || "";
const GOAT_REMOTE_TOOL_NAMES = new Set([
  "gmail_search",
  "gmail_get_message",
  "gmail_list_threads",
  "gmail_get_thread",
  "calendar_list_calendars",
  "calendar_list_events",
  "calendar_get_event",
  "calendar_get_freebusy",
]);

const tools = buildTools();

function buildTools() {
  const items = [];
  if (enabledProviders.has("exa")) items.push(exaSearchTool());
  if (enabledProviders.has("gmail") && goatToolBaseUrl && goatToolToken) {
    items.push(
      {
        type: "function",
        function: {
          name: "gmail_search",
          description:
            "Search connected Gmail with Gmail query syntax and return message ids, snippets, and headers. Read-only.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              query: { type: "string" },
              maxResults: { type: "number", minimum: 1, maximum: 50 },
            },
            required: ["query"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "gmail_get_message",
          description:
            "Fetch one connected Gmail message by id, including headers, snippet, labels, and decoded plain text. Read-only.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              messageId: { type: "string" },
            },
            required: ["messageId"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "gmail_list_threads",
          description:
            "List connected Gmail threads, optionally filtered by Gmail query syntax. Read-only.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              query: { type: "string" },
              maxResults: { type: "number", minimum: 1, maximum: 50 },
            },
          },
        },
      },
      {
        type: "function",
        function: {
          name: "gmail_get_thread",
          description:
            "Fetch a connected Gmail thread by id, including each message's headers and decoded plain text. Read-only.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              threadId: { type: "string" },
            },
            required: ["threadId"],
          },
        },
      },
    );
  }
  if (enabledProviders.has("google_calendar") && goatToolBaseUrl && goatToolToken) {
    items.push(
      {
        type: "function",
        function: {
          name: "calendar_list_calendars",
          description: "List calendars visible to the connected Google Calendar account. Read-only.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {},
          },
        },
      },
      {
        type: "function",
        function: {
          name: "calendar_list_events",
          description:
            "List Google Calendar events for a calendar and optional time range. Read-only.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              calendarId: { type: "string" },
              timeMin: { type: "string" },
              timeMax: { type: "string" },
              query: { type: "string" },
              maxResults: { type: "number", minimum: 1, maximum: 50 },
            },
          },
        },
      },
      {
        type: "function",
        function: {
          name: "calendar_get_event",
          description: "Fetch one Google Calendar event by calendar id and event id. Read-only.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              calendarId: { type: "string" },
              eventId: { type: "string" },
            },
            required: ["eventId"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "calendar_get_freebusy",
          description: "Check free/busy blocks for connected Google calendars. Read-only.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              timeMin: { type: "string" },
              timeMax: { type: "string" },
              calendarIds: { type: "array", items: { type: "string" } },
            },
            required: ["timeMin", "timeMax"],
          },
        },
      },
    );
  }
  items.push(goatResultTool());
  return items;
}

function exaSearchTool() {
  return {
    type: "function",
    function: {
      name: "exa_search",
      description: "Search the web with Exa and return concise results.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string" },
          numResults: { type: "number", minimum: 1, maximum: 10 },
          type: {
            type: "string",
            enum: ["auto", "fast", "instant", "deep-lite", "deep", "deep-reasoning"],
          },
        },
        required: ["query"],
      },
    },
  };
}

function goatResultTool() {
  return {
    type: "function",
    function: {
      name: "goat_result",
      description: "Return the final result for the user's Goat task.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string" },
        },
        required: ["text"],
      },
    },
  };
}

const messages = [
  {
    role: "system",
    content:
      "You are the Goat task harness. Use the available tools only when needed, treat Gmail and Google Calendar as read-only private context, and never claim to send or modify anything. You must finish by calling goat_result({ text }). Keep the result useful, direct, and source-aware when search was used.",
  },
  { role: "user", content: prompt },
];

let fallbackText = "";
const turns = [];

try {
  for (let step = 0; step < MAX_TOOL_STEPS; step += 1) {
    const requestMessages = messages.map(sanitizeMessage);
    const completion = await chatCompletion(messages);
    const message = completion.choices?.[0]?.message;
    if (!message) throw new Error("Model returned no message.");
    if (typeof message.content === "string" && message.content.trim()) {
      fallbackText = message.content.trim();
    }

    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const assistantMessage = {
      role: "assistant",
      content: message.content ?? null,
      tool_calls: toolCalls,
    };
    const turn = {
      step,
      requestMessages,
      responseMessage: sanitizeMessage(assistantMessage),
      toolResults: [],
    };
    if (toolCalls.length === 0) {
      turns.push(turn);
      break;
    }
    messages.push(assistantMessage);

    for (const toolCall of toolCalls) {
      const name = toolCall?.function?.name;
      const args = parseArgs(toolCall?.function?.arguments);
      if (name === "goat_result") {
        const text = typeof args.text === "string" ? args.text.trim() : "";
        if (!text) throw new Error("goat_result text must not be empty.");
        turn.toolResults.push({
          toolCallId: toolCall.id,
          name,
          args: sanitizeValue(args),
          result: { text },
        });
        turns.push(turn);
        outputSuccess(text);
        process.exit(0);
      }

      if (name === "exa_search") {
        let result;
        try {
          result = await exaSearch(args);
        } catch (error) {
          turn.toolResults.push({
            toolCallId: toolCall.id,
            name,
            args: sanitizeValue(args),
            error: error instanceof Error ? error.message : "exa_search failed",
          });
          turns.push(turn);
          throw error;
        }
        turn.toolResults.push({
          toolCallId: toolCall.id,
          name,
          args: sanitizeValue(args),
          result: compactExaResult(result),
        });
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result).slice(0, 20_000),
        });
        continue;
      }

      if (GOAT_REMOTE_TOOL_NAMES.has(name)) {
        let result;
        try {
          result = await goatRemoteTool(name, args);
        } catch (error) {
          turn.toolResults.push({
            toolCallId: toolCall.id,
            name,
            args: sanitizeValue(args),
            error: error instanceof Error ? error.message : "Goat remote tool failed",
          });
          turns.push(turn);
          throw error;
        }
        turn.toolResults.push({
          toolCallId: toolCall.id,
          name,
          args: sanitizeValue(args),
          result: sanitizeValue(result),
        });
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result).slice(0, 20_000),
        });
        continue;
      }

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify({ error: "Unknown tool." }),
      });
      turn.toolResults.push({
        toolCallId: toolCall.id,
        name: typeof name === "string" ? name : "unknown",
        args: sanitizeValue(args),
        error: "Unknown tool.",
      });
    }
    turns.push(turn);
  }

  if (fallbackText) {
    outputSuccess(fallbackText);
  } else {
    output({
      ok: false,
      error: "The model did not call goat_result or produce final text.",
      debugTrace: buildDebugTrace(),
    });
  }
} catch (error) {
  output({
    ok: false,
    error: error instanceof Error ? error.message : "Goat harness failed.",
    debugTrace: buildDebugTrace(),
  });
  process.exitCode = 1;
}

function outputSuccess(result) {
  output({ ok: true, result, debugTrace: buildDebugTrace() });
}

function buildDebugTrace() {
  return {
    schemaVersion: "goat.debug.v1",
    harness: {
      model,
      turns,
    },
  };
}

async function chatCompletion(messages) {
  const response = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: {
      Authorization: \`Bearer \${gatewayKey}\`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      tools,
      tool_choice: "auto",
    }),
  });
  const body = await readJson(response);
  if (!response.ok) {
    throw new Error(\`Vercel AI Gateway failed (\${response.status}): \${body?.error?.message ?? response.statusText}\`);
  }
  return body;
}

async function exaSearch(args) {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) throw new Error("exa_search query must not be empty.");
  const response = await fetch(EXA_SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": exaKey,
    },
    body: JSON.stringify({
      query,
      type: typeof args.type === "string" ? args.type : "auto",
      numResults: clampNumber(args.numResults, 1, 10, 5),
      contents: { highlights: true },
    }),
  });
  const body = await readJson(response);
  if (!response.ok) {
    throw new Error(\`Exa search failed (\${response.status}): \${body?.error ?? response.statusText}\`);
  }
  return {
    requestId: body?.requestId,
    results: Array.isArray(body?.results)
      ? body.results.slice(0, 10).map((result) => ({
          title: result.title,
          url: result.url,
          publishedDate: result.publishedDate,
          author: result.author,
          text: result.text,
          highlights: result.highlights,
        }))
      : [],
  };
}

async function goatRemoteTool(name, args) {
  if (!goatToolBaseUrl || !goatToolToken) {
    throw new Error("Goat Google tools are not available in this runtime.");
  }
  const response = await fetch(goatToolBaseUrl, {
    method: "POST",
    headers: {
      Authorization: \`Bearer \${goatToolToken}\`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, args }),
  });
  const body = await readJson(response);
  if (!response.ok || body?.ok === false) {
    throw new Error(body?.error || \`Goat tool \${name} failed with \${response.status}.\`);
  }
  return body?.output;
}

function compactExaResult(result) {
  return {
    requestId: result?.requestId,
    results: Array.isArray(result?.results)
      ? result.results.slice(0, 10).map((item) => ({
          title: item?.title,
          url: item?.url,
          publishedDate: item?.publishedDate,
          author: item?.author,
          text: truncateText(item?.text, 1_500),
          highlights: Array.isArray(item?.highlights)
            ? item.highlights.map((highlight) => truncateText(highlight, 500))
            : undefined,
        }))
      : [],
  };
}

function parseHarnessSpecEnv() {
  const raw = process.env.GOAT_HARNESS_SPEC;
  if (typeof raw !== "string" || !raw.trim()) return { tools: ["exa", "goat_result"] };
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : { tools: ["exa", "goat_result"] };
  } catch {
    return { tools: ["exa", "goat_result"] };
  }
}

function sanitizeMessage(message) {
  return {
    role: message?.role,
    content: truncateText(message?.content, 4_000),
    tool_call_id: message?.tool_call_id,
    tool_calls: Array.isArray(message?.tool_calls)
      ? message.tool_calls.map((toolCall) => ({
          id: toolCall?.id,
          type: toolCall?.type,
          function: {
            name: toolCall?.function?.name,
            arguments: truncateText(toolCall?.function?.arguments, 4_000),
          },
        }))
      : undefined,
  };
}

function sanitizeValue(value) {
  if (typeof value === "string") return truncateText(value, 4_000);
  if (Array.isArray(value)) return value.slice(0, 20).map(sanitizeValue);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 50)) {
    out[key] = sanitizeValue(item);
  }
  return out;
}

function truncateText(value, max) {
  if (value == null) return value;
  const text = String(value);
  return text.length > max ? \`\${text.slice(0, max)}...[truncated]\` : text;
}

async function readJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { raw: text };
  }
}

function parseArgs(raw) {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(\`\${name} is required.\`);
  return value;
}

function output(payload) {
  console.log(JSON.stringify(payload));
}
`;
}
