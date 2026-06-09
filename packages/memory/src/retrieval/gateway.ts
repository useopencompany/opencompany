// Thin client for the Vercel AI Gateway (OpenAI-compatible REST). Used by the model-backed
// retrieval stages: embeddings (vector search), and chat (query expansion + reranking). `fetch`
// is injectable so the providers can be unit-tested without network access.

const GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";

export type FetchLike = typeof fetch;

// One model-backed call's token + cost footprint. Emitted via `onUsage` so the caller (the CLI,
// when invoked by the runner with --report-usage) can surface it for session billing. `costUsd`
// is the Gateway-reported dollar cost when present; otherwise null and the consumer prices it
// from the token counts.
export type GatewayUsageEntry = {
  model: string;
  operation: "embeddings" | "chat";
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number | null;
};

export type GatewayConfig = {
  apiKey: string;
  baseUrl?: string;
  embeddingModel?: string;
  chatModel?: string;
  fetch?: FetchLike;
  // Invoked once per Gateway call with that call's usage. Best-effort: never throws into the
  // request path, and a call with no parseable usage still reports zeroed counts so the runner
  // sees that a billable request happened.
  onUsage?: (entry: GatewayUsageEntry) => void;
};

export type Gateway = {
  embed(texts: string[]): Promise<number[][]>;
  chat(prompt: string): Promise<string>;
};

export function createGateway(config: GatewayConfig): Gateway {
  const baseUrl = config.baseUrl ?? GATEWAY_BASE_URL;
  const embeddingModel = config.embeddingModel ?? "openai/text-embedding-3-small";
  const chatModel = config.chatModel ?? "openai/gpt-5.4-nano";
  const doFetch = config.fetch ?? fetch;
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${config.apiKey}`,
  };

  const report = (model: string, operation: GatewayUsageEntry["operation"], body: unknown) => {
    if (!config.onUsage) return;
    try {
      config.onUsage(parseUsage(model, operation, body));
    } catch {
      // Usage reporting must never break retrieval.
    }
  };

  return {
    async embed(texts) {
      if (texts.length === 0) return [];
      const response = await doFetch(`${baseUrl}/embeddings`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: embeddingModel, input: texts }),
      });
      if (!response.ok) throw new Error(`Gateway embeddings failed: ${response.status}`);
      const json = (await response.json()) as {
        data?: Array<{ embedding: number[] }>;
        usage?: unknown;
        cost?: unknown;
      };
      report(embeddingModel, "embeddings", json);
      return (json.data ?? []).map((item) => item.embedding);
    },

    async chat(prompt) {
      const response = await doFetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: chatModel,
          messages: [{ role: "user", content: prompt }],
          temperature: 0,
        }),
      });
      if (!response.ok) throw new Error(`Gateway chat failed: ${response.status}`);
      const json = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: unknown;
        cost?: unknown;
      };
      report(chatModel, "chat", json);
      return json.choices?.[0]?.message?.content ?? "";
    },
  };
}

// Pull token counts (and, when the Gateway reports it, dollar cost) out of an OpenAI-compatible
// response body. The Gateway returns standard `usage` token fields; cost, when present, may live
// at `usage.cost` or top-level `cost`. Missing fields default to 0 / null.
function parseUsage(
  model: string,
  operation: GatewayUsageEntry["operation"],
  body: unknown,
): GatewayUsageEntry {
  const record = isRecord(body) ? body : {};
  const usage = isRecord(record.usage) ? record.usage : {};
  const inputTokens = numberOr(usage.prompt_tokens ?? usage.input_tokens, 0);
  const outputTokens = numberOr(usage.completion_tokens ?? usage.output_tokens, 0);
  const totalTokens = numberOr(usage.total_tokens, inputTokens + outputTokens);
  const costUsd = firstNumber(usage.cost, usage.cost_usd, record.cost);
  return { model, operation, inputTokens, outputTokens, totalTokens, costUsd };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

// Best-effort JSON-array extraction from a model response (handles ```json fences and prose).
export function parseJsonStringArray(text: string): string[] {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}
