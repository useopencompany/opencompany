import { describe, expect, it } from "vitest";
import { createGateway, type FetchLike } from "./gateway";

describe("goat brain retrieval gateway", () => {
  it("sends Gateway reporting headers for embeddings and chat", async () => {
    const requests: Array<{ url: string; headers: Headers }> = [];
    const gateway = createGateway({
      apiKey: "test",
      reporting: {
        user: "goat-user",
        tags: ["app:goat", "feature:brain-query"],
      },
      fetch: async (url, init) => {
        requests.push({ url: String(url), headers: new Headers(init?.headers) });
        return Response.json(
          String(url).endsWith("/embeddings")
            ? { data: [{ embedding: [0.1, 0.2] }], usage: { prompt_tokens: 1 } }
            : { choices: [{ message: { content: "ok" } }], usage: { completion_tokens: 1 } },
        );
      },
    });

    await gateway.embed(["hello"]);
    await gateway.chat("hello");

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.headers.get("ai-reporting-user")).toBe("goat-user");
      expect(request.headers.get("ai-reporting-tags")).toBe("app:goat,feature:brain-query");
    }
  });

  it("times out stalled embedding and chat requests", async () => {
    const gateway = createGateway({
      apiKey: "test",
      timeoutMs: 5,
      fetch: stalledFetch,
    });

    await expect(gateway.embed(["hello"])).rejects.toThrow(
      "Gateway embeddings timed out after 5ms.",
    );
    await expect(gateway.chat("hello")).rejects.toThrow("Gateway chat timed out after 5ms.");
  });
});

const stalledFetch: FetchLike = async (_url, init) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      const error = new Error("Aborted");
      error.name = "AbortError";
      reject(error);
    });
  });
