import {
  type AgentModelDefinition,
  CODEX_AGENT_MODEL_IDS,
  getAgentModelDefinition,
} from "@opencompany/agent-runtime";
import type {
  HarnessEngine,
  HarnessSpec,
  TaskSkillId,
  TaskToolName,
} from "@opencompany/db/product-schema";

export type HarnessModelOption = AgentModelDefinition & {
  guidance: string;
  default?: boolean;
};

export type HarnessEngineOption = {
  id: HarnessEngine;
  label: string;
  guidance: string;
  default?: boolean;
};

export const HARNESS_ENGINE_OPTIONS = [
  {
    id: "opencompany",
    label: "opencompany model harness",
    guidance: "Default. Use for research, writing, analysis, planning, and ordinary tool work.",
    default: true,
  },
  {
    id: "codex",
    label: "Codex",
    guidance:
      "Use for coding tasks, repository edits, tests, debugging, code review, and any coding task where the user explicitly asks for Codex.",
  },
] as const satisfies readonly HarnessEngineOption[];

export type HarnessSkillOption = {
  id: TaskSkillId;
  label: string;
  guidance: string;
};

const CODEX_HARNESS_MODEL_GUIDANCE = {
  "openai/gpt-5.6-sol": "Default Codex model. Use for complex coding, research, and computer use.",
  "openai/gpt-5.6-terra": "Use for capable, efficient everyday Codex work.",
  "openai/gpt-5.6-luna":
    "Use for fast, affordable Codex work with clear and repeatable requirements.",
} as const satisfies Record<(typeof CODEX_AGENT_MODEL_IDS)[number], string>;

const HARNESS_MODEL_CONFIG = [
  {
    id: "moonshotai/kimi-k2.6",
    guidance:
      "Default. Use for most tasks, deep web research, multi-source reports, ordinary tool work, and cost-conscious long-horizon execution.",
    default: true,
  },
  {
    id: "moonshotai/kimi-k3",
    guidance:
      "Premium Kimi. Use when the user requests Kimi K3, needs the largest Kimi context window, or explicitly prioritizes frontier Kimi reasoning over cost.",
  },
  {
    id: "zai/glm-5.2",
    guidance:
      "Use for deep research or analysis that likely needs very large context, long source-set synthesis, or stronger structured reasoning than the default while staying cost-conscious.",
  },
  {
    id: "anthropic/claude-sonnet-5",
    guidance:
      "Premium fallback. Use when the user asks for Claude/Sonnet, explicitly prioritizes maximum quality over cost, or needs premium polished writing/editorial judgment, vision, or file-input strengths. Do not choose merely because research is deep.",
  },
  ...CODEX_AGENT_MODEL_IDS.map((id) => ({ id, guidance: CODEX_HARNESS_MODEL_GUIDANCE[id] })),
] as const satisfies readonly {
  id: HarnessSpec["model"];
  guidance: string;
  default?: boolean;
}[];

export const HARNESS_MODEL_OPTIONS: readonly HarnessModelOption[] = HARNESS_MODEL_CONFIG.map(
  (option) => ({
    ...requireAgentModelDefinition(option.id),
    ...option,
  }),
);

export const HARNESS_SKILL_OPTIONS = [
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
] as const satisfies readonly HarnessSkillOption[];

function requireAgentModelDefinition(modelId: HarnessSpec["model"]) {
  const model = getAgentModelDefinition(modelId);
  if (!model) {
    throw new Error(`Harness model "${modelId}" is missing from the agent model catalog.`);
  }
  return model;
}

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

