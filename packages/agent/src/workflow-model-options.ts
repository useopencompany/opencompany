import {
  AGENT_MODEL_PICKER_HIDDEN_IDS,
  type AgentModelDefinition,
  CLAUDE_CODE_AGENT_MODEL_IDS,
  CODEX_AGENT_MODEL_IDS,
  CODEX_REASONING_EFFORTS,
  claudeCodeModelSupportsReasoningEffort,
  claudeCodeModelSupportsUltracode,
  claudeCodeReasoningEffortsForModel,
  getAgentModelDefinition,
  isAgentModelSelectable,
  isClaudeCodeModelId,
  isClaudeCodeReasoningEffort,
  isCodexModelId,
  isCodexReasoningEffort,
  isCodexSubscriptionModel,
  OPENCOMPANY_CHAT_MODEL_IDS,
} from "@opencompany/agent-runtime";
import type {
  AgentModelId,
  CloudCodingReasoningEffort,
  CodexReasoningEffort,
} from "@opencompany/agent-runtime/types";
import type { HarnessEngine } from "@opencompany/db/product-schema";

type WorkflowModelConfig<Token extends string = string> = {
  token: Token;
  engine: HarnessEngine;
  modelId: AgentModelId;
  label?: string;
  hint?: string;
};

type WorkflowTokenForModelId<ModelId extends AgentModelId> =
  ModelId extends `anthropic/claude-${infer Model}`
    ? Model
    : ModelId extends `${string}/${infer Model}`
      ? Model
      : never;

type SharedChatWorkflowModelToken = Exclude<
  WorkflowTokenForModelId<(typeof OPENCOMPANY_CHAT_MODEL_IDS)[number]>,
  WorkflowTokenForModelId<(typeof AGENT_MODEL_PICKER_HIDDEN_IDS)[number]>
>;

// Workflow tokens are the provider-free model id, with Anthropic's redundant `claude-` prefix
// removed for compatibility with existing workflow documents and inline @mentions.
function workflowTokenForModelId<ModelId extends AgentModelId>(
  modelId: ModelId,
): WorkflowTokenForModelId<ModelId> {
  const providerFreeId = modelId.split("/")[1] ?? modelId;
  return providerFreeId.replace(/^claude-/, "") as WorkflowTokenForModelId<ModelId>;
}

// Normal workflow models come directly from the same ordered catalog as the main chat composer.
// The token is the only workflow-specific metadata; labels and descriptions stay in the catalog.
const SHARED_CHAT_WORKFLOW_MODEL_CONFIG: readonly WorkflowModelConfig<SharedChatWorkflowModelToken>[] =
  OPENCOMPANY_CHAT_MODEL_IDS.filter(isAgentModelSelectable).map((modelId) => ({
    token: workflowTokenForModelId(modelId) as SharedChatWorkflowModelToken,
    engine: "opencompany",
    modelId,
  }));

const CLOUD_WORKFLOW_MODEL_CONFIG = [
  {
    token: "codex",
    engine: "codex",
    modelId: "openai/gpt-5.6-sol",
    label: "Codex",
    hint: "Cloud coding agent (needs Codex connected)",
  },
  {
    token: "claude-code",
    engine: "claude_code",
    modelId: "anthropic/claude-sonnet-5",
    label: "Claude Code",
    hint: "Cloud coding agent (needs Claude Code connected)",
  },
] as const satisfies readonly WorkflowModelConfig[];

const WORKFLOW_MODEL_CONFIG: readonly WorkflowModelConfig<WorkflowModelToken>[] = [
  ...SHARED_CHAT_WORKFLOW_MODEL_CONFIG,
  ...CLOUD_WORKFLOW_MODEL_CONFIG,
];

export type WorkflowModelToken =
  | SharedChatWorkflowModelToken
  | (typeof CLOUD_WORKFLOW_MODEL_CONFIG)[number]["token"];

export type WorkflowModelOption = AgentModelDefinition & {
  token: WorkflowModelToken;
  engine: HarnessEngine;
  hint: string;
};

export type WorkflowCloudRuntime = Extract<HarnessEngine, "codex" | "claude_code">;

export type WorkflowCloudModelOption = AgentModelDefinition & {
  engine: WorkflowCloudRuntime;
};

export type WorkflowStepSettingsInput = {
  model: string;
  runtimeModel?: unknown;
  reasoningEffort?: unknown;
};

