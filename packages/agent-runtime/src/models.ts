import type { AgentModelId } from "./types";

export type ModelProviderOptions = Record<string, Record<string, boolean | number | string | null>>;
export type ReasoningExposure = "hidden" | "summary" | "raw";

// Glanceable decision signals surfaced in the model picker. Three ordinal tiers
// (1–3) per dimension — qualitative tiers stay accurate far longer than exact
// $/token or tokens/sec figures (which drift weekly) and read cleaner in a list.
export type ModelRatingTier = 1 | 2 | 3;
export type ModelRatings = {
  capability: ModelRatingTier; // 1 Basic · 2 Capable · 3 Frontier
  speed: ModelRatingTier; // 1 Slow · 2 Medium · 3 Fast
  cost: ModelRatingTier; // 1 $ · 2 $$ · 3 $$$ (higher = pricier)
};

export type AgentModelDefinition = {
  id: AgentModelId;
  type: "model";
  label: string;
  description: string;
  category: "Fast" | "Deep";
  supportsReasoning: boolean;
  ratings: ModelRatings;
  reasoning?: {
    providerOptions: ModelProviderOptions;
    exposure: ReasoningExposure;
  };
};

// Ratings were seeded from public data on 2026-06-03 (Artificial Analysis
// Intelligence Index, output tokens/sec; OpenRouter / provider output pricing)
// using these buckets. Keep new models consistent with them:
//   capability (AA index): <40 → 1 · 40–52 → 2 · ≥53 → 3 (flagships nudged up at borderlines)
//   speed (output tok/sec): <60 → 1 · 60–150 → 2 · >150 → 3
//   cost (output $/M tokens): ≤$2.50 → 1 · $2.51–$7.50 → 2 · >$7.50 → 3
// minimax/minimax-m3 and xai/grok-build-0.1 are estimates (no published
// benchmark yet) — revisit when Artificial Analysis lists them.
export const AGENT_MODEL_CATALOG: AgentModelDefinition[] = [
  {
    id: "openai/gpt-5.4-mini",
    type: "model",
    label: "GPT 5.4 Mini",
    description: "Fast GPT model with light thinking for everyday agent work.",
    category: "Fast",
    supportsReasoning: true,
    ratings: { capability: 2, speed: 3, cost: 2 },
    reasoning: {
      providerOptions: {
        openai: {
          reasoningEffort: "low",
          reasoningSummary: "concise",
        },
      },
      exposure: "summary",
    },
  },
  {
    id: "openai/gpt-5.4-nano",
    type: "model",
    label: "GPT 5.4 Nano",
    description: "Lowest-cost GPT model for high-volume lightweight agent turns.",
    category: "Fast",
    supportsReasoning: true,
    ratings: { capability: 1, speed: 3, cost: 1 },
    reasoning: {
      providerOptions: {
        openai: {
          reasoningEffort: "low",
          reasoningSummary: "concise",
        },
      },
      exposure: "summary",
    },
  },
  {
    id: "openai/gpt-5.4",
    type: "model",
    label: "GPT 5.4",
    description: "Deep thinking GPT model for complex reasoning and long workflows.",
    category: "Deep",
    supportsReasoning: true,
    ratings: { capability: 3, speed: 2, cost: 3 },
    reasoning: {
      providerOptions: {
        openai: {
          reasoningEffort: "medium",
          reasoningSummary: "concise",
        },
      },
      exposure: "summary",
    },
  },
  {
    id: "openai/gpt-5.2-codex",
    type: "model",
    label: "GPT 5.2 Codex",
    description: "OpenAI coding model optimized for long-horizon agentic engineering tasks.",
    category: "Deep",
    supportsReasoning: true,
    ratings: { capability: 3, speed: 2, cost: 3 },
    reasoning: {
      providerOptions: {
        openai: {
          reasoningEffort: "medium",
          reasoningSummary: "concise",
        },
      },
      exposure: "summary",
    },
  },
  {
    id: "anthropic/claude-haiku-4.5",
    type: "model",
    label: "Claude Haiku 4.5",
    description: "Fast Claude model for lightweight agent workloads.",
    category: "Fast",
    supportsReasoning: false,
    ratings: { capability: 2, speed: 2, cost: 2 },
  },
  {
    id: "anthropic/claude-sonnet-4.6",
    type: "model",
    label: "Claude Sonnet 4.6",
    description: "Deep Claude model for coding and professional work.",
    category: "Deep",
    supportsReasoning: true,
    ratings: { capability: 3, speed: 1, cost: 3 },
    reasoning: {
      providerOptions: {
        anthropic: {
          thinkingBudget: 0.001,
        },
      },
      exposure: "hidden",
    },
  },
  {
    id: "anthropic/claude-opus-4.7",
    type: "model",
    label: "Claude Opus 4.7",
    description: "Highest-capability Claude model for demanding agent workflows.",
    category: "Deep",
    supportsReasoning: true,
    ratings: { capability: 3, speed: 1, cost: 3 },
    reasoning: {
      providerOptions: {
        anthropic: {
          thinkingBudget: 0.001,
        },
      },
      exposure: "hidden",
    },
  },
  {
    id: "anthropic/claude-opus-4.8",
    type: "model",
    label: "Claude Opus 4.8",
    description: "Latest highest-capability Claude model for demanding agent workflows.",
    category: "Deep",
    supportsReasoning: true,
    ratings: { capability: 3, speed: 2, cost: 3 },
    reasoning: {
      providerOptions: {
        anthropic: {
          thinkingBudget: 0.001,
        },
      },
      exposure: "hidden",
    },
  },
  {
    id: "google/gemini-3-flash",
    type: "model",
    label: "Gemini 3 Flash",
    description: "Popular Gemini model with strong speed and long-context capacity.",
    category: "Fast",
    supportsReasoning: false,
    ratings: { capability: 2, speed: 3, cost: 2 },
  },
  {
    id: "google/gemini-3.1-flash-lite-preview",
    type: "model",
    label: "Gemini 3.1 Flash Lite Preview",
    description: "Very fast, low-cost Gemini model for simple high-volume tasks.",
    category: "Fast",
    supportsReasoning: false,
    ratings: { capability: 1, speed: 3, cost: 1 },
  },
  {
    id: "deepseek/deepseek-v4-flash",
    type: "model",
    label: "DeepSeek V4 Flash",
    description: "High-throughput DeepSeek model for cost-sensitive agent work.",
    category: "Fast",
    supportsReasoning: false,
    ratings: { capability: 2, speed: 2, cost: 1 },
  },
  {
    id: "mistral/mistral-medium-3.5",
    type: "model",
    label: "Mistral Medium Latest",
    description: "Popular Mistral model balancing quality, latency, and cost.",
    category: "Deep",
    supportsReasoning: false,
    ratings: { capability: 2, speed: 3, cost: 2 },
  },
  {
    id: "minimax/minimax-m3",
    type: "model",
    label: "MiniMax M3",
    description:
      "Latest MiniMax model with 1M context, multimodality, and agentic coding strength.",
    category: "Deep",
    supportsReasoning: true,
    ratings: { capability: 3, speed: 3, cost: 1 },
  },
  {
    id: "minimax/minimax-m2.7",
    type: "model",
    label: "MiniMax M2.7",
    description: "High-capability MiniMax model for end-to-end software engineering agents.",
    category: "Deep",
    supportsReasoning: true,
    ratings: { capability: 2, speed: 3, cost: 1 },
  },
  {
    id: "minimax/minimax-m2.7-highspeed",
    type: "model",
    label: "MiniMax M2.7 High Speed",
    description: "Throughput-optimized MiniMax M2.7 variant for latency-sensitive agent work.",
    category: "Fast",
    supportsReasoning: true,
    ratings: { capability: 2, speed: 3, cost: 1 },
  },
  {
    id: "minimax/minimax-m2.5",
    type: "model",
    label: "MiniMax M2.5",
    description: "MiniMax agentic model for full-stack development and multi-file code work.",
    category: "Deep",
    supportsReasoning: true,
    ratings: { capability: 2, speed: 3, cost: 1 },
  },
  {
    id: "minimax/minimax-m2.5-highspeed",
    type: "model",
    label: "MiniMax M2.5 High Speed",
    description: "Fast MiniMax M2.5 variant for responsive coding and agent workflows.",
    category: "Fast",
    supportsReasoning: true,
    ratings: { capability: 2, speed: 3, cost: 1 },
  },
  {
    id: "minimax/minimax-m2.1",
    type: "model",
    label: "MiniMax M2.1",
    description: "MiniMax model for reliable agentic coding with interleaved thinking.",
    category: "Deep",
    supportsReasoning: true,
    ratings: { capability: 2, speed: 3, cost: 1 },
  },
  {
    id: "minimax/minimax-m2.1-lightning",
    type: "model",
    label: "MiniMax M2.1 Lightning",
    description: "Speed-optimized MiniMax M2.1 variant for fast coding assistance.",
    category: "Fast",
    supportsReasoning: true,
    ratings: { capability: 2, speed: 3, cost: 1 },
  },
  {
    id: "minimax/minimax-m2",
    type: "model",
    label: "MiniMax M2",
    description: "Open-weight MiniMax MoE model built for coding and agentic tasks.",
    category: "Deep",
    supportsReasoning: true,
    ratings: { capability: 1, speed: 2, cost: 1 },
  },
  {
    id: "moonshotai/kimi-k2.6",
    type: "model",
    label: "Kimi K2.6",
    description: "Latest Kimi model for long-horizon coding and agent workflows.",
    category: "Deep",
    supportsReasoning: true,
    ratings: { capability: 3, speed: 1, cost: 2 },
    reasoning: {
      providerOptions: {},
      exposure: "raw",
    },
  },
  {
    id: "moonshotai/kimi-k2.5",
    type: "model",
    label: "Kimi K2.5",
    description: "Kimi multimodal model for agent tasks, coding, and visual understanding.",
    category: "Deep",
    supportsReasoning: true,
    ratings: { capability: 2, speed: 1, cost: 1 },
    reasoning: {
      providerOptions: {},
      exposure: "raw",
    },
  },
  {
    id: "moonshotai/kimi-k2-thinking",
    type: "model",
    label: "Kimi K2 Thinking",
    description: "Kimi reasoning model for long tool-call chains and explicit deliberation.",
    category: "Deep",
    supportsReasoning: true,
    ratings: { capability: 3, speed: 1, cost: 2 },
    reasoning: {
      providerOptions: {},
      exposure: "raw",
    },
  },
  {
    id: "moonshotai/kimi-k2-thinking-turbo",
    type: "model",
    label: "Kimi K2 Thinking Turbo",
    description: "Faster Kimi reasoning variant for interactive agent workflows.",
    category: "Fast",
    supportsReasoning: true,
    ratings: { capability: 3, speed: 2, cost: 2 },
    reasoning: {
      providerOptions: {},
      exposure: "raw",
    },
  },
  {
    id: "moonshotai/kimi-k2-turbo",
    type: "model",
    label: "Kimi K2 Turbo",
    description: "Speed-optimized Kimi K2 variant for latency-sensitive tool use.",
    category: "Fast",
    supportsReasoning: false,
    ratings: { capability: 2, speed: 2, cost: 3 },
  },
  {
    id: "moonshotai/kimi-k2",
    type: "model",
    label: "Kimi K2",
    description: "Kimi K2 instruct model for broad coding and agentic pipelines.",
    category: "Deep",
    supportsReasoning: false,
    ratings: { capability: 2, speed: 1, cost: 1 },
  },
  {
    id: "xai/grok-4.3",
    type: "model",
    label: "Grok 4.3",
    description: "xAI reasoning model with 1M context, tool use, vision, and web search support.",
    category: "Deep",
    supportsReasoning: true,
    ratings: { capability: 3, speed: 2, cost: 1 },
  },
  {
    id: "xai/grok-4.20-reasoning",
    type: "model",
    label: "Grok 4.20 Reasoning",
    description: "Long-context Grok reasoning model for agentic workflows and research.",
    category: "Deep",
    supportsReasoning: true,
    ratings: { capability: 2, speed: 3, cost: 1 },
  },
  {
    id: "xai/grok-4.20-non-reasoning",
    type: "model",
    label: "Grok 4.20 Non-Reasoning",
    description: "Long-context Grok model optimized for direct answers and tool calling.",
    category: "Deep",
    supportsReasoning: false,
    ratings: { capability: 2, speed: 3, cost: 1 },
  },
  {
    id: "xai/grok-4.1-fast-reasoning",
    type: "model",
    label: "Grok 4.1 Fast Reasoning",
    description: "Fast, low-cost Grok reasoning model with 1M context.",
    category: "Fast",
    supportsReasoning: true,
    ratings: { capability: 2, speed: 2, cost: 1 },
  },
  {
    id: "xai/grok-4.1-fast-non-reasoning",
    type: "model",
    label: "Grok 4.1 Fast Non-Reasoning",
    description: "Fast, low-cost Grok model for direct tool-using agent turns.",
    category: "Fast",
    supportsReasoning: false,
    ratings: { capability: 1, speed: 3, cost: 1 },
  },
  {
    id: "xai/grok-build-0.1",
    type: "model",
    label: "Grok Build 0.1",
    description: "xAI coding model trained for fast agentic software development.",
    category: "Fast",
    supportsReasoning: true,
    ratings: { capability: 2, speed: 3, cost: 1 },
  },
  {
    id: "zai/glm-5.1",
    type: "model",
    label: "GLM 5.1",
    description: "Latest GLM model for coding-heavy and agentic engineering tasks.",
    category: "Deep",
    supportsReasoning: true,
    ratings: { capability: 2, speed: 2, cost: 2 },
  },
  {
    id: "zai/glm-5-turbo",
    type: "model",
    label: "GLM 5 Turbo",
    description: "Faster GLM 5 variant for production agent workflows.",
    category: "Fast",
    supportsReasoning: true,
    ratings: { capability: 2, speed: 2, cost: 2 },
  },
  {
    id: "zai/glm-5v-turbo",
    type: "model",
    label: "GLM 5V Turbo",
    description: "Multimodal GLM 5 model tuned for visual coding and GUI tasks.",
    category: "Deep",
    supportsReasoning: true,
    ratings: { capability: 2, speed: 2, cost: 2 },
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
      reasoningExposure: "hidden" as const,
    };
  }

  const providerOptions = copyProviderOptions(model.reasoning.providerOptions);
  return {
    supportsReasoning: true,
    ...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
    reasoningExposure: model.reasoning.exposure,
  };
}

function copyProviderOptions(options: ModelProviderOptions): ModelProviderOptions {
  return Object.fromEntries(
    Object.entries(options).map(([provider, values]) => [provider, { ...values }]),
  );
}