function promptModelOptions(values: readonly HarnessModelOption[]) {
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

function promptEngineOptions(values: readonly HarnessEngineOption[]) {
  return promptBlock(
    "execution_engine_options",
    values.map((option) =>
      promptBlock("engine_option", [
        promptValue("id", option.id),
        promptValue("label", option.label),
        promptValue("selection_guidance", option.guidance),
        promptValue("default", option.default ? "true" : "false"),
      ]),
    ),
  );
}

function promptSkillOptions(values: readonly HarnessSkillOption[]) {
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

export const HARNESS_CREATION_SYSTEM = promptBlock("system", [
  "You plan an opencompany durable task harness.",
  "Return a strict goat.harness.v1 object.",
]);

export const HARNESS_CREATION_MODEL_SELECTION = promptBlock("model_selection", [
  "Choose the execution engine from the provided execution_engine_options.",
  "If requested_engine is present, use that exact engine unless it is unavailable in execution_engine_options.",
  "Do not override requested_engine just because the task is read-only, analytical, or could also be done with ordinary tools.",
  'Use engine "codex" for coding tasks when the user explicitly mentions Codex.',
  'Use engine "codex" for repository editing, debugging, tests, code review, or pull-request work when Codex is the better executor.',
  'Use engine "opencompany" for non-coding tasks and for coding-adjacent explanation that does not need a sandboxed coding agent.',
  "Choose the execution model from the provided execution_model_options.",
  'When engine is "codex", choose an OpenAI Codex-capable model from the execution model options.',
  "Cost matters. Prefer the cheapest capable default unless a premium or specialized model is clearly justified.",
  "For deep web research, market research, literature research, landscape research, and brain_markdown_report tasks, choose Kimi K2.6 by default.",
  "Choose Kimi K3 when the user requests Kimi K3, needs the largest Kimi context window, or explicitly prioritizes frontier Kimi reasoning over cost.",
  "Do not upgrade deep research to Claude Sonnet merely because the task is deep, multi-source, or report-shaped.",
  "Choose GLM 5.2 when the task likely needs very large context, long source-set synthesis, or long-horizon structured reasoning and does not need premium multimodal/file-input behavior.",
  "Choose Claude Sonnet 5 only when the user requests Claude/Sonnet, explicitly prioritizes maximum quality over cost, or the task needs premium polished writing/editorial judgment, vision, or file-input strengths.",
]);

export const HARNESS_CREATION_PROMPT_CONTRACT = promptBlock("prompt_contract", [
  "Always return a non-empty systemPrompt for the task execution model.",
  "The systemPrompt must include the durable task-runner behavior, tool policy, and result contract needed to execute this task.",
  "Do not rely on any fallback system prompt.",
  "Treat task_prompt as the source of truth for what the user asked.",
  "Keep initialUserMessage close to task_prompt. Do not expand it into a more detailed task, add guessed requirements, or invent success criteria.",
  "Only add light clarifications to initialUserMessage when they come directly from planner inputs, such as requested_engine, available connected repository names, selected output mode, or tool-access realities.",
  "Put execution guidance, tool-use sequencing, and result-format rules in systemPrompt instead of inflating initialUserMessage.",
]);

export const HARNESS_CREATION_TOOL_POLICY = promptBlock("tool_policy", [
  "Select only operation-level tools from the available list.",
  "Rewrite stale chat-layer limitations into clear instructions to use connected read-only tools when available.",
  "Use exa_search for broad web discovery, source lookup, and cited research across many pages.",
  "Use browser_* tools when the task depends on rendered websites, dynamic pages, marketplace or product inspection, filters, forms, screenshots, or navigation through a real site.",
  "Use both exa_search and browser_* tools when search should find candidate pages and the browser should inspect or interact with those pages.",
  "For browser tasks, instruct the execution model to use browser_find, browser_get, browser_read, and scoped browser_snapshot calls before broad snapshots.",
  "For browser tasks that require direct URLs from a list of links, instruct the execution model to get the link href with browser_get target attr attribute href or use browser_snapshot includeUrls=true; never infer slugs from titles.",
  "For product or marketplace tasks, instruct the execution model to use at most one broad orientation snapshot, then targeted reads/getters/finders for details.",
  "For browser tasks, instruct the execution model to call browser_screenshot only when visual confirmation is explicitly needed; browser_snapshot and browser_read should be the normal reading tools.",
  "For browser tasks, instruct the execution model to stop calling tools and produce the final answer as soon as the requested details are available.",
  "Browser tools are read/research-only. Never instruct the execution model to log in, buy, check out, mutate accounts, enter credentials, enter payment details, upload files, download files, or perform destructive actions.",
  "For X/Twitter social-listening, complaint-mining, or profile research tasks, include the relevant x_* tools when available; start from profile/search posts, then inspect discussions on specific high-signal posts with x_get_discussion.",
  'For engine "opencompany" GitHub work, include github_clone_repository plus the needed follow-up GitHub tools only when a concrete owner/repo is relevant to the task.',
  'For engine "codex", do not include GitHub operation tools just so Codex can edit code; instead set codex.repository when the task names a concrete owner/repo.',
  'For engine "codex", set codex.repository to the exact owner/repo from available_github_repositories when the task mentions that full name or uniquely mentions the repo name.',
  'For engine "codex", set codex.createPullRequest true only when the user explicitly asks to publish, push, create, make, or open a PR/pull request.',
  "Include github_open_pull_request only when the user explicitly asked to publish, push, or open a pull request.",
]);

export const HARNESS_CREATION_SKILL_POLICY = promptBlock("skill_policy", [
  "Select zero or more skills from available_skills when they materially improve execution.",
  "Skills are reasoning and operating guidance, not operation-level tools. They do not grant external access.",
  "Use first-principles for hard decisions, shaky assumptions, or cases where conventional answers may be wrong.",
  "Use yc-office-hours for startup, founder, product, growth, fundraising, hiring, or prioritization tasks that should feel like office hours.",
  "Do not select a skill just because it sounds generally useful; leave skills empty for routine execution.",
]);

export const HARNESS_CREATION_RESULT_CONTRACT = promptBlock("result_contract", [
  "The task result comes from the final assistant message; there is no final-result tool.",
  'Use resultMode "brain_markdown_report" for deep research, market research, competitor or landscape research, literature research, multi-source web research, or any task where the durable deliverable should be a named Markdown report.',
  'Use resultMode "assistant_final" for ordinary answers, quick summaries, and action-oriented tasks where the final assistant message is the deliverable.',
  'When resultMode is "brain_markdown_report", the execution systemPrompt must tell the model to finish with only a complete, self-contained Markdown report suitable for saving as a .md file in the user Brain.',
]);

export const HARNESS_CREATION_SYSTEM_PROMPT = promptBlock("goat_harness_planner", [
  HARNESS_CREATION_SYSTEM,
  HARNESS_CREATION_MODEL_SELECTION,
  HARNESS_CREATION_PROMPT_CONTRACT,
  HARNESS_CREATION_TOOL_POLICY,
  HARNESS_CREATION_SKILL_POLICY,
  HARNESS_CREATION_RESULT_CONTRACT,
]);

export function buildHarnessCreationPrompt(input: {
  taskPrompt: string;
  requestedEngine?: HarnessEngine | null;
  executionEngineOptions: readonly HarnessEngineOption[];
  executionModelOptions: readonly HarnessModelOption[];
  availableOperationTools: readonly TaskToolName[];
  availableSkills: readonly HarnessSkillOption[];
  githubRepositories?: readonly string[];
  defaultMaxModelSteps: number;
}) {
  const githubRepositories = input.githubRepositories ?? [];
  return promptBlock("planner_inputs", [
    promptEngineOptions(input.executionEngineOptions),
    ...(input.requestedEngine ? [promptValue("requested_engine", input.requestedEngine)] : []),
    promptModelOptions(input.executionModelOptions),
    promptList("available_operation_tools", "tool", input.availableOperationTools),
    promptSkillOptions(input.availableSkills),
    ...(githubRepositories.length > 0
      ? [promptList("available_github_repositories", "repository", githubRepositories)]
      : []),
    promptValue("default_max_model_steps", input.defaultMaxModelSteps),
    promptValue("task_prompt", input.taskPrompt),
  ]);
}

export function buildHarnessSkillSystemPrompt(skillIds: readonly TaskSkillId[]) {
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
