import { jsonSchema, type ToolSet, tool } from "ai";
import { registryToolCount, resolveTool } from "./registry";
import { matchIntegrations } from "./trigger";
import type {
  ExpansionTraceEvent,
  JsonSchema,
  MockIntegration,
  MockToolDefinition,
  ObservedToolCall,
  TriggerResult,
} from "./types";

const EXPAND_INTEGRATION_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    integration: {
      type: "string",
      description: "Integration ID from an integration:// pointer in the Level-0 catalog.",
    },
  },
  required: ["integration"],
};

const EXPAND_TOOL_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    integration: { type: "string", description: "Integration ID." },
    tool: { type: "string", description: "Tool name returned by a Level-1 directory." },
  },
  required: ["integration", "tool"],
};

const CALL_TOOL_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    integration: { type: "string", description: "Integration ID." },
    tool: { type: "string", description: "Exact tool name." },
    arguments: {
      type: "object",
      description:
        "Arguments for the selected tool. Use its Level-1 signature or expand_tool schema.",
      additionalProperties: true,
    },
  },
  required: ["integration", "tool", "arguments"],
};

const TIERED_META_TOOL_DESCRIPTIONS = {
  expand_integration:
    "Expand an integration:// lossless pointer to its complete Level-1 tool directory. Use when the auto-expanded curated tools do not cover the task or the integration was not auto-expanded.",
  expand_tool:
    "Expand a tool:// lossless pointer to the full Level-2 JSON schema, example, and conventions. Use when a Level-1 signature is insufficient.",
  call_integration_tool:
    "Call a mock integration tool. The engine resolves its full Level-2 definition at call time and validates arguments before execution.",
} as const;

export const BASE_AGENT_PROMPT = `You are an integration-tool selection benchmark agent.
Complete every requested operation with the available mock tools. Do not claim an operation succeeded unless you called its tool. Tool results contain stable mock IDs that can be used by later calls. Once every requested operation is complete, give a one-sentence summary. Do not perform unrelated operations.`;

function toolPointer(integrationId: string, toolName: string): string {
  return `tool://${integrationId}/${toolName}`;
}

function shortSignature(toolDefinition: MockToolDefinition): string {
  const required = new Set(toolDefinition.inputSchema.required ?? []);
  return Object.keys(toolDefinition.inputSchema.properties)
    .map((name) => (required.has(name) ? name : `${name}?`))
    .join(", ");
}

function renderToolLine(integration: MockIntegration, toolDefinition: MockToolDefinition): string {
  return `- ${toolDefinition.name}(${shortSignature(toolDefinition)}): ${toolDefinition.shortDescription} [${toolPointer(integration.id, toolDefinition.name)}]`;
}

export function renderLevel0(integrations: readonly MockIntegration[]): string {
  return integrations
    .map(
      (integration) =>
        `- ${integration.name} (${integration.id}): ${integration.summary} [${integration.pointer}]`,
    )
    .join("\n");
}

export function renderLevel1(integration: MockIntegration, curatedOnly: boolean): string {
  const tools = curatedOnly
    ? integration.curatedToolNames.map((name) => {
        const definition = integration.tools.find((toolDefinition) => toolDefinition.name === name);
        if (!definition) throw new Error(`Missing curated tool ${integration.id}.${name}.`);
        return definition;
      })
    : integration.tools;
  return [
    `${integration.name} Level 1 [${integration.pointer}]:`,
    ...tools.map((item) => renderToolLine(integration, item)),
  ].join("\n");
}

export function renderLevel2(
  integration: MockIntegration,
  toolDefinition: MockToolDefinition,
): Record<string, unknown> {
  return {
    pointer: toolPointer(integration.id, toolDefinition.name),
    integration: integration.id,
    name: toolDefinition.name,
    description: toolDefinition.shortDescription,
    inputSchema: toolDefinition.inputSchema,
    example: toolDefinition.example,
    conventions: toolDefinition.conventions,
  };
}

export function buildTieredSystemPrompt(
  integrations: readonly MockIntegration[],
  trigger: TriggerResult,
): string {
  const autoExpanded = trigger.expandedIntegrationIds
    .map((id) => integrations.find((integration) => integration.id === id))
    .filter((integration): integration is MockIntegration => Boolean(integration));
  return `${BASE_AGENT_PROMPT}

Tool exposure is a lossless three-level DAG:
- Level 0 below is always visible. Every integration:// pointer can be expanded.
- Deterministically selected integrations also have a curated Level 1 below.
- Call curated tools directly when their short signature is sufficient. Use expand_integration for the complete tool directory and expand_tool only when you need a full schema.
- call_integration_tool is the only execution path. Its engine resolves and validates the full Level-2 schema at actual call time.

Level 0 — integration catalog:
${renderLevel0(integrations)}

Level 1 — deterministic auto-expansions:
${autoExpanded.length ? autoExpanded.map((integration) => renderLevel1(integration, true)).join("\n\n") : "(none; use an integration:// pointer if a tool is needed)"}`;
}

