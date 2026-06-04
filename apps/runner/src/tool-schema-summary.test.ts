import type { ToolSet } from "ai";
import { describe, expect, it } from "vitest";
import { buildToolSchemaSummary, type McpToolSchemaMetadata } from "./tool-schema-summary";

describe("buildToolSchemaSummary", () => {
  it("summarizes runtime, hosted, and MCP tool definitions without raw schemas by default", () => {
    const tools = {
      read_file: fakeTool({
        description: "Read a file from the sandbox.",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      }),
      exa_search: fakeTool({
        description: "Search the web.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      }),
      linear__create_issue: fakeTool({
        description: "Linear MCP: Create a Linear issue.",
        inputSchema: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
        },
      }),
      slack__search: fakeTool({
        description: `Slack MCP: ${"Search ".repeat(80)}`,
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" }, limit: { type: "number" } },
          required: ["query"],
        },
      }),
    } as unknown as ToolSet;
    const mcpToolMetadata = new Map<string, McpToolSchemaMetadata>([
      [
        "linear__create_issue",
        { providerKey: "linear", providerName: "Linear", rawName: "create_issue" },
      ],
      ["slack__search", { providerKey: "slack", providerName: "Slack", rawName: "search" }],
    ]);

    const summary = buildToolSchemaSummary({
      tools,
      mcpToolMetadata,
      modelProvider: "vercel-ai-gateway",
      modelName: "anthropic/claude-sonnet-4.6",
      modelSystem: {
        role: "system",
        content: "You are helpful.",
        providerOptions: {
          anthropic: { cacheControl: { type: "ephemeral", ttl: "5m" } },
        },
      },
      topN: 1,
    });

    expect(summary.total_selected_tool_count).toBe(4);
    expect(summary.source_counts).toEqual({
      built_in_runtime: 1,
      hosted: 1,
      mcp: 2,
      unknown: 0,
    });
    expect(summary.mcp_provider_counts).toEqual([
      expect.objectContaining({ provider_key: "linear", provider_name: "Linear", count: 1 }),
      expect.objectContaining({ provider_key: "slack", provider_name: "Slack", count: 1 }),
    ]);
    expect(summary.largest_tools).toHaveLength(1);
    expect(summary.largest_tools[0]?.name).toBe("slack__search");
    expect(summary.raw_tool_definitions).toBeUndefined();

    const linearEntry = summary.tools.find((tool) => tool.name === "linear__create_issue");
    expect(linearEntry).toEqual(
      expect.objectContaining({
        raw_mcp_tool_name: "create_issue",
        source: "mcp",
        provider_key: "linear",
        provider_name: "Linear",
      }),
    );
    expect(linearEntry?.definition_hash).toMatch(/^[a-f0-9]{64}$/);

    const readFileDefinition = {
      name: "read_file",
      description: "Read a file from the sandbox.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    };
    const readFileEntry = summary.tools.find((tool) => tool.name === "read_file");
    expect(readFileEntry?.input_schema_bytes).toBe(
      Buffer.byteLength(stableStringify(readFileDefinition.inputSchema), "utf8"),
    );
    expect(readFileEntry?.full_definition_bytes).toBe(
      Buffer.byteLength(stableStringify(readFileDefinition), "utf8"),
    );
    expect(summary.total_serialized_tool_definition_bytes).toBe(
      summary.tools.reduce((total, tool) => total + tool.full_definition_bytes, 0),
    );
    expect(summary.cache).toEqual({
      model_provider: "vercel-ai-gateway",
      model_name: "anthropic/claude-sonnet-4.6",
      anthropic_cache_control_enabled: true,
      anthropic_cache_control_type: "ephemeral",
      cache_ttl: "5m",
      cacheable_system_blocks: 1,
      cacheable_tool_blocks: 0,
      cacheable_total_blocks: 1,
    });
  });

  it("redacts and caps raw schema capture when explicitly enabled", () => {
    const tools = {
      a_danger: fakeTool({
        description: "Call with Bearer sk_live_secret.",
        inputSchema: {
          type: "object",
          properties: {
            authorization: { type: "string", default: "Bearer sk_live_secret" },
            nested: {
              type: "object",
              properties: { apiKey: { type: "string", default: "plain_secret" } },
            },
          },
        },
      }),
      z_large: fakeTool({
        description: "Large schema",
        inputSchema: {
          type: "object",
          properties: { payload: { type: "string", description: "x".repeat(2_000) } },
        },
      }),
    } as unknown as ToolSet;

    const summary = buildToolSchemaSummary({
      tools,
      modelProvider: "vercel-ai-gateway",
      modelName: "openai/gpt-5.4-mini",
      modelSystem: "plain system prompt",
      captureRawSchemas: true,
      rawSchemaMaxBytes: 600,
    });

    const rawJson = JSON.stringify(summary.raw_tool_definitions);
    expect(summary.raw_tool_definitions).toHaveLength(1);
    expect(summary.raw_tool_definitions_truncated).toBe(true);
    expect(summary.raw_tool_definitions_omitted_count).toBe(1);
    expect(rawJson).toContain("Bearer [redacted]");
    expect(rawJson).toContain("[redacted]");
    expect(rawJson).not.toContain("sk_live_secret");
    expect(rawJson).not.toContain("plain_secret");
    expect(summary.cache.anthropic_cache_control_enabled).toBe(false);
  });
});

function fakeTool(input: { description: string; inputSchema: unknown }) {
  return {
    description: input.description,
    inputSchema: input.inputSchema,
    execute: () => null,
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
  if (Array.isArray(value)) return value.map((item) => normalizeForJson(item));
  if (typeof value !== "object") return undefined;

  const record = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const normalizedValue = normalizeForJson(record[key]);
    if (normalizedValue !== undefined) normalized[key] = normalizedValue;
  }
  return normalized;
}
