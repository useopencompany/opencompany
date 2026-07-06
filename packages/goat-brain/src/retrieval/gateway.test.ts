import { describe, expect, it } from "vitest";
import { createGateway, type FetchLike } from "./gateway";

describe("goat brain retrieval gateway", () => {
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
