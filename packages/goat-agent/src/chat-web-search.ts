import { executeExaSearchRequest } from "@opencompany/agent-runtime";
import type { WebSearchToolInput, WebSearchToolOutput } from "./chat-ui";

// Pure Exa call for the chat web_search tool, shared by the streaming chat
// route (which wraps it in telemetry) and headless surfaces like the Slack bot.
export async function executeGoatChatExaSearch(input: {
  toolInput: WebSearchToolInput;
  apiKey: string;
  signal: AbortSignal;
  currentDate: Date;
}): Promise<Extract<WebSearchToolOutput, { ok: true }>> {
  const startPublishedDate = recencyStartPublishedDate(
    input.toolInput.recencyDays,
    input.currentDate,
  );
  const search = await executeExaSearchRequest({
    apiKey: input.apiKey,
    args: {
      query: input.toolInput.query,
      type: "fast",
      numResults: 5,
      ...(startPublishedDate ? { startPublishedDate } : {}),
    },
    signal: input.signal,
    defaults: { type: "fast", numResults: 5 },
  });

  return {
    ok: true,
    query: input.toolInput.query,
    searchedAt: input.currentDate.toISOString(),
    results: search.output.results.map((result) => ({
      ...(result.title ? { title: result.title } : {}),
      ...(result.url ? { url: result.url } : {}),
      ...(result.publishedDate ? { publishedDate: result.publishedDate } : {}),
      ...(result.author ? { author: result.author } : {}),
      highlights: result.highlights ?? [],
    })),
    ...(search.output.requestId ? { requestId: search.output.requestId } : {}),
    costUsdMicros: search.usage.costUsdMicros,
  };
}

function recencyStartPublishedDate(recencyDays: WebSearchToolInput["recencyDays"], now: Date) {
  if (recencyDays !== 7 && recencyDays !== 30 && recencyDays !== 90) return undefined;
  return new Date(now.getTime() - recencyDays * 24 * 60 * 60 * 1000).toISOString();
}
