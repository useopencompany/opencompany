import { TASK_UNTRUSTED_CONTENT_SAFETY_BLOCK } from "@opencompany/core/chat-agent";
import type {
  HarnessSpec,
  TaskDebugTrace,
  TaskSkillId,
  TaskToolName,
} from "@opencompany/db/schema";
import { getBraintrustAISDK } from "@opencompany/observability/braintrust";
import {
  createGatewayAttribution,
  gatewayProviderOptions,
  SPANS,
  withSpan,
} from "@opencompany/telemetry";
import * as ai from "ai";
import { createGateway, jsonSchema, type LanguageModelUsage } from "ai";
import {
  buildHarnessCreationPrompt,
  buildHarnessSkillSystemPrompt,
  HARNESS_CREATION_SYSTEM_PROMPT,
  HARNESS_ENGINE_OPTIONS,
  HARNESS_MODEL_OPTIONS,
  HARNESS_SKILL_OPTIONS,
} from "./prompts/harness-creation";
import { normalizeTaskToolNames } from "./task-tool-names";

export const PLANNER_MODEL = "anthropic/claude-sonnet-4.6";
const DEFAULT_MAX_MODEL_STEPS = 16;
const MAX_MODEL_STEPS = 32;
const MIN_BROWSER_MODEL_STEPS = 16;
const CODEX_GOAL_OBJECTIVE_MAX_LENGTH = 4_000;
const DEFAULT_CODEX_GOAL_TOKEN_BUDGET = 200_000;
const MIN_CODEX_GOAL_TOKEN_BUDGET = 1;
const MAX_CODEX_GOAL_TOKEN_BUDGET = 1_000_000;

export async function planHarnessForTask(input: {
  prompt: string;
  model: HarnessSpec["model"];
  requestedEngine?: HarnessSpec["engine"];
  gatewayApiKey: string;
  userWorkosId?: string | null;
  taskId?: string | null;
  availableTools: readonly TaskToolName[];
  githubRepositories?: readonly string[];
  signal?: AbortSignal;
}): Promise<{
  harnessSpec: HarnessSpec;
  debugTrace: TaskDebugTrace;
  usage?: LanguageModelUsage;
}> {
  const availableTools = normalizeTaskToolNames(input.availableTools);
  const availableEngines = HARNESS_ENGINE_OPTIONS.map((option) => option.id);
  const availableModels = HARNESS_MODEL_OPTIONS.map((option) => option.id);
  const availableSkills = HARNESS_SKILL_OPTIONS.map((option) => option.id);
  const requestedEngine = readRequestedHarnessEngine(input.requestedEngine, availableEngines);
  const gateway = createGateway({ apiKey: input.gatewayApiKey });
  const { generateObject } = getBraintrustAISDK(ai);
  const schema = harnessSpecResponseSchema(
    availableTools,
    availableEngines,
    availableModels,
    availableSkills,
  );
  const systemPrompt = HARNESS_CREATION_SYSTEM_PROMPT;
  const userPrompt = buildHarnessCreationPrompt({
    taskPrompt: input.prompt,
    ...(requestedEngine ? { requestedEngine } : {}),
    executionEngineOptions: HARNESS_ENGINE_OPTIONS,
    executionModelOptions: HARNESS_MODEL_OPTIONS,
    availableOperationTools: availableTools,
    availableSkills: HARNESS_SKILL_OPTIONS,
    githubRepositories: input.githubRepositories ?? [],
    defaultMaxModelSteps: DEFAULT_MAX_MODEL_STEPS,
  });
  const attribution = createGatewayAttribution({
    userWorkosId: input.userWorkosId,
    feature: "task",
    ...(input.taskId ? { taskId: input.taskId } : {}),
  });

  const result = await withSpan(
    SPANS.taskPlan,
    {
      "goat.model": input.model,
      "goat.planner_model": PLANNER_MODEL,
      "goat.queued_model": input.model,
      "goat.tool_count": availableTools.length,
      "goat.skill_count": availableSkills.length,
    },
    () =>
      generateObject({
        model: gateway(PLANNER_MODEL),
        schema: jsonSchema(schema as never),
        system: systemPrompt,
        prompt: userPrompt,
        ...(input.signal ? { abortSignal: input.signal } : {}),
        providerOptions: gatewayProviderOptions(attribution),
      }),
  );
  const harnessSpec = normalizeHarnessSpec(
    result.object,
    {
      prompt: input.prompt,
      ...(requestedEngine ? { requestedEngine } : {}),
    },
    availableTools,
    availableEngines,
    availableModels,
    availableSkills,
    input.githubRepositories ?? [],
  );

  return {
    harnessSpec,
    debugTrace: {
      schemaVersion: "goat.debug.v1",
      planner: {
        model: PLANNER_MODEL,
        request: {
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          responseFormat: schema,
        },
        response: {
          content: JSON.stringify(harnessSpec),
        },
      },
    },
    ...(isLanguageModelUsage((result as { usage?: unknown }).usage)
      ? { usage: (result as { usage: LanguageModelUsage }).usage }
      : {}),
  };
}

