import { createHash } from "node:crypto";
import { RUNTIME_TOOL_DEFINITION_BY_NAME, type RuntimeToolName } from "@opencompany/agent-runtime";
import type { ToolSet } from "ai";

const DEFAULT_LARGEST_TOOL_COUNT = 10;
const DEFAULT_RAW_SCHEMA_MAX_BYTES = 64 * 1024;

type ToolSchemaSource = "built_in_runtime" | "hosted" | "mcp" | "unknown";

export type McpToolSchemaMetadata = {
  providerKey: string;
  providerName: string;
  rawName: string;
  isStub?: boolean;
};

type ToolSchemaEntry = {
  name: string;
  raw_mcp_tool_name?: string;
  source: ToolSchemaSource;
  provider_key?: string;
  provider_name?: string;
  description_chars: number;
  input_schema_bytes: number;
  full_definition_bytes: number;
  definition_hash: string;
  mcp_not_connected_stub?: boolean;
};

export type ToolSchemaSummary = {
  total_selected_tool_count: number;
  total_serialized_tool_definition_bytes: number;
  source_counts: Record<ToolSchemaSource, number>;
  mcp_provider_counts: Array<{
    provider_key: string;
    provider_name: string;
    count: number;
    serialized_tool_definition_bytes: number;
  }>;
  largest_tools: ToolSchemaEntry[];
  tools: ToolSchemaEntry[];
  cache: {
    model_provider: string;
    model_name: string;
    anthropic_cache_control_enabled: boolean;
    anthropic_cache_control_type?: string;
    cache_ttl?: string | number;
    cacheable_system_blocks: number;
    cacheable_tool_blocks: number;
    cacheable_total_blocks: number;
  };
  raw_tool_definitions?: Array<{
    name: string;
    definition: unknown;
  }>;
  raw_tool_definitions_truncated?: boolean;
  raw_tool_definitions_omitted_count?: number;
  raw_tool_definitions_max_bytes?: number;
};

type ModelFacingToolDefinition = {
  name: string;
  description: string;
  inputSchema: unknown;
};

type ToolClassification = {
  source: ToolSchemaSource;
  providerKey?: string;
  providerName?: string;
  rawMcpToolName?: string;
  mcpNotConnectedStub?: boolean;
};

