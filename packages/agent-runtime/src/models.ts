import type { AgentModelId } from "@opencompany/db/schema";

export type ModelProviderOptions = Record<string, Record<string, boolean | number | string | null>>;

export type AgentModelDefinition = {
  id: AgentModelId;
  type: "model";
  label: string;
  description: string;
  category: "Fast" | "Deep";
  supportsReasoning: boolean;
  reasoning?: {
    providerOptions: ModelProviderOptions;
    exposeSummary: boolean;
  };
};

export const AGENT_MODEL_CATALOG: AgentModelDefinition[] = [
  {
    id: "openai/gpt-5.4-mini",
    type: "model",
    label: "GPT 5.4 Mini",
    description: "Fast GPT model with light thinking for everyday agent work.",
    category: "Fast",
    supportsReasoning: true,
    reasoning: {
      providerOptions: {
        openai: {
          reasoningEffort: "low",
          reasoningSummary: "concise",
        },
      },
      exposeSummary: true,
    },
  },
  {
    id: "openai/gpt-5.4",
    type: "model",
    label: "GPT 5.4",
    description: "Deep thinking GPT model for complex reasoning and long workflows.",
    category: "Deep",
    supportsReasoning: true,
    reasoning: {
      providerOptions: {
        openai: {
          reasoningEffort: "medium",
          reasoningSummary: "concise",
        },
      },
      exposeSummary: true,
    },
  },
  {
    id: "anthropic/claude-haiku-4.5",
    type: "model",
    label: "Claude Haiku 4.5",
    description: "Fast Claude model for lightweight agent workloads.",
    category: "Fast",
    supportsReasoning: false,
  },
  {
    id: "anthropic/claude-sonnet-4.6",
    type: "model",
    label: "Claude Sonnet 4.6",
    description: "Deep Claude model for coding and professional work.",
    category: "Deep",
    supportsReasoning: true,
    reasoning: {
      providerOptions: {
        anthropic: {
          thinkingBudget: 0.001,
        },
      },
      exposeSummary: false,
    },
  },
];

const MODEL_BY_ID = new Map(AGENT_MODEL_CATALOG.map((model) => [model.id, model]));

export function getAgentModelDefinition(id: string) {
  return MODEL_BY_ID.get(id as AgentModelId) ?? null;
}

export function getAgentModelRuntimeOptions(id: string) {
  const model = getAgentModelDefinition(id);
  if (!model?.reasoning) {
    return {
      supportsReasoning: Boolean(model?.supportsReasoning),
      providerOptions: undefined,
      exposeReasoningSummary: false,
    };
  }

  return {
    supportsReasoning: true,
    providerOptions: copyProviderOptions(model.reasoning.providerOptions),
    exposeReasoningSummary: model.reasoning.exposeSummary,
  };
}

function copyProviderOptions(options: ModelProviderOptions): ModelProviderOptions {
  return Object.fromEntries(
    Object.entries(options).map(([provider, values]) => [provider, { ...values }]),
  );
}
