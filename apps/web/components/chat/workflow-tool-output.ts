import { START_WORKFLOW_TOOL_NAME, type StartTaskToolOutput } from "@opencompany/agent/chat-ui";
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
  if (!isHostCall(tool.input, "workflows")) return null;

  const output = isRecord(tool.output) ? tool.output : null;
  const projected = workflowCardOutput(output?.workflowOutput, command);
  if (projected) return projected;
  for (const candidate of hostCallResults(output?.result)) {
    const card = workflowCardOutput(candidate, command);
    if (card) return card;
  }
  return null;
}

/**
 * The Task a coding engine started through the host bridge: `start_workflow` (a Task run's
 * handoff) or `workflows` with `run` (main chat). Native chat renders these from typed tool parts.
 */
export function startedTaskOutputFromTool(tool: WorkflowToolCall): StartTaskToolOutput | null {
  if (tool.state !== "output-available") return null;
  if (tool.name !== CODEX_MCP_TOOL_NAME && tool.name !== CODEX_DYNAMIC_TOOL_NAME) return null;
  if (!isHostCall(tool.input, START_WORKFLOW_TOOL_NAME) && !isHostCall(tool.input, "workflows")) {
    return null;
  }
  const output = isRecord(tool.output) ? tool.output : null;
  return hostCallResults(output?.result).find(isStartTaskToolOutput) ?? null;
}

// An MCP result arrives as the structured object, its `structuredContent`, or JSON text content.
function hostCallResults(result: unknown): Record<string, unknown>[] {
  const envelope =
    typeof result === "string" ? parseJsonRecord(result) : isRecord(result) ? result : null;
  if (!envelope) return [];
  const results = [envelope];
  if (isRecord(envelope.structuredContent)) results.push(envelope.structuredContent);
  if (Array.isArray(envelope.content)) {
    for (const item of envelope.content) {
      if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") continue;
      const parsed = parseJsonRecord(item.text);
      if (parsed) results.push(parsed);
    }
  }
  return results;
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

function isHostCall(value: unknown, tool: string) {
  if (!isRecord(value)) return false;
  if (value.server === ACP_TOOLS_MCP_SERVER_NAME && value.tool === tool) return true;
  for (const identity of [value.toolName, value.title]) {
    if (
      identity === `mcp__${ACP_TOOLS_MCP_SERVER_NAME}__${tool}` ||
      identity === `mcp.${ACP_TOOLS_MCP_SERVER_NAME}.${tool}`
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

function isStartTaskToolOutput(value: Record<string, unknown>): value is StartTaskToolOutput {
  return (
    typeof value.taskId === "string" &&
    typeof value.taskDisplayId === "string" &&
    typeof value.taskName === "string"
  );
}