export function buildToolSchemaSummary(input: {
  tools: ToolSet;
  mcpToolMetadata?: ReadonlyMap<string, McpToolSchemaMetadata>;
  modelProvider: string;
  modelName: string;
  modelSystem: unknown;
  topN?: number;
  captureRawSchemas?: boolean;
  rawSchemaMaxBytes?: number;
}): ToolSchemaSummary {
  const sourceCounts: Record<ToolSchemaSource, number> = {
    built_in_runtime: 0,
    hosted: 0,
    mcp: 0,
    unknown: 0,
  };
  const providerCounts = new Map<
    string,
    {
      provider_key: string;
      provider_name: string;
      count: number;
      serialized_tool_definition_bytes: number;
    }
  >();
  const tools: ToolSchemaEntry[] = [];
  const modelDefinitions: Array<{ name: string; definition: ModelFacingToolDefinition }> = [];
  let totalBytes = 0;

  for (const [name, tool] of Object.entries(input.tools).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const modelDefinition = modelFacingToolDefinition(name, tool);
    const description = modelDefinition.description;
    const inputSchemaJson = stableStringify(modelDefinition.inputSchema);
    const definitionJson = stableStringify(modelDefinition);
    const inputSchemaBytes = byteLength(inputSchemaJson);
    const fullDefinitionBytes = byteLength(definitionJson);
    const classification = classifyTool(name, input.mcpToolMetadata);
    totalBytes += fullDefinitionBytes;
    sourceCounts[classification.source] += 1;

    if (classification.source === "mcp" && classification.providerKey) {
      const current = providerCounts.get(classification.providerKey) ?? {
        provider_key: classification.providerKey,
        provider_name: classification.providerName ?? classification.providerKey,
        count: 0,
        serialized_tool_definition_bytes: 0,
      };
      current.count += 1;
      current.serialized_tool_definition_bytes += fullDefinitionBytes;
      providerCounts.set(classification.providerKey, current);
    }

    const entry: ToolSchemaEntry = {
      name,
      ...(classification.rawMcpToolName
        ? { raw_mcp_tool_name: classification.rawMcpToolName }
        : {}),
      source: classification.source,
      ...(classification.providerKey ? { provider_key: classification.providerKey } : {}),
      ...(classification.providerName ? { provider_name: classification.providerName } : {}),
      description_chars: description.length,
      input_schema_bytes: inputSchemaBytes,
      full_definition_bytes: fullDefinitionBytes,
      definition_hash: hashDefinition(definitionJson),
      ...(classification.mcpNotConnectedStub ? { mcp_not_connected_stub: true } : {}),
    };
    tools.push(entry);
    modelDefinitions.push({ name, definition: modelDefinition });
  }

  const topN = input.topN ?? DEFAULT_LARGEST_TOOL_COUNT;
  const cache = cacheMetadata({
    modelProvider: input.modelProvider,
    modelName: input.modelName,
    modelSystem: input.modelSystem,
  });
  const summary: ToolSchemaSummary = {
    total_selected_tool_count: tools.length,
    total_serialized_tool_definition_bytes: totalBytes,
    source_counts: sourceCounts,
    mcp_provider_counts: Array.from(providerCounts.values()).sort((left, right) =>
      left.provider_key.localeCompare(right.provider_key),
    ),
    largest_tools: [...tools]
      .sort(
        (left, right) =>
          right.full_definition_bytes - left.full_definition_bytes ||
          left.name.localeCompare(right.name),
      )
      .slice(0, topN),
    tools,
    cache,
  };

  if (input.captureRawSchemas) {
    Object.assign(
      summary,
      rawToolDefinitions({
        modelDefinitions,
        maxBytes: input.rawSchemaMaxBytes ?? DEFAULT_RAW_SCHEMA_MAX_BYTES,
      }),
    );
  }

  return summary;
}

export function shouldCaptureRawToolSchemas() {
  return process.env.BRAINTRUST_CAPTURE_RAW_TOOL_SCHEMAS?.trim().toLowerCase() === "true";
}

function modelFacingToolDefinition(name: string, tool: ToolSet[string]): ModelFacingToolDefinition {
  const toolRecord = (isRecord(tool) ? tool : {}) as Record<string, unknown>;
  const description = typeof toolRecord.description === "string" ? toolRecord.description : "";
  return {
    name,
    description,
    inputSchema: normalizeForJson(toolRecord.inputSchema),
  };
}

function classifyTool(
  name: string,
  mcpMetadata: ReadonlyMap<string, McpToolSchemaMetadata> | undefined,
): ToolClassification {
  const mcp = mcpMetadata?.get(name);
  if (mcp) {
    return {
      source: "mcp" as const,
      providerKey: mcp.providerKey,
      providerName: mcp.providerName,
      rawMcpToolName: mcp.rawName,
      mcpNotConnectedStub: mcp.isStub === true,
    };
  }

  const runtimeDefinition = RUNTIME_TOOL_DEFINITION_BY_NAME.get(name as RuntimeToolName);
  if (!runtimeDefinition) return { source: "unknown" as const };
  if (runtimeDefinition.kind === "hosted") {
    return {
      source: "hosted" as const,
      providerKey:
        runtimeDefinition.configToolId ?? runtimeDefinition.sharedConfigToolIds?.[0] ?? "hosted",
    };
  }
  return { source: "built_in_runtime" as const, providerKey: runtimeDefinition.kind };
}

