import {
  type AgentModelDefinition,
  CLAUDE_CODE_AGENT_MODEL_IDS,
  CODEX_AGENT_MODEL_IDS,
  CODEX_REASONING_EFFORTS,
  claudeCodeModelSupportsReasoningEffort,
  getAgentModelDefinition,
  isClaudeCodeModelId,
  isCodexModelId,
  isCodexReasoningEffort,
} from "@opencompany/agent-runtime";
import type { AgentModelId, CodexReasoningEffort } from "@opencompany/agent-runtime/types";
import type { GoatHarnessEngine } from "@opencompany/db/schema";

// The token is stored on a workflow step and can also be used as an inline
// `@<token>` mention. Model metadata comes from the shared agent catalog.
const GOAT_WORKFLOW_MODEL_CONFIG = [
  {
    token: "kimi-k2.6",
    engine: "opencompany",
    modelId: "moonshotai/kimi-k2.6",
    hint: "Default — fast and cost-conscious",
  },
  {
    token: "kimi-k3",
    engine: "opencompany",
    modelId: "moonshotai/kimi-k3",
    hint: "Premium Kimi reasoning",
  },
  {
    token: "glm-5.2",
    engine: "opencompany",
    modelId: "zai/glm-5.2",
    hint: "Large-context research",
  },
  {
    token: "sonnet-5",
    engine: "opencompany",
    modelId: "anthropic/claude-sonnet-5",
    hint: "Premium writing and judgment",
  },
  {
    token: "gpt-5.5",
    engine: "opencompany",
    modelId: "openai/gpt-5.5",
    hint: "Coding and sharp analysis",
  },
  {
    token: "codex",
    engine: "codex",
    modelId: "openai/gpt-5.5",
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
] as const satisfies readonly {
  token: string;
  engine: GoatHarnessEngine;
  modelId: AgentModelId;
  label?: string;
  hint: string;
}[];

export type GoatWorkflowModelToken = (typeof GOAT_WORKFLOW_MODEL_CONFIG)[number]["token"];

export type GoatWorkflowModelOption = AgentModelDefinition & {
  token: GoatWorkflowModelToken;
  engine: GoatHarnessEngine;
  hint: string;
};

export type GoatWorkflowCloudRuntime = Extract<GoatHarnessEngine, "codex" | "claude_code">;

export type GoatWorkflowCloudModelOption = AgentModelDefinition & {
  engine: GoatWorkflowCloudRuntime;
};

export type GoatWorkflowStepSettingsInput = {
  model: string;
  runtimeModel?: unknown;
  reasoningEffort?: unknown;
};

export const GOAT_WORKFLOW_MODEL_OPTIONS: readonly GoatWorkflowModelOption[] =
  GOAT_WORKFLOW_MODEL_CONFIG.map(({ modelId, ...option }) => ({
    ...requireAgentModelDefinition(modelId),
    ...option,
  }));

export const DEFAULT_GOAT_WORKFLOW_MODEL_TOKEN: GoatWorkflowModelToken = "kimi-k2.6";
export const DEFAULT_GOAT_WORKFLOW_REASONING_EFFORT: CodexReasoningEffort = "high";
export const GOAT_WORKFLOW_REASONING_EFFORT_OPTIONS = CODEX_REASONING_EFFORTS;

const GOAT_WORKFLOW_MODEL_TOKEN_SET = new Set<string>(
  GOAT_WORKFLOW_MODEL_OPTIONS.map((option) => option.token),
);

export const GOAT_WORKFLOW_CODEX_MODEL_OPTIONS: readonly GoatWorkflowCloudModelOption[] =
  CODEX_AGENT_MODEL_IDS.map((modelId) => ({
    ...requireAgentModelDefinition(modelId),
    engine: "codex",
  }));

export const GOAT_WORKFLOW_CLAUDE_CODE_MODEL_OPTIONS: readonly GoatWorkflowCloudModelOption[] =
  CLAUDE_CODE_AGENT_MODEL_IDS.map((modelId) => ({
    ...requireAgentModelDefinition(modelId),
    engine: "claude_code",
  }));

export function isGoatWorkflowModelToken(value: unknown): value is GoatWorkflowModelToken {
  return typeof value === "string" && GOAT_WORKFLOW_MODEL_TOKEN_SET.has(value);
}

export function goatWorkflowModelSelection(input: {
  model: GoatWorkflowModelToken;
  runtimeModel?: unknown;
  reasoningEffort?: unknown;
}): {
  engine: GoatHarnessEngine;
  model: AgentModelId;
  reasoningEffort?: CodexReasoningEffort;
} {
  const option = GOAT_WORKFLOW_MODEL_OPTIONS.find((candidate) => candidate.token === input.model);
  if (!option) {
    throw new Error(`Workflow model token "${input.model}" is missing from the workflow catalog.`);
  }
  if (!isGoatWorkflowCloudRuntime(option.engine)) {
    return { engine: option.engine, model: option.id };
  }

  const runtimeModel = normalizeGoatWorkflowRuntimeModel(option.engine, input.runtimeModel);
  const reasoningEffort = normalizeGoatWorkflowReasoningEffort(
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

export function goatWorkflowStepSettings(input: GoatWorkflowStepSettingsInput): {
  model: string;
  runtimeModel?: AgentModelId;
  reasoningEffort?: CodexReasoningEffort;
} {
  const model = input.model.trim().toLowerCase();
  if (!isGoatWorkflowModelToken(model)) return { model };
  const option = GOAT_WORKFLOW_MODEL_OPTIONS.find((candidate) => candidate.token === model);
  if (!option || !isGoatWorkflowCloudRuntime(option.engine)) return { model };

  const runtimeModel = normalizeGoatWorkflowRuntimeModel(option.engine, input.runtimeModel);
  const reasoningEffort = normalizeGoatWorkflowReasoningEffort(
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

export function isGoatWorkflowCloudRuntime(
  engine: GoatHarnessEngine,
): engine is GoatWorkflowCloudRuntime {
  return engine === "codex" || engine === "claude_code";
}

export function goatWorkflowCloudModelOptions(
  engine: GoatWorkflowCloudRuntime,
): readonly GoatWorkflowCloudModelOption[] {
  return engine === "codex"
    ? GOAT_WORKFLOW_CODEX_MODEL_OPTIONS
    : GOAT_WORKFLOW_CLAUDE_CODE_MODEL_OPTIONS;
}

export function defaultGoatWorkflowRuntimeModel(engine: GoatWorkflowCloudRuntime): AgentModelId {
  const defaultOption = GOAT_WORKFLOW_MODEL_OPTIONS.find((option) => option.engine === engine);
  if (!defaultOption) {
    throw new Error(`Workflow cloud runtime "${engine}" is missing from the workflow catalog.`);
  }
  return defaultOption.id;
}

export function isGoatWorkflowRuntimeModel(
  engine: GoatWorkflowCloudRuntime,
  value: string,
): value is AgentModelId {
  return engine === "codex" ? isCodexModelId(value) : isClaudeCodeModelId(value);
}

export function goatWorkflowRuntimeModelSupportsReasoningEffort(
  engine: GoatWorkflowCloudRuntime,
  model: string,
): boolean {
  return engine === "codex" || claudeCodeModelSupportsReasoningEffort(model);
}

export function normalizeGoatWorkflowRuntimeModel(
  engine: GoatWorkflowCloudRuntime,
  value: unknown,
): AgentModelId {
  const model = typeof value === "string" ? value.trim() : "";
  return model && isGoatWorkflowRuntimeModel(engine, model)
    ? model
    : defaultGoatWorkflowRuntimeModel(engine);
}

export function normalizeGoatWorkflowReasoningEffort(
  engine: GoatWorkflowCloudRuntime,
  runtimeModel: string,
  value: unknown,
): CodexReasoningEffort | undefined {
  if (!goatWorkflowRuntimeModelSupportsReasoningEffort(engine, runtimeModel)) return undefined;
  return typeof value === "string" && isCodexReasoningEffort(value)
    ? value
    : DEFAULT_GOAT_WORKFLOW_REASONING_EFFORT;
}

function requireAgentModelDefinition(modelId: AgentModelId) {
  const model = getAgentModelDefinition(modelId);
  if (!model) {
    throw new Error(`Workflow model "${modelId}" is missing from the agent model catalog.`);
  }
  return model;
}
