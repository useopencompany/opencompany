import { createGateway, generateText, jsonSchema, stepCountIs, type ToolSet, tool } from "ai";
import { analyzeAdaptiveToolQuery, renderAdaptiveLevel0, renderAdaptiveLevel1 } from "./activation";
import { ADAPTIVE_TOOL_REGISTRY, adaptiveIntegrationById, adaptiveToolByPointer } from "./registry";
import type {
  AdaptiveAgentRun,
  AdaptiveExpansionEvent,
  AdaptiveExposureSnapshot,
  AdaptiveObservedCall,
  AdaptiveStepMeasurement,
  AdaptiveToolDefinition,
} from "./types";

const EXPAND_INTEGRATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    pointer: { type: "string", description: "An integration:// pointer from Level 0." },
    intent: {
      type: "string",
      description: "Optional operation intent used only to order results.",
    },
  },
  required: ["pointer"],
} as const;

const INSPECT_TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    pointer: { type: "string", description: "A tool:// pointer from a Level-1 card or directory." },
  },
  required: ["pointer"],
} as const;

const CALL_TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    pointer: { type: "string", description: "Exact tool:// pointer." },
    arguments: {
      type: "object",
      description: "Arguments matching the tool's compact signature or inspected full schema.",
      additionalProperties: true,
    },
  },
  required: ["pointer", "arguments"],
} as const;

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function integrationIdFromPointer(pointer: string) {
  return pointer.startsWith("integration://") ? pointer.slice("integration://".length) : "";
}

function toolDirectory(integrationId: string) {
  const integration = adaptiveIntegrationById(integrationId);
  if (!integration) return null;
  return {
    pointer: integration.pointer,
    integration: integration.name,
    tools: integration.tools.map((toolDefinition) => ({
      pointer: toolDefinition.pointer,
      signature: toolSignature(toolDefinition),
      description: toolDefinition.description,
      sideEffect: toolDefinition.sideEffect,
      outputKind: toolDefinition.outputKind,
    })),
  };
}

function toolSignature(toolDefinition: AdaptiveToolDefinition) {
  const schema = toolDefinition.inputSchema as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  const required = new Set(schema.required ?? []);
  const args = Object.keys(schema.properties ?? {})
    .map((name) => (required.has(name) ? name : `${name}?`))
    .join(", ");
  return `${toolDefinition.name}(${args})`;
}

function fullToolDefinition(toolDefinition: AdaptiveToolDefinition) {
  return {
    pointer: toolDefinition.pointer,
    name: toolDefinition.name,
    description: toolDefinition.description,
    sideEffect: toolDefinition.sideEffect,
    outputKind: toolDefinition.outputKind,
    inputSchema: toolDefinition.inputSchema,
    example: toolDefinition.example,
    conventions: [
      "Use lookup results instead of inventing opaque IDs.",
      "Omit optional fields instead of sending null.",
      "All execution in this experiment is simulated and has no external side effects.",
    ],
  };
}

function validateToolArguments(toolDefinition: AdaptiveToolDefinition, args: UnknownRecord) {
  const schema = toolDefinition.inputSchema as {
    properties?: Record<string, { type?: "string" | "integer" | "boolean" | "array" | "object" }>;
    required?: string[];
  };
  for (const name of schema.required ?? []) {
    if (!(name in args)) return `Missing required argument: ${name}`;
  }
  for (const [name, value] of Object.entries(args)) {
    const property = schema.properties?.[name];
    if (!property) return `Unknown argument: ${name}`;
    if (property.type === "string" && typeof value !== "string") return `${name} must be a string.`;
    if (property.type === "integer" && !Number.isInteger(value))
      return `${name} must be an integer.`;
    if (property.type === "boolean" && typeof value !== "boolean")
      return `${name} must be a boolean.`;
    if (property.type === "array" && !Array.isArray(value)) return `${name} must be an array.`;
    if (
      property.type === "object" &&
      (!value || typeof value !== "object" || Array.isArray(value))
    ) {
      return `${name} must be an object.`;
    }
  }
  return null;
}

