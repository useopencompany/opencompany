import type { GoatHarnessSpec, GoatTaskToolName } from "@opencompany/db/goat-schema";

function promptBlock(name: string, lines: readonly string[]) {
  return [`<${name}>`, ...lines, `</${name}>`].join("\n");
}

export const GOAT_HARNESS_CREATION_SYSTEM = promptBlock("system", [
  "You plan a Goat durable task harness.",
  "Return a strict goat.harness.v1 object.",
]);

export const GOAT_HARNESS_CREATION_MODEL_CONTRACT = promptBlock("model_contract", [
  "The selected task model is fixed and may not be changed.",
]);

export const GOAT_HARNESS_CREATION_TOOL_POLICY = promptBlock("tool_policy", [
  "Select only operation-level tools from the available list.",
  "Rewrite stale chat-layer limitations into clear instructions to use connected read-only tools when available.",
]);

export const GOAT_HARNESS_CREATION_RESULT_CONTRACT = promptBlock("result_contract", [
  "The task result comes from the final assistant message; there is no final-result tool.",
  'resultMode must be "assistant_final".',
]);

export const GOAT_HARNESS_CREATION_SYSTEM_PROMPT = [
  GOAT_HARNESS_CREATION_SYSTEM,
  GOAT_HARNESS_CREATION_MODEL_CONTRACT,
  GOAT_HARNESS_CREATION_TOOL_POLICY,
  GOAT_HARNESS_CREATION_RESULT_CONTRACT,
].join("\n\n");

export function buildGoatHarnessCreationPrompt(input: {
  prompt: string;
  model: GoatHarnessSpec["model"];
  availableTools: readonly GoatTaskToolName[];
  defaultMaxModelSteps: number;
}) {
  return `Selected task model: ${input.model}
Available operation tools: ${input.availableTools.join(", ")}
Default max model steps: ${input.defaultMaxModelSteps}

Task:
${input.prompt}`;
}
