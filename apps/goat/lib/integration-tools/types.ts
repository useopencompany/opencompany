// Shared types for the main-chat integration tools: a curated, read-only
// catalog of connected-provider tools exposed to the model through the
// two-call flow (search_integration_tools returns full definitions,
// call_integration_tool executes one by exact name).

export const INTEGRATION_TOOL_PROVIDERS = ["linear", "slack", "gmail"] as const;

export type IntegrationToolProvider = (typeof INTEGRATION_TOOL_PROVIDERS)[number];

export function isIntegrationToolProvider(value: unknown): value is IntegrationToolProvider {
  return (
    typeof value === "string" && (INTEGRATION_TOOL_PROVIDERS as readonly string[]).includes(value)
  );
}

// Tool names are flat provider-prefixed identifiers like "linear_list_issues";
// the prefix doubles as the search token and the UI label source.
export function providerFromToolName(name: string): IntegrationToolProvider | null {
  const prefix = name.split("_", 1)[0];
  return isIntegrationToolProvider(prefix) ? prefix : null;
}

export type IntegrationToolPropertySchema = {
  type: "string" | "number" | "boolean";
  description?: string;
  enum?: string[];
};

// All curated schemas are flat strict objects so a small local validator can
// enforce them without a JSON-Schema library.
export type IntegrationToolJsonSchema = {
  type: "object";
  additionalProperties: false;
  properties: Record<string, IntegrationToolPropertySchema>;
  required?: string[];
};

export type IntegrationToolDefinition = {
  name: string;
  provider: IntegrationToolProvider;
  description: string;
  inputSchema: IntegrationToolJsonSchema;
  // Extra search vocabulary beyond the name/description ("ticket", "dm", …).
  keywords: readonly string[];
};

// Model-facing view returned by search: the full definition minus internal
// search metadata.
export type IntegrationToolDefinitionView = {
  name: string;
  provider: IntegrationToolProvider;
  description: string;
  inputSchema: IntegrationToolJsonSchema;
};

export type SearchIntegrationToolsInput = { query: string };

export type SearchIntegrationToolsOutput =
  | { ok: true; tools: IntegrationToolDefinitionView[]; guidance?: string }
  | { ok: false; error: string };

export type CallIntegrationToolInput = {
  tool: string;
  arguments?: Record<string, unknown>;
};

export type CallIntegrationToolOutput =
  | { ok: true; tool: string; result: unknown; truncated?: boolean }
  | {
      ok: false;
      tool?: string;
      error: string;
      validationErrors?: string[];
      availableTools?: string[];
    };
