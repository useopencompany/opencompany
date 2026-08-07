import { APICallError, type generateObject, NoObjectGeneratedError } from "ai";
import { describe, expect, it, vi } from "vitest";
import {
  GOAT_CHAT_FRONTIER_MODEL,
  GOAT_CHAT_PDF_MODEL,
  GOAT_CHAT_STANDARD_MODEL,
  resolveAutoModel,
} from "@/lib/chat-model-router";

const baseInput = {
  prompt: "What is the capital of France?",
  attachments: [],
  gatewayApiKey: "test-key",
  userWorkosId: "user_1",
  workspaceId: "workspace_1",
} as const;

describe("resolveAutoModel", () => {
  it("routes PDFs directly to the PDF-capable model without a classifier call", async () => {
    const generateObjectImpl = vi.fn();

    const result = await resolveAutoModel(
      {
        ...baseInput,
        attachments: [{ kind: "pdf" }],
      },
      { generateObjectImpl: generateObjectImpl as unknown as typeof generateObject },
    );

    expect(result).toMatchObject({
      model: GOAT_CHAT_PDF_MODEL,
      tier: "frontier",
      reason: "pdf_attachment",
      classifier: { outcome: "skipped" },
    });
    expect(generateObjectImpl).not.toHaveBeenCalled();
  });

  it("routes other attachments directly to the frontier model", async () => {
    const result = await resolveAutoModel({
      ...baseInput,
      attachments: [{ kind: "image" }],
    });

    expect(result).toMatchObject({
      model: GOAT_CHAT_FRONTIER_MODEL,
      tier: "frontier",
      reason: "attachment",
      classifier: { outcome: "skipped" },
    });
  });

  it("uses the standard model for a successful standard classification", async () => {
    const generateObjectImpl = vi.fn(async () => ({
      object: { tier: "standard", reason: "simple_answer" },
      usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
    }));

    const result = await resolveAutoModel(baseInput, {
      generateObjectImpl: generateObjectImpl as unknown as typeof generateObject,
    });

    expect(result).toMatchObject({
      model: GOAT_CHAT_STANDARD_MODEL,
      tier: "standard",
      reason: "simple_answer",
      classifier: { outcome: "success" },
    });
    expect(generateObjectImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        maxOutputTokens: 100,
        temperature: 0,
        abortSignal: expect.any(AbortSignal),
        providerOptions: expect.objectContaining({
          gateway: expect.objectContaining({ sort: "ttft" }),
          google: {
            thinkingConfig: {
              thinkingLevel: "minimal",
              includeThoughts: false,
            },
          },
        }),
      }),
    );
  });

  it("uses the frontier model for a successful frontier classification", async () => {
    const generateObjectImpl = vi.fn(async () => ({
      object: { tier: "frontier", reason: "coding" },
      usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
    }));

    const result = await resolveAutoModel(baseInput, {
      generateObjectImpl: generateObjectImpl as unknown as typeof generateObject,
    });

    expect(result).toMatchObject({
      model: GOAT_CHAT_FRONTIER_MODEL,
      tier: "frontier",
      reason: "coding",
      classifier: { outcome: "success" },
    });
  });

  it("fails safely to the frontier model on classifier errors", async () => {
    const generateObjectImpl = vi.fn(async () => {
      throw new DOMException("Timed out", "TimeoutError");
    });

    const result = await resolveAutoModel(baseInput, {
      generateObjectImpl: generateObjectImpl as unknown as typeof generateObject,
    });

    expect(result).toMatchObject({
      model: GOAT_CHAT_FRONTIER_MODEL,
      tier: "frontier",
      reason: "router_fallback",
      classifier: { outcome: "timeout", errorCategory: "timeout" },
    });
  });

  it("preserves usage and categorizes output-length object failures", async () => {
    const usage = {
      inputTokens: 20,
      inputTokenDetails: { noCacheTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
      outputTokens: 30,
      outputTokenDetails: { textTokens: 30, reasoningTokens: 0 },
      totalTokens: 50,
    };
    const generateObjectImpl = vi.fn(async () => {
      throw new NoObjectGeneratedError({
        message: "No object generated: could not parse the response.",
        cause: new SyntaxError("Unexpected EOF"),
        text: '{"tier":"standard","reason":',
        response: {
          id: "response_1",
          timestamp: new Date(),
          modelId: "google/gemini-3.1-flash-lite",
        },
        usage,
        finishReason: "length",
      });
    });

    const result = await resolveAutoModel(baseInput, {
      generateObjectImpl: generateObjectImpl as unknown as typeof generateObject,
    });

    expect(result).toMatchObject({
      model: GOAT_CHAT_FRONTIER_MODEL,
      reason: "router_fallback",
      classifier: {
        outcome: "invalid",
        errorCategory: "output_length",
        finishReason: "length",
        usage,
      },
    });
  });

  it("records safe provider diagnostics without response content", async () => {
    const generateObjectImpl = vi.fn(async () => {
      throw new APICallError({
        message: "Rate limited",
        url: "https://gateway.test/v1",
        requestBodyValues: {},
        statusCode: 429,
        responseBody: "provider details must not be persisted",
        isRetryable: true,
      });
    });

    const result = await resolveAutoModel(baseInput, {
      generateObjectImpl: generateObjectImpl as unknown as typeof generateObject,
    });

    expect(result.classifier).toMatchObject({
      outcome: "error",
      errorCategory: "rate_limit",
      providerStatusCode: 429,
      providerRetryable: true,
    });
    expect(result.classifier).not.toHaveProperty("responseBody");
  });

  it("fails safely when the classifier returns an invalid result", async () => {
    const generateObjectImpl = vi.fn(async () => ({
      object: { tier: "cheap", reason: "guess" },
      usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
    }));

    const result = await resolveAutoModel(baseInput, {
      generateObjectImpl: generateObjectImpl as unknown as typeof generateObject,
    });

    expect(result).toMatchObject({
      model: GOAT_CHAT_FRONTIER_MODEL,
      tier: "frontier",
      reason: "router_fallback",
      classifier: { outcome: "invalid", errorCategory: "invalid_output" },
    });
  });
});