function cacheMetadata(input: {
  modelProvider: string;
  modelName: string;
  modelSystem: unknown;
}): ToolSchemaSummary["cache"] {
  const cacheControls = findAnthropicCacheControls(input.modelSystem);
  const first = cacheControls[0];
  const cacheableSystemBlocks = cacheControls.length;
  return {
    model_provider: input.modelProvider,
    model_name: input.modelName,
    anthropic_cache_control_enabled: cacheControls.length > 0,
    ...(first && typeof first.type === "string"
      ? { anthropic_cache_control_type: first.type }
      : {}),
    ...(first && (typeof first.ttl === "string" || typeof first.ttl === "number")
      ? { cache_ttl: first.ttl }
      : {}),
    cacheable_system_blocks: cacheableSystemBlocks,
    cacheable_tool_blocks: 0,
    cacheable_total_blocks: cacheableSystemBlocks,
  };
}

function findAnthropicCacheControls(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap((item) => findAnthropicCacheControls(item));
  if (!isRecord(value)) return [];

  const cacheControl = readAnthropicCacheControl(value);
  const nested = Array.isArray(value.content)
    ? value.content.flatMap((item) => findAnthropicCacheControls(item))
    : [];
  return cacheControl ? [cacheControl, ...nested] : nested;
}

function readAnthropicCacheControl(value: Record<string, unknown>) {
  const providerOptions = value.providerOptions;
  if (!isRecord(providerOptions)) return null;
  const anthropic = providerOptions.anthropic;
  if (!isRecord(anthropic)) return null;
  const cacheControl = anthropic.cacheControl;
  return isRecord(cacheControl) ? cacheControl : null;
}

function rawToolDefinitions(input: {
  modelDefinitions: Array<{ name: string; definition: ModelFacingToolDefinition }>;
  maxBytes: number;
}) {
  const raw_tool_definitions: Array<{ name: string; definition: unknown }> = [];
  let usedBytes = 0;
  let omittedCount = 0;

  for (const item of input.modelDefinitions) {
    const definition = redactRawDefinition(item.definition);
    const bytes = byteLength(stableStringify({ name: item.name, definition }));
    if (usedBytes + bytes > input.maxBytes) {
      omittedCount += 1;
      continue;
    }
    usedBytes += bytes;
    raw_tool_definitions.push({ name: item.name, definition });
  }

  return {
    raw_tool_definitions,
    raw_tool_definitions_max_bytes: input.maxBytes,
    ...(omittedCount > 0
      ? {
          raw_tool_definitions_truncated: true,
          raw_tool_definitions_omitted_count: omittedCount,
        }
      : {}),
  };
}

function stableStringify(value: unknown) {
  return JSON.stringify(normalizeForJson(value));
}

function normalizeForJson(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => normalizeForJson(item));
  if (!isRecord(value)) return String(value);

  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const normalizedValue = normalizeForJson(value[key]);
    if (normalizedValue !== undefined) normalized[key] = normalizedValue;
  }
  return normalized;
}

function redactRawDefinition(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return maskString(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => redactRawDefinition(item));
  if (!isRecord(value)) return String(value);

  const redacted: Record<string, unknown> = {};
  for (const [key, fieldValue] of Object.entries(value)) {
    redacted[key] = isSensitiveKey(key) ? "[redacted]" : redactRawDefinition(fieldValue);
  }
  return redacted;
}

function hashDefinition(serializedDefinition: string) {
  return createHash("sha256").update(serializedDefinition, "utf8").digest("hex");
}

function byteLength(value: string) {
  return Buffer.byteLength(value, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSensitiveKey(key: string) {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    normalized.includes("secret") ||
    normalized.includes("token") ||
    normalized.includes("password") ||
    normalized.includes("cookie") ||
    normalized.includes("authorization") ||
    normalized.includes("privatekey") ||
    normalized.includes("apikey") ||
    normalized.includes("credential") ||
    normalized.includes("dsn")
  );
}

function maskString(value: string) {
  return value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
    .replace(/\b[A-Za-z0-9._%+-]+:[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\b/g, "[redacted]@");
}
