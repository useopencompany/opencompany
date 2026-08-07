import {
  CLAUDE_CODE_AGENT_MODEL_IDS,
  CODEX_AGENT_MODEL_IDS,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  getAgentModelDefinition,
} from "@opencompany/agent-runtime";
import type { AgentModelId } from "@opencompany/agent-runtime/types";

const MODEL_IDS = [
  "anthropic/claude-sonnet-5",
  "anthropic/claude-opus-4.8",
  "openai/gpt-5.5",
  "deepseek/deepseek-v4-pro",
  "moonshotai/kimi-k3",
  "moonshotai/kimi-k2.6",
  "zai/glm-5.2",
] as const satisfies readonly AgentModelId[];

const MODEL_ID_SET = new Set<string>(MODEL_IDS);

export const MODELS = MODEL_IDS.map(requireAgentModelDefinition);

export const CODEX_MODELS = CODEX_AGENT_MODEL_IDS.map(requireAgentModelDefinition);

export const CLAUDE_CODE_MODELS = CLAUDE_CODE_AGENT_MODEL_IDS.map(requireAgentModelDefinition);

export type ModelOption = (typeof MODELS)[number];

export const DEFAULT_MODEL: AgentModelId = "moonshotai/kimi-k3";

export function normalizeModel(value: unknown): AgentModelId {
  if (typeof value === "string" && MODEL_ID_SET.has(value)) {
    return value as AgentModelId;
  }
  return DEFAULT_MODEL;
}

export function modelContextWindowTokens(modelId: string): number {
  return getAgentModelDefinition(modelId)?.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
}

function requireAgentModelDefinition(modelId: AgentModelId) {
  const model = getAgentModelDefinition(modelId);
  if (!model) {
    throw new Error(`Goat model "${modelId}" is missing from the agent model catalog.`);
  }
  return model;
}
