import type { generateObject } from "ai";
import { describe, expect, it, vi } from "vitest";
import {
  GOAT_CHAT_FRONTIER_MODEL,
  GOAT_CHAT_PDF_MODEL,
  GOAT_CHAT_STANDARD_MODEL,
  resolveAutoGoatModel,
} from "@/lib/chat-model-router";

const baseInput = {
  prompt: "What is the capital of France?",
  attachments: [],
  gatewayApiKey: "test-key",
  userWorkosId: "user_1",
  workspaceId: "workspace_1",
} as const;

describe("resolveAutoGoatModel", () => {
  it("routes PDFs directly to the PDF-capable model without a classifier call", async () => {
    const generateObjectImpl = vi.fn();

    const result = await resolveAutoGoatModel(
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
    const result = await resolveAutoGoatModel({
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

    const result = await resolveAutoGoatModel(baseInput, {
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
        maxOutputTokens: 30,
        temperature: 0,
        abortSignal: expect.any(AbortSignal),
        providerOptions: expect.objectContaining({
          gateway: expect.objectContaining({ sort: "latency" }),
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

    const result = await resolveAutoGoatModel(baseInput, {
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

    const result = await resolveAutoGoatModel(baseInput, {
      generateObjectImpl: generateObjectImpl as unknown as typeof generateObject,
    });

    expect(result).toMatchObject({
      model: GOAT_CHAT_FRONTIER_MODEL,
      tier: "frontier",
      reason: "router_fallback",
      classifier: { outcome: "timeout" },
    });
  });

  it("fails safely when the classifier returns an invalid result", async () => {
    const generateObjectImpl = vi.fn(async () => ({
      object: { tier: "cheap", reason: "guess" },
      usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
    }));

    const result = await resolveAutoGoatModel(baseInput, {
      generateObjectImpl: generateObjectImpl as unknown as typeof generateObject,
    });

    expect(result).toMatchObject({
      model: GOAT_CHAT_FRONTIER_MODEL,
      tier: "frontier",
      reason: "router_fallback",
      classifier: { outcome: "invalid" },
    });
  });
});
