import { type BrainUsageEntry, createGateway, type Gateway } from "./gateway";
import type { RetrievalProviders } from "./index";

// Retrieval's only model dependency is embeddings. Query expansion and LLM reranking were removed
// on purpose: the consumer is an agent in a tool loop — it reformulates queries and reranks by
// reading snippets — and the two chat calls added seconds of latency for marginal precision. If
// evals ever show a precision gap, a dedicated reranker model slots in behind this same seam.
export async function loadProviders(
  env: NodeJS.ProcessEnv = process.env,
  onUsage?: (entry: BrainUsageEntry) => void,
): Promise<RetrievalProviders> {
  const apiKey = env.VERCEL_AI_GATEWAY_API_KEY;
  if (!apiKey) return {};
  const baseUrl = env.BRAIN_GATEWAY_BASE_URL;
  const embeddingModel = env.BRAIN_EMBEDDING_MODEL ?? "openai/text-embedding-3-small";
  const reporting = gatewayReportingFromEnv(env);

  const gateway = createGateway({
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
    embeddingModel,
    ...(reporting ? { reporting } : {}),
    ...(onUsage ? { onUsage } : {}),
  });
  return {
    ...buildProviders(gateway),
    embeddingCacheKey: `${baseUrl ?? "vercel-ai-gateway"}:${embeddingModel}`,
  };
}

function gatewayReportingFromEnv(env: NodeJS.ProcessEnv) {
  const user = env.GOAT_GATEWAY_REPORTING_USER?.trim();
  const tags = (env.GOAT_GATEWAY_REPORTING_TAGS ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  if (!user && tags.length === 0) return null;
  return {
    ...(user ? { user } : {}),
    ...(tags.length > 0 ? { tags } : {}),
  };
}

export function buildProviders(gateway: Gateway): RetrievalProviders {
  return {
    embedTexts(texts) {
      return gateway.embed(texts);
    },
  };
}