export const WORKFLOW_MODEL_OPTIONS: readonly WorkflowModelOption[] = WORKFLOW_MODEL_CONFIG.map(
  ({ modelId, hint, ...option }) => {
    const model = requireAgentModelDefinition(modelId);
    return {
      ...model,
      ...option,
      hint: hint ?? model.description,
    };
  },
);

// Keep the workflow default cost-conscious even though the interactive chat default is Kimi K3.
// Scheduled and event-driven workflows can run much more frequently than a user-driven chat.
export const DEFAULT_WORKFLOW_MODEL_TOKEN: WorkflowModelToken = "kimi-k2.6";
export const DEFAULT_WORKFLOW_REASONING_EFFORT: CodexReasoningEffort = "high";
export const WORKFLOW_REASONING_EFFORT_OPTIONS = CODEX_REASONING_EFFORTS;

export function workflowReasoningEffortOptions(
  engine: WorkflowCloudRuntime,
  runtimeModel: string,
): readonly CloudCodingReasoningEffort[] {
  return engine === "claude_code"
    ? claudeCodeReasoningEffortsForModel(runtimeModel)
    : CODEX_REASONING_EFFORTS;
}

const WORKFLOW_MODEL_TOKEN_SET = new Set<string>(
  WORKFLOW_MODEL_OPTIONS.map((option) => option.token),
);

export const WORKFLOW_CODEX_MODEL_OPTIONS: readonly WorkflowCloudModelOption[] =
  CODEX_AGENT_MODEL_IDS.map((modelId) => ({
    ...requireAgentModelDefinition(modelId),
    engine: "codex",
  }));

export const WORKFLOW_CLAUDE_CODE_MODEL_OPTIONS: readonly WorkflowCloudModelOption[] =
  CLAUDE_CODE_AGENT_MODEL_IDS.map((modelId) => ({
    ...requireAgentModelDefinition(modelId),
    engine: "claude_code",
  }));

// Steps on the opencompany engine route through the workspace's shared ChatGPT subscription when an
// admin has connected one, so those runs cost no workspace credits. Cloud coding runtimes bill
// against the member's own connected agent account, which the picker already states in its hint.
export function isWorkflowSubscriptionCoveredModel(option: WorkflowModelOption): boolean {
  return option.engine === "opencompany" && isCodexSubscriptionModel(option.id);
}

export function isWorkflowModelToken(value: unknown): value is WorkflowModelToken {
  return typeof value === "string" && WORKFLOW_MODEL_TOKEN_SET.has(value);
}

