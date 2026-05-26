import type { AgentConfig } from "@opencompany/db/schema";

export function serializeRuntimeAgentFile(agent: AgentConfig) {
  const body = normalizeBody(agent.instructions);

  return [
    "---",
    `title: ${formatYamlString(agent.title || "Untitled agent")}`,
    `model: ${formatYamlString(agent.model.name)}`,
    formatYamlArray(
      "tools",
      (agent.tools ?? []).map((tool) => tool.id),
    ),
    formatYamlArray(
      "brain",
      (agent.brain ?? []).map((reference) => reference.path),
    ),
    "---",
    "",
    body,
  ].join("\n");
}

function normalizeBody(value: string) {
  return value.replace(/\r\n/g, "\n");
}

function formatYamlArray(key: string, values: string[]) {
  if (values.length === 0) return `${key}: []`;
  return [`${key}:`, ...values.map((value) => `  - ${formatYamlString(value)}`)].join("\n");
}

function formatYamlString(value: string) {
  const encoded = JSON.stringify(value);
  if (!encoded) throw new Error("Failed to encode YAML string.");
  return encoded;
}
