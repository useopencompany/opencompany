import { createGateway, type Gateway, type GoatBrainUsageEntry } from "./gateway";
import type { RetrievalProviders } from "./index";

// Retrieval's only model dependency is embeddings. Query expansion and LLM reranking were removed
// on purpose: the consumer is an agent in a tool loop — it reformulates queries and reranks by
// reading snippets — and the two chat calls added seconds of latency for marginal precision. If
// evals ever show a precision gap, a dedicated reranker model slots in behind this same seam.
export async function loadProviders(
  env: NodeJS.ProcessEnv = process.env,
  onUsage?: (entry: GoatBrainUsageEntry) => void,
): Promise<RetrievalProviders> {
  const apiKey = env.VERCEL_AI_GATEWAY_API_KEY;
  if (!apiKey) return {};
  const baseUrl = env.GOAT_BRAIN_GATEWAY_BASE_URL;
  const embeddingModel = env.GOAT_BRAIN_EMBEDDING_MODEL ?? "openai/text-embedding-3-small";

  const gateway = createGateway({
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
    embeddingModel,
    ...(onUsage ? { onUsage } : {}),
  });
  return {
    ...buildProviders(gateway),
    embeddingCacheKey: `${baseUrl ?? "vercel-ai-gateway"}:${embeddingModel}`,
  };
}

export function buildProviders(gateway: Gateway): RetrievalProviders {
  return {
    embedTexts(texts) {
      return gateway.embed(texts);
    },
  };
}