function harnessSpecResponseSchema(
  availableTools: readonly TaskToolName[],
  availableEngines: readonly HarnessSpec["engine"][],
  availableModels: readonly HarnessSpec["model"][],
  availableSkills: readonly TaskSkillId[],
) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      schemaVersion: { type: "string", enum: ["goat.harness.v1"] },
      engine: { type: "string", enum: availableEngines },
      model: { type: "string", enum: availableModels },
      systemPrompt: { type: "string", minLength: 1 },
      initialUserMessage: { type: "string", minLength: 1 },
      tools: {
        type: "array",
        items: { type: "string", enum: availableTools },
        minItems: 1,
        maxItems: availableTools.length,
      },
      skills: {
        type: "array",
        items: { type: "string", enum: availableSkills },
        minItems: 0,
        maxItems: availableSkills.length,
        uniqueItems: true,
      },
      maxModelSteps: { type: "integer", minimum: 1, maximum: MAX_MODEL_STEPS },
      resultMode: { type: "string", enum: ["assistant_final", "brain_markdown_report"] },
      codex: {
        type: "object",
        additionalProperties: false,
        properties: {
          repository: { type: ["string", "null"] },
          createPullRequest: { type: "boolean" },
          reasoningEffort: { type: "string", enum: ["low", "medium", "high", "xhigh"] },
          goalMode: {
            type: "object",
            additionalProperties: false,
            properties: {
              objective: {
                type: "string",
                minLength: 1,
                maxLength: CODEX_GOAL_OBJECTIVE_MAX_LENGTH,
              },
              tokenBudget: {
                type: ["integer", "null"],
                minimum: MIN_CODEX_GOAL_TOKEN_BUDGET,
                maximum: MAX_CODEX_GOAL_TOKEN_BUDGET,
              },
            },
            required: ["objective"],
          },
        },
      },
    },
    required: [
      "schemaVersion",
      "engine",
      "model",
      "systemPrompt",
      "initialUserMessage",
      "tools",
      "skills",
      "maxModelSteps",
      "resultMode",
    ],
  } as const;
}

function normalizeHarnessSpec(
  value: unknown,
  fallback: {
    prompt: string;
    requestedEngine?: HarnessSpec["engine"];
  },
  availableTools: readonly TaskToolName[],
  availableEngines: readonly HarnessSpec["engine"][],
  availableModels: readonly HarnessSpec["model"][],
  availableSkills: readonly TaskSkillId[],
  githubRepositories: readonly string[],
): HarnessSpec {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const engine = fallback.requestedEngine ?? readHarnessEngine(record.engine, availableEngines);
  const model = readHarnessModel(record.model, availableModels, engine);
  if (!model) {
    throw new Error("Harness planner must choose a supported execution model.");
  }
  const systemPrompt = readNonEmptyString(record.systemPrompt);
  if (!systemPrompt) {
    throw new Error("Harness planner must return a non-empty systemPrompt.");
  }
  const initialUserMessage = readNonEmptyString(record.initialUserMessage) ?? fallback.prompt;
  const selectedTools = normalizeTaskToolNames(record.tools).filter((toolName) =>
    availableTools.includes(toolName),
  );
  const tools = selectedTools.length > 0 ? selectedTools : normalizeTaskToolNames(availableTools);
  const selectedSkills = normalizeTaskSkillIds(record.skills).filter((skillId) =>
    availableSkills.includes(skillId),
  );
  const requestedMaxModelSteps =
    typeof record.maxModelSteps === "number" && Number.isFinite(record.maxModelSteps)
      ? clampInteger(record.maxModelSteps, 1, MAX_MODEL_STEPS)
      : DEFAULT_MAX_MODEL_STEPS;
  const minModelSteps = tools.some((toolName) => toolName.startsWith("browser_"))
    ? MIN_BROWSER_MODEL_STEPS
    : 1;
  const maxModelSteps = Math.max(requestedMaxModelSteps, minModelSteps);

  const resultMode =
    record.resultMode === "brain_markdown_report" ? "brain_markdown_report" : "assistant_final";

  return {
    schemaVersion: "goat.harness.v1",
    engine,
    model,
    systemPrompt: augmentSystemPrompt(systemPrompt, resultMode, selectedSkills),
    initialUserMessage,
    tools,
    skills: selectedSkills,
    maxModelSteps,
    resultMode,
    ...(engine === "codex"
      ? { codex: readCodexHarnessConfig(record.codex, fallback.prompt, githubRepositories) }
      : {}),
  };
}