export function workflowModelSelection(input: {
  model: WorkflowModelToken;
  runtimeModel?: unknown;
  reasoningEffort?: unknown;
}): {
  engine: HarnessEngine;
  model: AgentModelId;
  reasoningEffort?: CloudCodingReasoningEffort;
} {
  const option = WORKFLOW_MODEL_OPTIONS.find((candidate) => candidate.token === input.model);
  if (!option) {
    throw new Error(`Workflow model token "${input.model}" is missing from the workflow catalog.`);
  }
  if (!isWorkflowCloudRuntime(option.engine)) {
    return { engine: option.engine, model: option.id };
  }

  const runtimeModel = normalizeWorkflowRuntimeModel(option.engine, input.runtimeModel);
  const reasoningEffort = normalizeWorkflowReasoningEffort(
    option.engine,
    runtimeModel,
    input.reasoningEffort,
  );
  return {
    engine: option.engine,
    model: runtimeModel,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

export function workflowStepSettings(input: WorkflowStepSettingsInput): {
  model: string;
  runtimeModel?: AgentModelId;
  reasoningEffort?: CloudCodingReasoningEffort;
} {
  const model = input.model.trim().toLowerCase();
  if (!isWorkflowModelToken(model)) return { model };
  const option = WORKFLOW_MODEL_OPTIONS.find((candidate) => candidate.token === model);
  if (!option || !isWorkflowCloudRuntime(option.engine)) return { model };

  const runtimeModel = normalizeWorkflowRuntimeModel(option.engine, input.runtimeModel);
  const reasoningEffort = normalizeWorkflowReasoningEffort(
    option.engine,
    runtimeModel,
    input.reasoningEffort,
  );

  return {
    model,
    runtimeModel,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

export function isWorkflowCloudRuntime(engine: HarnessEngine): engine is WorkflowCloudRuntime {
  return engine === "codex" || engine === "claude_code";
}

export function workflowCloudModelOptions(
  engine: WorkflowCloudRuntime,
): readonly WorkflowCloudModelOption[] {
  return engine === "codex" ? WORKFLOW_CODEX_MODEL_OPTIONS : WORKFLOW_CLAUDE_CODE_MODEL_OPTIONS;
}

export function defaultWorkflowRuntimeModel(engine: WorkflowCloudRuntime): AgentModelId {
  const defaultOption = WORKFLOW_MODEL_OPTIONS.find((option) => option.engine === engine);
  if (!defaultOption) {
    throw new Error(`Workflow cloud runtime "${engine}" is missing from the workflow catalog.`);
  }
  return defaultOption.id;
}

export function isWorkflowRuntimeModel(
  engine: WorkflowCloudRuntime,
  value: string,
): value is AgentModelId {
  return engine === "codex" ? isCodexModelId(value) : isClaudeCodeModelId(value);
}

export function workflowRuntimeModelSupportsReasoningEffort(
  engine: WorkflowCloudRuntime,
  model: string,
): boolean {
  return engine === "codex" || claudeCodeModelSupportsReasoningEffort(model);
}

export function normalizeWorkflowRuntimeModel(
  engine: WorkflowCloudRuntime,
  value: unknown,
): AgentModelId {
  const model = typeof value === "string" ? value.trim() : "";
  return model && isWorkflowRuntimeModel(engine, model)
    ? model
    : defaultWorkflowRuntimeModel(engine);
}

export function normalizeWorkflowReasoningEffort(
  engine: WorkflowCloudRuntime,
  runtimeModel: string,
  value: unknown,
): CloudCodingReasoningEffort | undefined {
  if (!workflowRuntimeModelSupportsReasoningEffort(engine, runtimeModel)) return undefined;
  if (typeof value === "string") {
    if (
      engine === "claude_code" &&
      isClaudeCodeReasoningEffort(value) &&
      (value !== "ultracode" || claudeCodeModelSupportsUltracode(runtimeModel))
    ) {
      return value;
    }
    if (engine === "codex" && isCodexReasoningEffort(value)) return value;
  }
  return DEFAULT_WORKFLOW_REASONING_EFFORT;
}

function requireAgentModelDefinition(modelId: AgentModelId) {
  const model = getAgentModelDefinition(modelId);
  if (!model) {
    throw new Error(`Workflow model "${modelId}" is missing from the agent model catalog.`);
  }
  return model;
}

const DEFAULT_WORKFLOW_SELECTION: ReturnType<typeof workflowModelSelection> =
  workflowModelSelection({
    model: DEFAULT_WORKFLOW_MODEL_TOKEN,
  });

// The token must end alphanumeric so trailing punctuation ("run @sonnet-5.")
// stays out of the capture while inner dots ("@kimi-k2.6") still match.
const WORKFLOW_MENTION_TOKEN_PATTERN = /(^|\s)@([a-z0-9](?:[a-z0-9./-]*[a-z0-9])?)/gi;

export function resolveWorkflowStepModelSelection(step: {
  model: string;
  runtimeModel?: unknown;
  reasoningEffort?: unknown;
  instructions: string;
}): ReturnType<typeof workflowModelSelection> {
  const selectedToken = step.model.trim().toLowerCase();
  if (selectedToken) {
    if (!isWorkflowModelToken(selectedToken)) {
      throw new Error(
        `This workflow step's model "${selectedToken}" is not available. Pick a model in the workflow editor.`,
      );
    }
    return workflowModelSelection({
      model: selectedToken,
      runtimeModel: step.runtimeModel,
      reasoningEffort: step.reasoningEffort,
    });
  }

  const selected = new Map<string, ReturnType<typeof workflowModelSelection>>();
  for (const match of step.instructions.matchAll(WORKFLOW_MENTION_TOKEN_PATTERN)) {
    const token = (match[2] ?? "").toLowerCase();
    if (!isWorkflowModelToken(token)) continue;
    selected.set(token, workflowModelSelection({ model: token }));
  }
  if (selected.size > 1) {
    throw new Error(
      `This workflow step mentions more than one model (${[...selected.keys()]
        .map((token) => `@${token}`)
        .join(", ")}). Pick one model for the step.`,
    );
  }
  return [...selected.values()][0] ?? DEFAULT_WORKFLOW_SELECTION;
}
