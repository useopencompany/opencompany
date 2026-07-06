import {
  createGateway,
  type Gateway,
  type GoatBrainUsageEntry,
  parseJsonStringArray,
} from "./gateway";
import type { RetrievalProviders } from "./index";

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
    ...(env.GOAT_BRAIN_RETRIEVAL_MODEL ? { chatModel: env.GOAT_BRAIN_RETRIEVAL_MODEL } : {}),
    ...(onUsage ? { onUsage } : {}),
  });
  return {
    ...buildProviders(gateway),
    embeddingCacheKey: `${baseUrl ?? "vercel-ai-gateway"}:${embeddingModel}`,
  };
}

export function buildProviders(gateway: Gateway): RetrievalProviders {
  return {
    async expand(query) {
      const prompt = `Rewrite this search query as 3 short alternative phrasings to improve retrieval. Return only a JSON array of strings.\n\nQuery: ${query}`;
      return parseJsonStringArray(await gateway.chat(prompt)).slice(0, 3);
    },
    embedTexts(texts) {
      return gateway.embed(texts);
    },
    async rerank(query, candidates) {
      const list = candidates
        .map((candidate, i) => `${i + 1}. [${candidate.id}] ${candidate.text}`)
        .join("\n");
      const prompt = `Rank these brain documents by how well they answer the query. Return only a JSON array of their ids, most relevant first.\n\nQuery: ${query}\n\nDocuments:\n${list}`;
      const ranked = parseJsonStringArray(await gateway.chat(prompt));
      const known = new Set(candidates.map((candidate) => candidate.id));
      return ranked.filter((id) => known.has(id));
    },
  };
}