function readHarnessEngine(
  value: unknown,
  availableEngines: readonly HarnessSpec["engine"][],
): HarnessSpec["engine"] {
  const engine = readNonEmptyString(value);
  return engine && availableEngines.includes(engine as HarnessSpec["engine"])
    ? (engine as HarnessSpec["engine"])
    : "opencompany";
}

function readRequestedHarnessEngine(
  value: unknown,
  availableEngines: readonly HarnessSpec["engine"][],
): HarnessSpec["engine"] | undefined {
  const engine = readNonEmptyString(value);
  return engine && availableEngines.includes(engine as HarnessSpec["engine"])
    ? (engine as HarnessSpec["engine"])
    : undefined;
}

function normalizeTaskSkillIds(value: unknown): TaskSkillId[] {
  if (!Array.isArray(value)) return [];
  const ids = value.filter((item): item is TaskSkillId =>
    HARNESS_SKILL_OPTIONS.some((option) => option.id === item),
  );
  return [...new Set(ids)];
}

function readHarnessModel(
  value: unknown,
  availableModels: readonly HarnessSpec["model"][],
  engine: HarnessSpec["engine"],
): HarnessSpec["model"] | null {
  const model = readNonEmptyString(value);
  if (engine === "codex") {
    const codexModel = availableModels.find((candidate) => candidate.startsWith("openai/"));
    return codexModel ?? null;
  }
  return model && availableModels.includes(model as HarnessSpec["model"])
    ? (model as HarnessSpec["model"])
    : null;
}

function readCodexHarnessConfig(
  value: unknown,
  prompt: string,
  githubRepositories: readonly string[],
): NonNullable<HarnessSpec["codex"]> {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const plannedRepository = normalizeGitHubRepositoryMention(readNonEmptyString(record.repository));
  const repository =
    canonicalGitHubRepository(plannedRepository, githubRepositories) ??
    inferCodexRepositoryFromPrompt(prompt, githubRepositories) ??
    plannedRepository;
  const promptPullRequestIntent = readPullRequestIntent(prompt);
  const goalMode = readCodexGoalMode(record.goalMode);
  return {
    repository,
    createPullRequest: promptPullRequestIntent ?? record.createPullRequest === true,
    reasoningEffort: readCodexReasoningEffort(record.reasoningEffort),
    ...(goalMode ? { goalMode } : {}),
  };
}

function readCodexReasoningEffort(value: unknown) {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh"
    ? value
    : "high";
}

function readCodexGoalMode(value: unknown): NonNullable<HarnessSpec["codex"]>["goalMode"] | null {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  if (!record) return null;
  const objective = readNonEmptyString(record.objective);
  if (!objective) return null;
  const hasTokenBudget = Object.prototype.hasOwnProperty.call(record, "tokenBudget");
  const tokenBudget = !hasTokenBudget
    ? DEFAULT_CODEX_GOAL_TOKEN_BUDGET
    : record.tokenBudget === null
      ? null
      : typeof record.tokenBudget === "number"
        ? clampInteger(record.tokenBudget, MIN_CODEX_GOAL_TOKEN_BUDGET, MAX_CODEX_GOAL_TOKEN_BUDGET)
        : DEFAULT_CODEX_GOAL_TOKEN_BUDGET;
  return {
    objective: objective.slice(0, CODEX_GOAL_OBJECTIVE_MAX_LENGTH),
    tokenBudget,
  };
}

