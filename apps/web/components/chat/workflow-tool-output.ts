import {
  ACP_TOOLS_MCP_SERVER_NAME,
  CODEX_DYNAMIC_TOOL_NAME,
  CODEX_MCP_TOOL_NAME,
} from "@opencompany/agent-runtime";

const WORKFLOW_MUTATION_COMMANDS = new Set([
  "create",
  "update",
  "activate",
  "pause",
  "archive",
  "clear_memory",
]);
const WORKFLOW_MUTATION_OPERATIONS = new Set([
  ...WORKFLOW_MUTATION_COMMANDS,
  "created",
  "replayed",
  "activated",
  "paused",
  "archived",
  "updated",
  "memory_cleared",
]);

export type WorkflowCardOutput = Record<string, unknown> & {
  workflow: Record<string, unknown> & { name: string; slug: string };
};

type WorkflowToolCall = {
  name: string;
  state: string;
  input: unknown;
  output: unknown;
};

/**
 * Native chat models call `workflows` directly, while coding engines call the same host tool
 * through an MCP envelope. Normalize both representations so workflow mutations have one durable
 * chat card instead of disappearing into the collapsed execution trace.
 */
export function workflowCardOutputFromTool(tool: WorkflowToolCall): WorkflowCardOutput | null {
  if (tool.state !== "output-available") return null;

  const command = workflowCommand(tool.input);
  if (command && !WORKFLOW_MUTATION_COMMANDS.has(command)) return null;

  if (tool.name === "workflows") {
    return workflowCardOutput(tool.output, command);
  }
  if (tool.name !== CODEX_MCP_TOOL_NAME && tool.name !== CODEX_DYNAMIC_TOOL_NAME) {
    return null;
  }
  if (!isWorkflowHostCall(tool.input)) return null;

  const output = isRecord(tool.output) ? tool.output : null;
  const projected = workflowCardOutput(output?.workflowOutput, command);
  if (projected) return projected;
  const result = output?.result;
  const envelope =
    typeof result === "string" ? parseJsonRecord(result) : isRecord(result) ? result : null;
  if (!envelope) return null;

  const direct = workflowCardOutput(envelope, command);
  if (direct) return direct;

  const structured = workflowCardOutput(envelope.structuredContent, command);
  if (structured) return structured;

  if (!Array.isArray(envelope.content)) return null;
  for (const item of envelope.content) {
    if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") continue;
    const parsed = parseJsonRecord(item.text);
    const card = workflowCardOutput(parsed, command);
    if (card) return card;
  }
  return null;
}

function workflowCardOutput(value: unknown, command: string | null): WorkflowCardOutput | null {
  if (!isRecord(value) || !isRecord(value.workflow)) return null;
  if (typeof value.workflow.name !== "string" || typeof value.workflow.slug !== "string") {
    return null;
  }
  const operation = typeof value.operation === "string" ? value.operation : null;
  if (!command && (!operation || !WORKFLOW_MUTATION_OPERATIONS.has(operation))) return null;
  return value as WorkflowCardOutput;
}

function workflowCommand(value: unknown) {
  if (!isRecord(value)) return null;
  const args = isRecord(value.arguments) ? value.arguments : value;
  return typeof args.command === "string" ? args.command : null;
}

function isWorkflowHostCall(value: unknown) {
  if (!isRecord(value)) return false;
  if (value.server === ACP_TOOLS_MCP_SERVER_NAME && value.tool === "workflows") return true;
  for (const identity of [value.toolName, value.title]) {
    if (
      identity === `mcp__${ACP_TOOLS_MCP_SERVER_NAME}__workflows` ||
      identity === `mcp.${ACP_TOOLS_MCP_SERVER_NAME}.workflows`
    ) {
      return true;
    }
  }
  return false;
}

function parseJsonRecord(value: string) {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
