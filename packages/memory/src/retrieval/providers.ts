import {
  createGateway,
  type Gateway,
  type GatewayUsageEntry,
  parseJsonStringArray,
} from "./gateway";
import type { RetrievalProviders } from "./index";

// Build the model-backed retrieval stages from the environment. When VERCEL_AI_GATEWAY_API_KEY
// is present, the full hybrid stack (query expansion + vector + rerank) engages; otherwise this
// returns {} and `query` runs the offline lexical pipeline. The key is read from the CLI's own
// environment — the runner injects it only into this subprocess (see apps/runner/src/memory-tool.ts).
// `onUsage` (optional) receives each Gateway call's token/cost footprint so the caller can report
// it back to the runner for session billing.
export async function loadProviders(
  env: NodeJS.ProcessEnv = process.env,
  onUsage?: (entry: GatewayUsageEntry) => void,
): Promise<RetrievalProviders> {
  const apiKey = env.VERCEL_AI_GATEWAY_API_KEY;
  if (!apiKey) return {};

  const gateway = createGateway({
    apiKey,
    ...(env.MEMORY_EMBEDDING_MODEL ? { embeddingModel: env.MEMORY_EMBEDDING_MODEL } : {}),
    ...(env.MEMORY_RETRIEVAL_MODEL ? { chatModel: env.MEMORY_RETRIEVAL_MODEL } : {}),
    ...(onUsage ? { onUsage } : {}),
  });

  return buildProviders(gateway);
}

// Pure construction of the providers from a gateway — exported so tests can inject a fake.
export function buildProviders(gateway: Gateway): RetrievalProviders {
  return {
    async expand(query) {
      const prompt = `Rewrite this search query as 3 short alternative phrasings (synonyms, expansions, related terms) to improve retrieval. Return ONLY a JSON array of strings.\n\nQuery: ${query}`;
      return parseJsonStringArray(await gateway.chat(prompt)).slice(0, 3);
    },

    embedTexts(texts) {
      return gateway.embed(texts);
    },

    async rerank(query, candidates) {
      const list = candidates.map((c, i) => `${i + 1}. [${c.id}] ${c.text}`).join("\n");
      const prompt = `Rank these memory records by how well they answer the query. Return ONLY a JSON array of their ids, most relevant first.\n\nQuery: ${query}\n\nRecords:\n${list}`;
      const ranked = parseJsonStringArray(await gateway.chat(prompt));
      const known = new Set(candidates.map((c) => c.id));
      return ranked.filter((id) => known.has(id));
    },
  };
}
