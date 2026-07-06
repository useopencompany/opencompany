import type {
  GoatHarnessSpec,
  GoatTaskSkillId,
  GoatTaskToolName,
} from "@opencompany/db/goat-schema";

export type GoatHarnessModelOption = {
  id: GoatHarnessSpec["model"];
  label: string;
  guidance: string;
  default?: boolean;
};

export type GoatHarnessSkillOption = {
  id: GoatTaskSkillId;
  label: string;
  guidance: string;
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

export const GOAT_HARNESS_SKILL_OPTIONS = [
  {
    id: "first-principles",
    label: "First-principles thinking",
    guidance:
      "Use for hard, high-stakes, or stuck decisions where assumptions need to be stripped down and rebuilt from fundamentals.",
  },
  {
    id: "yc-office-hours",
    label: "YC office hours",
    guidance:
      "Use for founder, startup strategy, product, MVP, users, growth, fundraising, hiring, or prioritization tasks that benefit from a YC-style office-hours loop.",
  },
] as const satisfies readonly GoatHarnessSkillOption[];

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

function promptSkillOptions(values: readonly GoatHarnessSkillOption[]) {
  return promptBlock(
    "available_skills",
    values.map((option) =>
      promptBlock("skill", [
        promptValue("id", option.id),
        promptValue("label", option.label),
        promptValue("selection_guidance", option.guidance),
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

export const GOAT_HARNESS_CREATION_SKILL_POLICY = promptBlock("skill_policy", [
  "Select zero or more skills from available_skills when they materially improve execution.",
  "Skills are reasoning and operating guidance, not operation-level tools. They do not grant external access.",
  "Use first-principles for hard decisions, shaky assumptions, or cases where conventional answers may be wrong.",
  "Use yc-office-hours for startup, founder, product, growth, fundraising, hiring, or prioritization tasks that should feel like office hours.",
  "Do not select a skill just because it sounds generally useful; leave skills empty for routine execution.",
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
  GOAT_HARNESS_CREATION_SKILL_POLICY,
  GOAT_HARNESS_CREATION_RESULT_CONTRACT,
]);

export function buildGoatHarnessCreationPrompt(input: {
  taskPrompt: string;
  executionModelOptions: readonly GoatHarnessModelOption[];
  availableOperationTools: readonly GoatTaskToolName[];
  availableSkills: readonly GoatHarnessSkillOption[];
  defaultMaxModelSteps: number;
}) {
  return promptBlock("planner_inputs", [
    promptModelOptions(input.executionModelOptions),
    promptList("available_operation_tools", "tool", input.availableOperationTools),
    promptSkillOptions(input.availableSkills),
    promptValue("default_max_model_steps", input.defaultMaxModelSteps),
    promptValue("task_prompt", input.taskPrompt),
  ]);
}

export function buildGoatHarnessSkillSystemPrompt(skillIds: readonly GoatTaskSkillId[]) {
  const blocks = skillIds.flatMap((skillId) => {
    switch (skillId) {
      case "first-principles":
        return [
          promptBlock("skill:first-principles", [
            "Use first-principles thinking for the core reasoning in this task.",
            "State the real outcome before choosing a solution.",
            "Separate bedrock facts from inherited convention, then test whether each constraint is actually necessary.",
            "Rebuild the answer from the fundamentals and choose the simplest mechanism that satisfies them.",
            "Stress-test the result with a pre-mortem and name the single most important truth the recommendation rests on.",
          ]),
        ];
      case "yc-office-hours":
        return [
          promptBlock("skill:yc-office-hours", [
            "Use a YC-style office-hours loop for this task. Do not claim YC affiliation or imitate specific partners.",
            "Stage the company or product in one sentence: customer, problem, product, traction, team, and runway when known.",
            "Identify the live bottleneck: idea, users, activation, retention, revenue, distribution, hiring, fundraising, or focus.",
            "Prefer customer evidence and weekly numbers over opinions. Separate signal from founder narrative.",
            "End with one priority, a concrete experiment, success criteria, owner/deadline when relevant, and founder homework.",
          ]),
        ];
    }
  });

  return blocks.join("\n\n");
}
