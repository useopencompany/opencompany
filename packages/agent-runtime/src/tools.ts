export type JsonSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

import type { AgentToolId } from "@opencompany/db/schema";

export type RuntimeToolName =
  | "shell"
  | "read_file"
  | "write_file"
  | "list_files"
  | "git_diff"
  | "exa_search"
  | "tool_help";

export type RuntimeToolDefinition = {
  name: RuntimeToolName;
  kind: "sandbox" | "hosted";
  configToolId?: AgentToolId;
  description: string;
  parameters: JsonSchema;
  help?: string;
};

export const CORE_TOOL_DEFINITIONS: RuntimeToolDefinition[] = [
  {
    name: "shell",
    kind: "sandbox",
    description: "Run a shell command in the session workspace.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run." },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    kind: "sandbox",
    description: "Read a UTF-8 text file from the session workspace.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path inside the workspace." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    kind: "sandbox",
    description: "Write a UTF-8 text file inside the session workspace.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path inside the workspace." },
        content: { type: "string", description: "Full file content." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "list_files",
    kind: "sandbox",
    description: "List files and directories below a workspace path.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path inside the workspace.", default: "." },
        depth: { type: "number", description: "Maximum traversal depth.", default: 2 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "git_diff",
    kind: "sandbox",
    description: "Return the current git diff for the workspace.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

export const HOSTED_TOOL_DEFINITIONS: RuntimeToolDefinition[] = [
  {
    name: "exa_search",
    kind: "hosted",
    configToolId: "exa",
    description:
      "Search the live web with Exa and return compact, citation-friendly results with highlights.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural language search query. Use specific, source-seeking phrasing.",
        },
        numResults: {
          type: "number",
          description: "Number of results to return. Defaults to 5. Maximum 10 in this harness.",
          default: 5,
        },
        type: {
          type: "string",
          enum: ["auto", "fast", "instant", "deep-lite", "deep"],
          description: "Search mode. Defaults to auto.",
          default: "auto",
        },
        category: {
          type: "string",
          enum: [
            "company",
            "people",
            "research paper",
            "news",
            "personal site",
            "financial report",
          ],
          description: "Optional Exa category filter.",
        },
        includeDomains: {
          type: "array",
          items: { type: "string" },
          description: "Only return results from these domains.",
        },
        excludeDomains: {
          type: "array",
          items: { type: "string" },
          description: "Exclude results from these domains.",
        },
        startPublishedDate: {
          type: "string",
          description: "ISO 8601 lower bound for published date.",
        },
        endPublishedDate: {
          type: "string",
          description: "ISO 8601 upper bound for published date.",
        },
        fresh: {
          type: "boolean",
          description: "Force fresh live-crawled content. Increases latency and cost.",
          default: false,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    help: [
      "Use exa_search when you need current web evidence, source discovery, company/person/news/research lookup, or citation-ready URLs.",
      "Defaults are type=auto, numResults=5, and highlights-only content to keep context small.",
      "Use type=fast or instant only when latency matters more than depth. Use deep/deep-lite only for complex multi-source synthesis.",
      "Set fresh=true only for time-sensitive facts; it forces live crawling and can be slower.",
      "For company and people categories, avoid excludeDomains and published date filters because Exa does not support those combinations.",
      'Prefer includeDomains for official-source lookups, for example includeDomains: ["sec.gov", "company.com"].',
    ].join("\n"),
  },
  {
    name: "tool_help",
    kind: "hosted",
    description:
      "Return detailed instructions for an enabled runtime tool without bloating context.",
    parameters: {
      type: "object",
      properties: {
        tool: {
          type: "string",
          description: "Enabled tool name to get help for, such as exa_search.",
        },
      },
      required: ["tool"],
      additionalProperties: false,
    },
  },
];

export const RUNTIME_TOOL_DEFINITIONS: RuntimeToolDefinition[] = [
  ...CORE_TOOL_DEFINITIONS,
  ...HOSTED_TOOL_DEFINITIONS,
];

export const RUNTIME_TOOL_DEFINITION_BY_NAME = new Map(
  RUNTIME_TOOL_DEFINITIONS.map((tool) => [tool.name, tool]),
);

export function resolveRuntimeToolNamesForConfigTools(
  tools: ReadonlyArray<{ id?: unknown }> | undefined,
) {
  const names = new Set<RuntimeToolName>();
  for (const tool of CORE_TOOL_DEFINITIONS) names.add(tool.name);
  names.add("tool_help");

  const selectedToolIds = new Set(
    (tools ?? []).flatMap((tool) => (typeof tool.id === "string" ? [tool.id] : [])),
  );
  for (const definition of HOSTED_TOOL_DEFINITIONS) {
    if (definition.configToolId && selectedToolIds.has(definition.configToolId)) {
      names.add(definition.name);
    }
  }

  return Array.from(names);
}

export function getRuntimeToolHelp(toolName: string, enabledTools: readonly RuntimeToolName[]) {
  if (!enabledTools.includes(toolName as RuntimeToolName)) return null;
  const definition = RUNTIME_TOOL_DEFINITION_BY_NAME.get(toolName as RuntimeToolName);
  if (!definition) return null;

  return {
    tool: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    help:
      definition.help ??
      "No extended help is available. Use the schema and description for this tool.",
  };
}

export function toOpenAiTool(definition: RuntimeToolDefinition) {
  return {
    type: "function" as const,
    function: {
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
    },
  };
}
