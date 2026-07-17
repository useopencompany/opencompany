import { BASE_INTEGRATIONS } from "../tool-exposure/registry";
import type { JsonSchema, MockTool } from "./types";

const outputSchema: JsonSchema = {
  type: "object",
  description: "A deterministic mock integration response.",
  properties: {
    ok: { type: "boolean", description: "Whether the operation succeeded." },
    data: {
      description: "The requested record, records, or mutation result.",
      type: ["object", "array", "string", "null"],
    },
    nextCursor: { type: ["string", "null"], description: "Pagination cursor, or null." },
  },
  required: ["ok", "data"],
  additionalProperties: false,
};

export const MOCK_TOOL_CATALOG: MockTool[] = BASE_INTEGRATIONS.flatMap((integration) =>
  integration.tools.map((definition) => ({
    path: `${integration.id}.${definition.name}`,
    integration: integration.id,
    operation: definition.name,
    summary: definition.shortDescription,
    inputSchema: definition.inputSchema as JsonSchema,
    outputSchema,
  })),
);

export const MOCK_CATALOG_STATS = {
  integrations: BASE_INTEGRATIONS.length,
  tools: MOCK_TOOL_CATALOG.length,
};

for (const integration of BASE_INTEGRATIONS) {
  if (integration.tools.length < 15 || integration.tools.length > 30) {
    throw new Error(
      `${integration.id} must keep 15-30 tools for the shared comparison; received ${integration.tools.length}.`,
    );
  }
}