function simulatedResult(integrationId: string, toolName: string, args: UnknownRecord): unknown {
  if (integrationId === "gmail" && toolName === "search_emails") {
    return {
      messages: [
        {
          emailId: "email_ada_launch",
          threadId: "thread_launch",
          from: "Ada Lovelace <ada@example.com>",
          subject: "Launch readiness",
          snippet: "The launch checklist is complete. The remaining risk is the mobile OAuth fix.",
        },
      ],
    };
  }
  if (integrationId === "gmail" && toolName === "get_email") {
    return {
      emailId: args.emailId,
      from: "Ada Lovelace <ada@example.com>",
      subject: "Launch readiness",
      body: "The launch checklist is complete. The remaining risk is the mobile OAuth fix.",
    };
  }
  if (integrationId === "slack" && toolName === "search_messages") {
    return {
      messages: [
        {
          channelId: "C_LAUNCH",
          channel: "#launch",
          timestamp: "1784282400.000100",
          text: "Launch is green once ENG-417 lands.",
          threadTs: "1784282400.000100",
        },
      ],
    };
  }
  if (integrationId === "slack" && toolName === "list_channels") {
    return {
      channels: [
        { id: "C_LAUNCH", name: "launch" },
        { id: "C_ENG", name: "eng" },
        { id: "C_ANNOUNCEMENTS", name: "announcements" },
      ],
    };
  }
  if (integrationId === "linear" && (toolName === "list_issues" || toolName === "search_issues")) {
    return {
      issues: [
        {
          id: "lin_417",
          identifier: "ENG-417",
          title: "Fix mobile OAuth callback",
          status: "In Progress",
        },
        { id: "lin_422", identifier: "ENG-422", title: "Verify launch dashboards", status: "Todo" },
      ],
    };
  }
  if (integrationId === "github" && toolName === "list_pull_requests") {
    return {
      pullRequests: [
        { number: 77, title: "Fix mobile OAuth callback", state: "open", author: "ada" },
      ],
    };
  }
  if (integrationId === "github" && toolName === "get_pull_request") {
    return {
      pullRequest: {
        number: args.pullNumber,
        title: "Fix mobile OAuth callback",
        state: "open",
        files: ["apps/goat/lib/auth.ts"],
      },
    };
  }
  if (integrationId === "notion" && toolName === "search") {
    return {
      pages: [
        { pageId: "page_launch", title: "Q3 launch plan", excerpt: "Owner: Ada. Status: green." },
      ],
    };
  }
  if (integrationId === "calendar" && toolName === "find_availability") {
    return {
      slots: [
        { start: "2026-07-20T10:00:00+02:00", end: "2026-07-20T10:30:00+02:00" },
        { start: "2026-07-20T14:00:00+02:00", end: "2026-07-20T14:30:00+02:00" },
      ],
    };
  }
  if (
    integrationId === "calendar" &&
    (toolName === "list_events" || toolName === "search_events")
  ) {
    return {
      events: [
        { eventId: "event_launch", title: "Launch review", start: "2026-07-20T09:00:00+02:00" },
      ],
    };
  }
  return {
    ok: true,
    simulated: true,
    id: `${integrationId}_${toolName}_result`,
    received: args,
  };
}

export function executeAdaptiveSimulatedTool(
  pointer: string,
  inputArguments: unknown,
): { observed: AdaptiveObservedCall; response: unknown } {
  const args = record(inputArguments);
  const resolved = adaptiveToolByPointer(pointer);
  if (!resolved) {
    const error = `Unknown tool pointer: ${pointer}`;
    return {
      observed: {
        pointer,
        integrationId: "unknown",
        toolName: "unknown",
        arguments: args,
        valid: false,
        error,
      },
      response: { ok: false, error },
    };
  }

  const validationError = validateToolArguments(resolved.tool, args);
  if (validationError) {
    return {
      observed: {
        pointer,
        integrationId: resolved.integration.id,
        toolName: resolved.tool.name,
        arguments: args,
        valid: false,
        error: validationError,
      },
      response: {
        ok: false,
        code: "INVALID_TOOL_ARGUMENTS",
        error: validationError,
        relevantSchema: resolved.tool.inputSchema,
      },
    };
  }

  const result = simulatedResult(resolved.integration.id, resolved.tool.name, args);
  return {
    observed: {
      pointer,
      integrationId: resolved.integration.id,
      toolName: resolved.tool.name,
      arguments: args,
      valid: true,
      result,
    },
    response: { ok: true, pointer, simulated: true, result },
  };
}

export function adaptiveSystemPrompt(snapshot: AdaptiveExposureSnapshot) {
  return `You are running a simulated integration-agent experiment.

Complete the user's request by calling the simulated tools. Never claim that an operation happened unless you called its tool. All calls are mock-only, but behave as if their results are real within this experiment. Use results from earlier calls when later calls depend on them. Once the task is complete, summarize what the simulated tools did in two or three concise sentences.

Tool exposure is lossless:
- Level 0 lists every available integration and its integration:// pointer.
- Level 1 contains deterministic request-specific candidates, not an exhaustive list.
- Call a candidate with call_tool when its compact signature is sufficient.
- Use expand_integration when a needed tool is absent, and inspect_tool only when you need its full schema.
- The engine resolves and validates the full schema at call time.

Level 0 — all simulated integrations:
${renderAdaptiveLevel0()}

Level 1 — candidates selected for this request:
${renderAdaptiveLevel1(snapshot)}`;
}

