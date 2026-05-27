import type { AgentModelId } from "./types";

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
    id: "openai/gpt-5.4-nano",
    type: "model",
    label: "GPT 5.4 Nano",
    description: "Lowest-cost GPT model for high-volume lightweight agent turns.",
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
  {
    id: "anthropic/claude-opus-4.7",
    type: "model",
    label: "Claude Opus 4.7",
    description: "Highest-capability Claude model for demanding agent workflows.",
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
  {
    id: "google/gemini-3-flash",
    type: "model",
    label: "Gemini 3 Flash",
    description: "Popular Gemini model with strong speed and long-context capacity.",
    category: "Fast",
    supportsReasoning: false,
  },
  {
    id: "google/gemini-3.1-flash-lite-preview",
    type: "model",
    label: "Gemini 3.1 Flash Lite Preview",
    description: "Very fast, low-cost Gemini model for simple high-volume tasks.",
    category: "Fast",
    supportsReasoning: false,
  },
  {
    id: "deepseek/deepseek-v4-flash",
    type: "model",
    label: "DeepSeek V4 Flash",
    description: "High-throughput DeepSeek model for cost-sensitive agent work.",
    category: "Fast",
    supportsReasoning: false,
  },
  {
    id: "mistral/mistral-medium-3.5",
    type: "model",
    label: "Mistral Medium Latest",
    description: "Popular Mistral model balancing quality, latency, and cost.",
    category: "Deep",
    supportsReasoning: false,
  },
  {
    id: "moonshotai/kimi-k2.6",
    type: "model",
    label: "Kimi K2.6",
    description: "Latest Kimi model for long-horizon coding and agent workflows.",
    category: "Deep",
    supportsReasoning: true,
  },
  {
    id: "zai/glm-5.1",
    type: "model",
    label: "GLM 5.1",
    description: "Latest GLM model for coding-heavy and agentic engineering tasks.",
    category: "Deep",
    supportsReasoning: true,
  },
  {
    id: "zai/glm-5-turbo",
    type: "model",
    label: "GLM 5 Turbo",
    description: "Faster GLM 5 variant for production agent workflows.",
    category: "Fast",
    supportsReasoning: true,
  },
  {
    id: "zai/glm-5v-turbo",
    type: "model",
    label: "GLM 5V Turbo",
    description: "Multimodal GLM 5 model tuned for visual coding and GUI tasks.",
    category: "Deep",
    supportsReasoning: true,
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
