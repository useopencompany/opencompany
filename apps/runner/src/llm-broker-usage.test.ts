import { describe, expect, it } from "vitest";
import {
  createSseUsageScanner,
  normalizeBrokerModelId,
  parseJsonUsage,
  priceBrokerRequest,
} from "./llm-broker-usage";

describe("parseJsonUsage", () => {
  it("parses chat-completions usage with cached prompt tokens", () => {
    const usage = parseJsonUsage({
      id: "chatcmpl-1",
      usage: {
        prompt_tokens: 1_000,
        completion_tokens: 200,
        prompt_tokens_details: { cached_tokens: 400 },
      },
    });
    expect(usage).toMatchObject({
      parsed: true,
      inputTokens: 1_000,
      inputCacheReadTokens: 400,
      inputCacheWriteTokens: 0,
      outputTokens: 200,
      providerCostUsd: null,
    });
  });

  it("parses Responses API usage (flat and nested under response)", () => {
    const flat = parseJsonUsage({
      usage: {
        input_tokens: 500,
        output_tokens: 50,
        input_tokens_details: { cached_tokens: 100 },
      },
    });
    expect(flat).toMatchObject({
      parsed: true,
      inputTokens: 500,
      inputCacheReadTokens: 100,
      outputTokens: 50,
    });

    const nested = parseJsonUsage({
      type: "response.completed",
      response: { usage: { input_tokens: 7, output_tokens: 3 } },
    });
    expect(nested).toMatchObject({ parsed: true, inputTokens: 7, outputTokens: 3 });
  });

  it("parses embeddings usage and gateway-reported cost", () => {
    const usage = parseJsonUsage({
      data: [],
      usage: { prompt_tokens: 123, total_tokens: 123, cost: 0.002 },
    });
    expect(usage).toMatchObject({ parsed: true, inputTokens: 123, providerCostUsd: 0.002 });
  });

  it("parses Anthropic-style cache writes surfaced through the gateway", () => {
    const usage = parseJsonUsage({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 10,
        cache_creation_input_tokens: 60,
      },
    });
    expect(usage.inputCacheWriteTokens).toBe(60);
  });

  it("returns parsed: false when no usage exists", () => {
    expect(parseJsonUsage({ id: "x" }).parsed).toBe(false);
    expect(parseJsonUsage(null).parsed).toBe(false);
    expect(parseJsonUsage("nope").parsed).toBe(false);
  });
});

describe("createSseUsageScanner", () => {
  it("captures the final usage chunk of a streamed chat completion", () => {
    const scanner = createSseUsageScanner();
    scanner.push('data: {"choices":[{"delta":{"content":"he');
    scanner.push('llo"}}],"usage":null}\n\n');
    scanner.push(
      'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":5}}\n\ndata: [DONE]\n\n',
    );
    expect(scanner.finish()).toMatchObject({ parsed: true, inputTokens: 11, outputTokens: 5 });
  });

  it("captures response.completed usage from a Responses API stream", () => {
    const scanner = createSseUsageScanner();
    scanner.push('event: response.output_text.delta\ndata: {"type":"response.output_text.delta"');
    scanner.push(',"delta":"hi"}\n\nevent: response.completed\ndata: {"type":"response.completed"');
    scanner.push(',"response":{"usage":{"input_tokens":42,"output_tokens":9}}}\n\n');
    expect(scanner.finish()).toMatchObject({ parsed: true, inputTokens: 42, outputTokens: 9 });
  });

  it("scans a trailing event without a final boundary and tolerates junk", () => {
    const scanner = createSseUsageScanner();
    scanner.push("data: not-json\n\n");
    scanner.push('data: {"usage":{"prompt_tokens":1,"completion_tokens":2}}');
    expect(scanner.finish()).toMatchObject({ parsed: true, inputTokens: 1, outputTokens: 2 });
  });

  it("returns parsed: false for a stream without usage", () => {
    const scanner = createSseUsageScanner();
    scanner.push('data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n');
    expect(scanner.finish().parsed).toBe(false);
  });
});

