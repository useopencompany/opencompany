export type JsonSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

export type RuntimeToolName = "shell" | "read_file" | "write_file" | "list_files" | "git_diff";

export type RuntimeToolDefinition = {
  name: RuntimeToolName;
  description: string;
  parameters: JsonSchema;
};

export const CORE_TOOL_DEFINITIONS: RuntimeToolDefinition[] = [
  {
    name: "shell",
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
    description: "Return the current git diff for the workspace.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

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
