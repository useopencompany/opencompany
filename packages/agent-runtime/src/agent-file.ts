import type { AgentConfig } from "@opencompany/db/schema";

export function serializeRuntimeAgentFile(agent: AgentConfig) {
  const body = normalizeBody(agent.instructions);

  return [
    "---",
    `title: ${quoteYamlString(agent.title || "Untitled agent")}`,
    `model: ${agent.model.name}`,
    "tools:",
    ...(agent.tools ?? []).map((tool) => `  - ${tool.id}`),
    "brain:",
    ...(agent.brain ?? []).map((reference) => `  - ${reference.path}`),
    "---",
    "",
    body,
  ].join("\n");
}

function normalizeBody(value: string) {
  return value.replace(/\r\n/g, "\n");
}

function quoteYamlString(value: string) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
