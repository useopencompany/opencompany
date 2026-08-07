const GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";

export type FetchLike = typeof fetch;

export type BrainUsageEntry = {
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
  timeoutMs?: number;
  fetch?: FetchLike;
  onUsage?: (entry: BrainUsageEntry) => void;
  reporting?: {
    user?: string;
    tags?: readonly string[];
  };
};

export type Gateway = {
  embed(texts: string[]): Promise<number[][]>;
  chat(prompt: string): Promise<string>;
};

export function createGateway(config: GatewayConfig): Gateway {
  const baseUrl = config.baseUrl ?? GATEWAY_BASE_URL;
  const embeddingModel = config.embeddingModel ?? "openai/text-embedding-3-small";
  const chatModel = config.chatModel ?? "openai/gpt-5.4-nano";
  const timeoutMs = config.timeoutMs ?? 30_000;
  const doFetch = config.fetch ?? fetch;
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${config.apiKey}`,
    ...reportingHeaders(config.reporting),
  };

  const report = (model: string, operation: BrainUsageEntry["operation"], body: unknown) => {
    if (!config.onUsage) return;
    try {
      config.onUsage(parseUsage(model, operation, body));
    } catch {
      // Usage reporting must not affect retrieval.
    }
  };

  return {
    async embed(texts) {
      if (texts.length === 0) return [];
      const response = await fetchWithTimeout(
        doFetch,
        `${baseUrl}/embeddings`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ model: embeddingModel, input: texts }),
        },
        timeoutMs,
        "embeddings",
      );
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
      const response = await fetchWithTimeout(
        doFetch,
        `${baseUrl}/chat/completions`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: chatModel,
            messages: [{ role: "user", content: prompt }],
            temperature: 0,
          }),
        },
        timeoutMs,
        "chat",
      );
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

async function fetchWithTimeout(
  doFetch: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  operation: BrainUsageEntry["operation"],
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await doFetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error(`Gateway ${operation} timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

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

function reportingHeaders(reporting: GatewayConfig["reporting"]): Record<string, string> {
  return {
    ...(reporting?.user ? { "ai-reporting-user": reporting.user } : {}),
    ...(reporting?.tags && reporting.tags.length > 0
      ? { "ai-reporting-tags": reporting.tags.join(",") }
      : {}),
  };
}

function parseUsage(
  model: string,
  operation: BrainUsageEntry["operation"],
  body: unknown,
): BrainUsageEntry {
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

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : Boolean(
        error && typeof error === "object" && (error as { name?: string }).name === "AbortError",
      );
}