export function createAdaptiveToolRuntime() {
  const calls: AdaptiveObservedCall[] = [];
  const expansions: AdaptiveExpansionEvent[] = [];
  let sequence = 0;

  const tools: ToolSet = {
    expand_integration: tool({
      description:
        "Expand an integration:// pointer to its complete short tool directory when the automatic candidate view does not cover the request.",
      inputSchema: jsonSchema(EXPAND_INTEGRATION_SCHEMA as never),
      execute: async (rawInput: unknown) => {
        const input = record(rawInput);
        const pointer = String(input.pointer ?? "");
        const directory = toolDirectory(integrationIdFromPointer(pointer));
        if (!directory) return { ok: false, error: `Unknown integration pointer: ${pointer}` };
        expansions.push({ sequence: sequence++, level: 1, pointer, reason: "model_request" });
        return { ok: true, directory };
      },
    } as never) as ToolSet[string],
    inspect_tool: tool({
      description:
        "Expand a tool:// pointer to its full Level-2 schema, example, and conventions when the compact signature is insufficient.",
      inputSchema: jsonSchema(INSPECT_TOOL_SCHEMA as never),
      execute: async (rawInput: unknown) => {
        const pointer = String(record(rawInput).pointer ?? "");
        const resolved = adaptiveToolByPointer(pointer);
        if (!resolved) return { ok: false, error: `Unknown tool pointer: ${pointer}` };
        expansions.push({ sequence: sequence++, level: 2, pointer, reason: "model_request" });
        return { ok: true, definition: fullToolDefinition(resolved.tool) };
      },
    } as never) as ToolSet[string],
    call_tool: tool({
      description:
        "Execute a simulated integration tool by stable pointer. The engine resolves the full schema, validates arguments, and records the mock call.",
      inputSchema: jsonSchema(CALL_TOOL_SCHEMA as never),
      execute: async (rawInput: unknown) => {
        const input = record(rawInput);
        const pointer = String(input.pointer ?? "");
        expansions.push({ sequence: sequence++, level: 2, pointer, reason: "call_time" });
        const execution = executeAdaptiveSimulatedTool(pointer, input.arguments);
        calls.push(execution.observed);
        return execution.response;
      },
    } as never) as ToolSet[string],
  };

  return { tools, calls, expansions };
}

function numberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stepMeasurements(rawSteps: readonly unknown[]): AdaptiveStepMeasurement[] {
  return rawSteps.map((rawStep, step) => {
    const value = record(rawStep);
    const usage = record(value.usage);
    const toolCalls = Array.isArray(value.toolCalls) ? value.toolCalls : [];
    return {
      step,
      inputTokens: numberOrNull(usage.inputTokens),
      outputTokens: numberOrNull(usage.outputTokens),
      modelToolCalls: toolCalls.map((call) => String(record(call).toolName ?? "unknown")),
    };
  });
}

function sumSteps(
  steps: readonly AdaptiveStepMeasurement[],
  field: "inputTokens" | "outputTokens",
) {
  return steps.reduce((total, step) => total + (step[field] ?? 0), 0);
}

export async function runAdaptiveToolAgent(input: {
  query: string;
  model: string;
  gatewayApiKey: string;
}): Promise<{ snapshot: AdaptiveExposureSnapshot; run: AdaptiveAgentRun }> {
  const snapshot = analyzeAdaptiveToolQuery(input.query);
  const runtime = createAdaptiveToolRuntime();
  const gateway = createGateway({ apiKey: input.gatewayApiKey });
  const startedAt = performance.now();
  const result = await generateText({
    model: gateway(input.model),
    system: adaptiveSystemPrompt(snapshot),
    messages: [{ role: "user", content: input.query }],
    tools: runtime.tools,
    stopWhen: stepCountIs(10),
    maxOutputTokens: 700,
  });
  const steps = stepMeasurements(result.steps);
  return {
    snapshot,
    run: {
      model: input.model,
      finalText: result.text,
      durationMs: performance.now() - startedAt,
      totalInputTokens: sumSteps(steps, "inputTokens"),
      totalOutputTokens: sumSteps(steps, "outputTokens"),
      steps,
      calls: runtime.calls,
      expansions: runtime.expansions,
    },
  };
}

export function adaptiveRegistrySummary() {
  return ADAPTIVE_TOOL_REGISTRY.map((integration) => ({
    id: integration.id,
    name: integration.name,
    toolCount: integration.tools.length,
  }));
}
