// Thin client for the Vercel AI Gateway (OpenAI-compatible REST). Used by the model-backed
// retrieval stages: embeddings (vector search), and chat (query expansion + reranking). `fetch`
// is injectable so the providers can be unit-tested without network access.

const GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";

export type FetchLike = typeof fetch;

export type GatewayConfig = {
  apiKey: string;
  baseUrl?: string;
  embeddingModel?: string;
  chatModel?: string;
  fetch?: FetchLike;
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

  return {
    async embed(texts) {
      if (texts.length === 0) return [];
      const response = await doFetch(`${baseUrl}/embeddings`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: embeddingModel, input: texts }),
      });
      if (!response.ok) throw new Error(`Gateway embeddings failed: ${response.status}`);
      const json = (await response.json()) as { data?: Array<{ embedding: number[] }> };
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
      };
      return json.choices?.[0]?.message?.content ?? "";
    },
  };
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