function flatDescription(integration: MockIntegration, toolDefinition: MockToolDefinition): string {
  return `${toolDefinition.shortDescription}\nExample: ${JSON.stringify(toolDefinition.example)}\nConventions: ${toolDefinition.conventions.join(" ")}`;
}

function normalizeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function validateArguments(
  definition: MockToolDefinition,
  args: Record<string, unknown>,
): string | null {
  for (const required of definition.inputSchema.required ?? []) {
    if (!(required in args)) return `Missing required argument: ${required}`;
  }
  for (const [name, value] of Object.entries(args)) {
    const property = definition.inputSchema.properties[name];
    if (!property) return `Unknown argument: ${name}`;
    if (property.type === "array" && !Array.isArray(value)) return `${name} must be an array.`;
    if (
      property.type === "object" &&
      (!value || typeof value !== "object" || Array.isArray(value))
    ) {
      return `${name} must be an object.`;
    }
    if (property.type === "integer" && !Number.isInteger(value))
      return `${name} must be an integer.`;
    if (property.type === "number" && typeof value !== "number") return `${name} must be a number.`;
    if (property.type === "boolean" && typeof value !== "boolean")
      return `${name} must be a boolean.`;
    if (property.type === "string" && typeof value !== "string") return `${name} must be a string.`;
  }
  return null;
}

function mockResult(integrationId: string, toolName: string, args: Record<string, unknown>) {
  if (integrationId === "attio" && toolName === "search_records") {
    return { ok: true, records: [{ id: "rec_acme", name: String(args.query ?? "Acme") }] };
  }
  if (integrationId === "slack" && toolName === "search_messages") {
    return {
      ok: true,
      matches: [{ channelId: "CENG123", threadTs: "1712345678.000100", text: "Mock match" }],
    };
  }
  if (integrationId === "github" && toolName === "get_pull_request") {
    return { ok: true, pullRequest: { number: args.pullNumber, title: "Mock PR", state: "open" } };
  }
  return { ok: true, id: `${integrationId}_${toolName}_result`, received: args };
}

export type ToolRuntime = {
  tools: ToolSet;
  systemPrompt: string;
  contextToolDefinitions: unknown[];
  trigger: TriggerResult;
  exposedCallableToolCount: number;
  observedToolCalls: ObservedToolCall[];
  expansionTrace: ExpansionTraceEvent[];
};

export function createFlatRuntime(integrations: readonly MockIntegration[]): ToolRuntime {
  const tools: ToolSet = {};
  const observedToolCalls: ObservedToolCall[] = [];
  const contextToolDefinitions: unknown[] = [];
  for (const integration of integrations) {
    for (const definition of integration.tools) {
      const exposedName = `${integration.id}__${definition.name}`;
      contextToolDefinitions.push({
        name: exposedName,
        description: flatDescription(integration, definition),
        inputSchema: definition.inputSchema,
      });
      tools[exposedName] = tool({
        description: flatDescription(integration, definition),
        inputSchema: jsonSchema(definition.inputSchema as never),
        execute: async (rawArgs: unknown) => {
          const args = normalizeRecord(rawArgs);
          const error = validateArguments(definition, args);
          observedToolCalls.push({
            integrationId: integration.id,
            toolName: definition.name,
            arguments: args,
            valid: !error,
            ...(error ? { error } : {}),
          });
          return error
            ? { ok: false, error, inputSchema: definition.inputSchema }
            : mockResult(integration.id, definition.name, args);
        },
      } as never) as ToolSet[string];
    }
  }
  return {
    tools,
    systemPrompt: BASE_AGENT_PROMPT,
    contextToolDefinitions,
    trigger: { expandedIntegrationIds: [], reasons: [], latencyMs: 0 },
    exposedCallableToolCount: registryToolCount(integrations),
    observedToolCalls,
    expansionTrace: [],
  };
}