describe("normalizeBrokerModelId", () => {
  it("prefixes bare OpenAI model names and passes catalog ids through", () => {
    expect(normalizeBrokerModelId("openai", "gpt-5.2-codex")).toBe("openai/gpt-5.2-codex");
    expect(normalizeBrokerModelId("openai", "openai/gpt-5.2-codex")).toBe("openai/gpt-5.2-codex");
    expect(normalizeBrokerModelId("gateway", "anthropic/claude-sonnet-4.6")).toBe(
      "anthropic/claude-sonnet-4.6",
    );
  });
});

describe("priceBrokerRequest", () => {
  it("prefers the gateway-reported dollar cost", () => {
    const cost = priceBrokerRequest({
      provider: "gateway",
      model: "anthropic/claude-sonnet-4.6",
      usage: {
        parsed: true,
        inputTokens: 1_000_000,
        inputCacheReadTokens: 0,
        inputCacheWriteTokens: 0,
        outputTokens: 0,
        providerCostUsd: 0.5,
        raw: {},
      },
    });
    expect(cost).toBe(500_000);
  });

  it("prices catalog models from MODEL_PRICING with cache splits", () => {
    // claude-sonnet-4.6: input $3/M, cache read $0.30/M, output $15/M.
    const cost = priceBrokerRequest({
      provider: "gateway",
      model: "anthropic/claude-sonnet-4.6",
      usage: {
        parsed: true,
        inputTokens: 1_000_000,
        inputCacheReadTokens: 500_000,
        inputCacheWriteTokens: 0,
        outputTokens: 100_000,
        providerCostUsd: null,
        raw: {},
      },
    });
    // 500k uncached * 3.0 + 500k cached * 0.3 + 100k out * 15.0 (USD micros per million)
    expect(cost).toBe(1_500_000 + 150_000 + 1_500_000);
  });

  it("prices bare codex models via the openai/ prefix", () => {
    // gpt-5.2-codex: input $1.75/M, output $14/M.
    const cost = priceBrokerRequest({
      provider: "openai",
      model: "gpt-5.2-codex",
      usage: {
        parsed: true,
        inputTokens: 1_000_000,
        inputCacheReadTokens: 0,
        inputCacheWriteTokens: 0,
        outputTokens: 1_000_000,
        providerCostUsd: null,
        raw: {},
      },
    });
    expect(cost).toBe(1_750_000 + 14_000_000);
  });

  it("falls back to the aux gateway pricing for off-catalog models", () => {
    // text-embedding-3-small: input $0.02/M.
    const cost = priceBrokerRequest({
      provider: "gateway",
      model: "openai/text-embedding-3-small",
      usage: {
        parsed: true,
        inputTokens: 1_000_000,
        inputCacheReadTokens: 0,
        inputCacheWriteTokens: 0,
        outputTokens: 0,
        providerCostUsd: null,
        raw: {},
      },
    });
    expect(cost).toBe(20_000);
  });

  it("prices unknown models to zero instead of guessing", () => {
    const cost = priceBrokerRequest({
      provider: "gateway",
      model: "mystery/model",
      usage: {
        parsed: true,
        inputTokens: 1_000_000,
        inputCacheReadTokens: 0,
        inputCacheWriteTokens: 0,
        outputTokens: 1_000_000,
        providerCostUsd: null,
        raw: {},
      },
    });
    expect(cost).toBe(0);
    expect(
      priceBrokerRequest({
        provider: "gateway",
        model: null,
        usage: {
          parsed: true,
          inputTokens: 10,
          inputCacheReadTokens: 0,
          inputCacheWriteTokens: 0,
          outputTokens: 10,
          providerCostUsd: null,
          raw: {},
        },
      }),
    ).toBe(0);
  });
});
