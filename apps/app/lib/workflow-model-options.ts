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
import type { HarnessEngine } from "@opencompany/db/schema";

// The token is stored on a workflow step and can also be used as an inline
// `@<token>` mention. Model metadata comes from the shared agent catalog.
const WORKFLOW_MODEL_CONFIG = [
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
  engine: HarnessEngine;
  modelId: AgentModelId;
  label?: string;
  hint: string;
}[];

export type WorkflowModelToken = (typeof WORKFLOW_MODEL_CONFIG)[number]["token"];

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
  ({ modelId, ...option }) => ({
    ...requireAgentModelDefinition(modelId),
    ...option,
  }),
);

export const DEFAULT_WORKFLOW_MODEL_TOKEN: WorkflowModelToken = "kimi-k2.6";
export const DEFAULT_WORKFLOW_REASONING_EFFORT: CodexReasoningEffort = "high";
export const WORKFLOW_REASONING_EFFORT_OPTIONS = CODEX_REASONING_EFFORTS;

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
  reasoningEffort?: CodexReasoningEffort;
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
  reasoningEffort?: CodexReasoningEffort;
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
): CodexReasoningEffort | undefined {
  if (!workflowRuntimeModelSupportsReasoningEffort(engine, runtimeModel)) return undefined;
  return typeof value === "string" && isCodexReasoningEffort(value)
    ? value
    : DEFAULT_WORKFLOW_REASONING_EFFORT;
}

function requireAgentModelDefinition(modelId: AgentModelId) {
  const model = getAgentModelDefinition(modelId);
  if (!model) {
    throw new Error(`Workflow model "${modelId}" is missing from the agent model catalog.`);
  }
  return model;
}