export function createTieredRuntime(
  message: string,
  integrations: readonly MockIntegration[],
): ToolRuntime {
  const trigger = matchIntegrations(message, integrations);
  const observedToolCalls: ObservedToolCall[] = [];
  let sequence = 0;
  const expansionTrace: ExpansionTraceEvent[] = trigger.expandedIntegrationIds.map(
    (integrationId) => ({
      sequence: sequence++,
      level: 1,
      integrationId,
      reason: "deterministic_trigger",
      detail: trigger.reasons
        .filter((reason) => reason.integrationId === integrationId)
        .map((reason) => `${reason.pattern}=${JSON.stringify(reason.match)}`)
        .join(", "),
    }),
  );

  const tools: ToolSet = {
    expand_integration: tool({
      description: TIERED_META_TOOL_DESCRIPTIONS.expand_integration,
      inputSchema: jsonSchema(EXPAND_INTEGRATION_SCHEMA as never),
      execute: async (rawInput: unknown) => {
        const integrationId = String(normalizeRecord(rawInput).integration ?? "");
        const selected = integrations.find((integration) => integration.id === integrationId);
        if (!selected) return { ok: false, error: `Unknown integration: ${integrationId}` };
        expansionTrace.push({
          sequence: sequence++,
          level: 1,
          integrationId,
          reason: "model_request",
          detail: selected.pointer,
        });
        return { ok: true, directory: renderLevel1(selected, false) };
      },
    } as never) as ToolSet[string],
    expand_tool: tool({
      description: TIERED_META_TOOL_DESCRIPTIONS.expand_tool,
      inputSchema: jsonSchema(EXPAND_TOOL_SCHEMA as never),
      execute: async (rawInput: unknown) => {
        const input = normalizeRecord(rawInput);
        const integrationId = String(input.integration ?? "");
        const toolName = String(input.tool ?? "");
        const selected = integrations.find((integration) => integration.id === integrationId);
        const definition = resolveTool(integrations, integrationId, toolName);
        if (!selected || !definition) {
          return { ok: false, error: `Unknown tool: ${integrationId}.${toolName}` };
        }
        expansionTrace.push({
          sequence: sequence++,
          level: 2,
          integrationId,
          toolName,
          reason: "model_request",
          detail: toolPointer(integrationId, toolName),
        });
        return { ok: true, definition: renderLevel2(selected, definition) };
      },
    } as never) as ToolSet[string],
    call_integration_tool: tool({
      description: TIERED_META_TOOL_DESCRIPTIONS.call_integration_tool,
      inputSchema: jsonSchema(CALL_TOOL_SCHEMA as never),
      execute: async (rawInput: unknown) => {
        const input = normalizeRecord(rawInput);
        const integrationId = String(input.integration ?? "");
        const toolName = String(input.tool ?? "");
        const args = normalizeRecord(input.arguments);
        const selected = integrations.find((integration) => integration.id === integrationId);
        const definition = resolveTool(integrations, integrationId, toolName);
        if (!selected || !definition) {
          observedToolCalls.push({
            integrationId,
            toolName,
            arguments: args,
            valid: false,
            error: `Unknown tool: ${integrationId}.${toolName}`,
          });
          return { ok: false, error: `Unknown tool: ${integrationId}.${toolName}` };
        }
        expansionTrace.push({
          sequence: sequence++,
          level: 2,
          integrationId,
          toolName,
          reason: "call_time",
          detail: `Engine resolved ${toolPointer(integrationId, toolName)} for validation and dispatch.`,
        });
        const error = validateArguments(definition, args);
        observedToolCalls.push({
          integrationId,
          toolName,
          arguments: args,
          valid: !error,
          ...(error ? { error } : {}),
        });
        return error
          ? { ok: false, error, definition: renderLevel2(selected, definition) }
          : mockResult(integrationId, toolName, args);
      },
    } as never) as ToolSet[string],
  };

  return {
    tools,
    systemPrompt: buildTieredSystemPrompt(integrations, trigger),
    contextToolDefinitions: [
      {
        name: "expand_integration",
        description: TIERED_META_TOOL_DESCRIPTIONS.expand_integration,
        inputSchema: EXPAND_INTEGRATION_SCHEMA,
      },
      {
        name: "expand_tool",
        description: TIERED_META_TOOL_DESCRIPTIONS.expand_tool,
        inputSchema: EXPAND_TOOL_SCHEMA,
      },
      {
        name: "call_integration_tool",
        description: TIERED_META_TOOL_DESCRIPTIONS.call_integration_tool,
        inputSchema: CALL_TOOL_SCHEMA,
      },
    ],
    trigger,
    exposedCallableToolCount: Object.keys(tools).length,
    observedToolCalls,
    expansionTrace,
  };
}

export function estimateTokens(value: unknown): number {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return Math.ceil(new TextEncoder().encode(serialized).byteLength / 4);
}

export function estimateInitialContextTokens(runtime: ToolRuntime, userPrompt: string): number {
  return estimateTokens({
    system: runtime.systemPrompt,
    user: userPrompt,
    tools: runtime.contextToolDefinitions,
  });
}

export function tieredMetaSchemas(): readonly JsonSchema[] {
  return [EXPAND_INTEGRATION_SCHEMA, EXPAND_TOOL_SCHEMA, CALL_TOOL_SCHEMA];
}
