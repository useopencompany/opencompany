import type { GoatHarnessSpec, GoatTaskToolName } from "@opencompany/db/goat-schema";

export type GoatHarnessModelOption = {
  id: GoatHarnessSpec["model"];
  label: string;
  guidance: string;
  default?: boolean;
};

export const GOAT_HARNESS_MODEL_OPTIONS = [
  {
    id: "moonshotai/kimi-k2.6",
    label: "Kimi K2.6",
    guidance: "Default. Use for most basic tasks and ordinary work.",
    default: true,
  },
  {
    id: "anthropic/claude-sonnet-5",
    label: "Claude Sonnet 5",
    guidance:
      "Use for tasks that need stronger thinking, execution, complex work, or high-quality writing.",
  },
  {
    id: "openai/gpt-5.5",
    label: "GPT 5.5",
    guidance: "Use for coding-related work, sharper analysis, and deeper thinking.",
  },
] as const satisfies readonly GoatHarnessModelOption[];

function promptBlock(name: string, lines: readonly string[]) {
  return [`<${name}>`, ...lines, `</${name}>`].join("\n");
}

function promptValue(name: string, value: string | number) {
  return [`<${name}>`, escapeXmlText(String(value)), `</${name}>`].join("\n");
}

function promptList(name: string, itemName: string, values: readonly string[]) {
  return [`<${name}>`, ...values.map((value) => promptValue(itemName, value)), `</${name}>`].join(
    "\n",
  );
}

function promptModelOptions(values: readonly GoatHarnessModelOption[]) {
  return promptBlock(
    "execution_model_options",
    values.map((option) =>
      promptBlock("model_option", [
        promptValue("id", option.id),
        promptValue("label", option.label),
        promptValue("selection_guidance", option.guidance),
        promptValue("default", option.default ? "true" : "false"),
      ]),
    ),
  );
}

function escapeXmlText(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export const GOAT_HARNESS_CREATION_SYSTEM = promptBlock("system", [
  "You plan a Goat durable task harness.",
  "Return a strict goat.harness.v1 object.",
]);

export const GOAT_HARNESS_CREATION_MODEL_SELECTION = promptBlock("model_selection", [
  "Choose the execution model from the provided execution_model_options.",
  "Prefer the default model unless the task clearly benefits from a stronger specialized model.",
]);

export const GOAT_HARNESS_CREATION_PROMPT_CONTRACT = promptBlock("prompt_contract", [
  "Always return a non-empty systemPrompt for the task execution model.",
  "The systemPrompt must include the durable task-runner behavior, tool policy, and result contract needed to execute this task.",
  "Do not rely on any fallback system prompt.",
]);

export const GOAT_HARNESS_CREATION_TOOL_POLICY = promptBlock("tool_policy", [
  "Select only operation-level tools from the available list.",
  "Rewrite stale chat-layer limitations into clear instructions to use connected read-only tools when available.",
  "For GitHub work, include github_clone_repository plus the needed follow-up GitHub tools only when a concrete owner/repo is relevant to the task.",
  "Include github_open_pull_request only when the user explicitly asked to publish, push, or open a pull request.",
]);

export const GOAT_HARNESS_CREATION_RESULT_CONTRACT = promptBlock("result_contract", [
  "The task result comes from the final assistant message; there is no final-result tool.",
  'Use resultMode "brain_markdown_report" for deep research, market research, competitor or landscape research, literature research, multi-source web research, or any task where the durable deliverable should be a named Markdown report.',
  'Use resultMode "assistant_final" for ordinary answers, quick summaries, and action-oriented tasks where the final assistant message is the deliverable.',
  'When resultMode is "brain_markdown_report", the execution systemPrompt must tell the model to finish with only a complete, self-contained Markdown report suitable for saving as a .md file in the user Brain.',
]);

export const GOAT_HARNESS_CREATION_SYSTEM_PROMPT = promptBlock("goat_harness_planner", [
  GOAT_HARNESS_CREATION_SYSTEM,
  GOAT_HARNESS_CREATION_MODEL_SELECTION,
  GOAT_HARNESS_CREATION_PROMPT_CONTRACT,
  GOAT_HARNESS_CREATION_TOOL_POLICY,
  GOAT_HARNESS_CREATION_RESULT_CONTRACT,
]);

export function buildGoatHarnessCreationPrompt(input: {
  taskPrompt: string;
  executionModelOptions: readonly GoatHarnessModelOption[];
  availableOperationTools: readonly GoatTaskToolName[];
  defaultMaxModelSteps: number;
}) {
  return promptBlock("planner_inputs", [
    promptModelOptions(input.executionModelOptions),
    promptList("available_operation_tools", "tool", input.availableOperationTools),
    promptValue("default_max_model_steps", input.defaultMaxModelSteps),
    promptValue("task_prompt", input.taskPrompt),
  ]);
}