function inferCodexRepositoryFromPrompt(prompt: string, githubRepositories: readonly string[]) {
  const explicit = normalizeGitHubRepositoryMention(prompt);
  if (explicit) return canonicalGitHubRepository(explicit, githubRepositories) ?? explicit;

  const matches = normalizeGitHubRepositories(githubRepositories).filter((repository) =>
    textMentionsRepositoryName(prompt, repository.name),
  );
  return matches.length === 1 ? matches[0]!.fullName : null;
}

function canonicalGitHubRepository(
  repository: string | null,
  githubRepositories: readonly string[],
) {
  if (!repository) return null;
  const normalized = repository.toLowerCase();
  return (
    normalizeGitHubRepositories(githubRepositories).find(
      (candidate) => candidate.fullName.toLowerCase() === normalized,
    )?.fullName ?? null
  );
}

function normalizeGitHubRepositories(githubRepositories: readonly string[]) {
  return githubRepositories
    .map((fullName) => normalizeGitHubRepositoryMention(fullName))
    .filter((fullName): fullName is string => Boolean(fullName))
    .map((fullName) => ({
      fullName,
      name: fullName.split("/")[1] ?? fullName,
    }));
}

function normalizeGitHubRepositoryMention(value: string | null) {
  if (!value) return null;
  const trimmed = value.trim();
  const githubUrl = trimmed.match(
    /https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\.git)?(?:[/?#].*)?/i,
  );
  const candidate = githubUrl ? `${githubUrl[1]}/${githubUrl[2]}` : findOwnerRepoMention(trimmed);
  if (!candidate) return null;
  const withoutGitSuffix = candidate.replace(/[.,;:!?]+$/, "").replace(/\.git$/i, "");
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(withoutGitSuffix) ? withoutGitSuffix : null;
}

function findOwnerRepoMention(value: string) {
  const match = value.match(
    /(?:^|[\s([`'"])([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?=$|[\s)\]`'".,;:!?])/,
  );
  return match?.[1] ?? null;
}

function textMentionsRepositoryName(text: string, repositoryName: string) {
  const escaped = repositoryName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_.-])${escaped}($|[^A-Za-z0-9_.-])`, "i").test(text);
}

function readPullRequestIntent(prompt: string) {
  const text = prompt.toLowerCase();
  if (
    /\b(do not|don't|dont|without|no)\s+(open|create|publish|push|make)?\s*(a\s*)?(draft\s*)?(pr|pull request)\b/.test(
      text,
    )
  ) {
    return false;
  }
  return /\b(open|create|publish|push|make)\s+(a\s*)?(draft\s*)?(pr|pull request)\b/.test(text)
    ? true
    : null;
}

function augmentSystemPrompt(
  systemPrompt: string,
  resultMode: HarnessSpec["resultMode"],
  skillIds: readonly TaskSkillId[],
) {
  const sections = [withTaskSafetyPromptText(systemPrompt)];
  const skillPrompt = buildHarnessSkillSystemPrompt(skillIds);
  if (skillPrompt) sections.push(skillPrompt);
  if (resultMode === "brain_markdown_report") {
    sections.push(
      [
        "<brain_markdown_report_result_contract>",
        "Finish with only the complete Markdown report body.",
        "Do not include conversational framing, delivery notes, or a separate summary outside the report.",
        "Use a clear H1 title, concise executive summary, sourced findings, uncertainty, and practical next steps when relevant.",
        "The harness will save this final Markdown as a .md file in the user's Brain and return the file link as the task result.",
        "</brain_markdown_report_result_contract>",
      ].join("\n"),
    );
  }
  return sections.join("\n\n");
}

function withTaskSafetyPromptText(systemPrompt: string) {
  return systemPrompt.includes(TASK_UNTRUSTED_CONTENT_SAFETY_BLOCK)
    ? systemPrompt
    : `${systemPrompt}\n\n${TASK_UNTRUSTED_CONTENT_SAFETY_BLOCK}`;
}

function isLanguageModelUsage(value: unknown): value is LanguageModelUsage {
  return Boolean(value && typeof value === "object");
}

function readNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function clampInteger(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
