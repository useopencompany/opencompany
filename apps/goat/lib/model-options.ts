import { AGENT_MODEL_CATALOG, DEFAULT_CONTEXT_WINDOW_TOKENS } from "@opencompany/agent-runtime";
import type { AgentModelId } from "@opencompany/agent-runtime/types";

const GOAT_MODEL_IDS = [
  "anthropic/claude-sonnet-5",
  "anthropic/claude-opus-4.8",
  "openai/gpt-5.5",
  "moonshotai/kimi-k2.6",
] as const satisfies readonly AgentModelId[];

const GOAT_MODEL_ID_SET = new Set<string>(GOAT_MODEL_IDS);

export const GOAT_MODELS = GOAT_MODEL_IDS.map((id) =>
  AGENT_MODEL_CATALOG.find((model) => model.id === id),
).filter((model): model is NonNullable<typeof model> => model !== undefined);

export type GoatModelOption = (typeof GOAT_MODELS)[number];

export const DEFAULT_GOAT_MODEL: AgentModelId = "anthropic/claude-sonnet-5";

export function normalizeGoatModel(value: unknown): AgentModelId {
  if (typeof value === "string" && GOAT_MODEL_ID_SET.has(value)) {
    return value as AgentModelId;
  }
  return DEFAULT_GOAT_MODEL;
}

export function goatModelContextWindowTokens(modelId: string): number {
  return (
    AGENT_MODEL_CATALOG.find((model) => model.id === modelId)?.contextWindowTokens ??
    DEFAULT_CONTEXT_WINDOW_TOKENS
  );
}
