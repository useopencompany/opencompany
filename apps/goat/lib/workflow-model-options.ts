import { type AgentModelDefinition, getAgentModelDefinition } from "@opencompany/agent-runtime";
import type { AgentModelId } from "@opencompany/agent-runtime/types";
import type { GoatHarnessEngine } from "@opencompany/db/goat-schema";

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

export const GOAT_WORKFLOW_MODEL_OPTIONS: readonly GoatWorkflowModelOption[] =
  GOAT_WORKFLOW_MODEL_CONFIG.map(({ modelId, ...option }) => ({
    ...requireAgentModelDefinition(modelId),
    ...option,
  }));

export const DEFAULT_GOAT_WORKFLOW_MODEL_TOKEN: GoatWorkflowModelToken = "kimi-k2.6";

const GOAT_WORKFLOW_MODEL_TOKEN_SET = new Set<string>(
  GOAT_WORKFLOW_MODEL_OPTIONS.map((option) => option.token),
);

export function isGoatWorkflowModelToken(value: unknown): value is GoatWorkflowModelToken {
  return typeof value === "string" && GOAT_WORKFLOW_MODEL_TOKEN_SET.has(value);
}

export function goatWorkflowModelSelection(token: GoatWorkflowModelToken): {
  engine: GoatHarnessEngine;
  model: AgentModelId;
} {
  const option = GOAT_WORKFLOW_MODEL_OPTIONS.find((candidate) => candidate.token === token);
  if (!option) {
    throw new Error(`Workflow model token "${token}" is missing from the workflow catalog.`);
  }
  return { engine: option.engine, model: option.id };
}

function requireAgentModelDefinition(modelId: AgentModelId) {
  const model = getAgentModelDefinition(modelId);
  if (!model) {
    throw new Error(`Workflow model "${modelId}" is missing from the agent model catalog.`);
  }
  return model;
}
