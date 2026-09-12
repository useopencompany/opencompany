import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  generateImage: vi.fn(),
  execute: vi.fn(),
  settle: vi.fn(),
  debit: vi.fn(),
  put: vi.fn(),
  attachments: vi.fn(),
  download: vi.fn(),
}));

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateText: mocks.generateText,
  generateImage: mocks.generateImage,
}));
vi.mock("@opencompany/db/client", () => ({
  getDb: () => ({
    execute: mocks.execute,
    select: () => ({ from: () => ({ where: () => ({ orderBy: mocks.attachments }) }) }),
  }),
}));
vi.mock("../chat-attachment-storage", () => ({ downloadChatAttachment: mocks.download }));
vi.mock("@opencompany/db/capabilities", () => ({
  isWorkspaceCapabilityEnabled: async () => true,
  getCapabilitySessionBudgetUsdMicros: async () => 10_000_000,
  sumCapabilitySessionSpendUsdMicros: async () => 0,
  consumeCapabilityApprovalByToolCall: async () => null,
  createCapabilityRun: async () => ({
    id: "capability_test",
    workspaceId: "workspace_test",
    userWorkosId: "user_test",
    chatSessionId: "chat_test",
    source: "image",
    action: "image.generate",
    createdAt: new Date(),
  }),
  settleCapabilityRun: mocks.settle,
}));
vi.mock("@opencompany/db/credits", () => ({
  getCreditBalanceUsdMicros: async () => 10_000_000,
  recordCreditDebit: mocks.debit,
}));
vi.mock("@opencompany/billing/auto-refill", () => ({ maybeTriggerAutoRefill: vi.fn() }));
vi.mock("@vercel/blob", () => ({ put: mocks.put, del: vi.fn() }));
vi.mock("./execute", () => ({
  isManagedCapabilitiesKilled: () => false,
  isManagedCapabilityActionKilled: () => false,
  capabilityTurnSnapshot: async (state: unknown) => state,
  admitCapabilityQuote: async () => true,
}));

import type { ActionExecuteContext } from "../actions/types";
import { MANAGED_CAPABILITY_ACTIONS_BY_ID } from "./catalog";
import { executeImageGenerationCapability } from "./image-generation";

describe("managed Gemini image execution", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("VERCEL_AI_GATEWAY_API_KEY", "test-key");
    mocks.generateImage.mockRejectedValue(
      new Error("The selected model is a language model, not an image model."),
    );
    mocks.generateText.mockResolvedValue({
      files: [{ mediaType: "image/png", uint8Array: new Uint8Array([137, 80, 78, 71]) }],
      providerMetadata: { gateway: { cost: "0.04", generationId: "generation_test" } },
    });
    mocks.execute.mockResolvedValueOnce([{ count: 0 }]).mockResolvedValue([{ id: "version_test" }]);
    mocks.put.mockResolvedValue({ pathname: "test/generated-image.png" });
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ["standard", "google/gemini-3.1-flash-image"],
    ["pro", "google/gemini-3-pro-image"],
  ])("generates and settles %s images through the language-model API", async (quality, model) => {
    const context = testContext();
    const result = await execute({ quality, aspectRatio: "16:9", resolution: "2K" }, context);

    expect(mocks.generateImage).not.toHaveBeenCalled();
    expect(mocks.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.objectContaining({ modelId: model, provider: "gateway" }),
        abortSignal: context.signal,
        maxRetries: 1,
        providerOptions: expect.objectContaining({
          google: {
            responseModalities: ["IMAGE"],
            imageConfig: { aspectRatio: "16:9", imageSize: "2K" },
          },
        }),
      }),
    );
    expect(result.artifact).toMatchObject({ mediaType: "image/png", state: "ready" });
    expect(mocks.debit).toHaveBeenCalledWith(
      expect.objectContaining({
        providerCostUsdMicros: 40_000,
        idempotencyKey: "capability:generation_test",
      }),
    );
    expect(mocks.settle).toHaveBeenCalledWith(
      expect.objectContaining({ status: "succeeded", resultCount: 1 }),
    );
  });

  it("fails a text-only response without publishing or charging for an image", async () => {
    mocks.generateText.mockResolvedValue({ files: [], providerMetadata: {} });
    await expect(execute()).rejects.toThrow("did not return an image");
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.debit).not.toHaveBeenCalled();
    expect(mocks.settle).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });

  it("passes the resolved reference image bytes in a multimodal user message", async () => {
    const reference = new Uint8Array([137, 80, 78, 71]);
    mocks.attachments.mockResolvedValue([
      {
        attachments: [
          {
            id: "attachment_test",
            kind: "image",
            mediaType: "image/png",
            blobUrl: "https://example.test/reference.png",
          },
        ],
      },
    ]);
    mocks.download.mockResolvedValue(reference);

    await execute({ referenceImageAttachmentId: "attachment_test" });

    expect(mocks.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "A blue circle" },
              { type: "image", image: reference },
            ],
          },
        ],
      }),
    );
  });

  it("preserves cancellation from the language-model request", async () => {
    const error = new DOMException("Canceled", "AbortError");
    mocks.generateText.mockRejectedValue(error);
    await expect(execute()).rejects.toBe(error);
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.debit).not.toHaveBeenCalled();
    expect(mocks.settle).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });

  it("retains the cost guard before publication", async () => {
    mocks.generateText.mockResolvedValue({
      files: [{ mediaType: "image/png", uint8Array: new Uint8Array([137, 80, 78, 71]) }],
      providerMetadata: { gateway: { cost: "2" } },
    });
    await expect(execute()).rejects.toThrow("could not be billed safely");
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.debit).not.toHaveBeenCalled();
  });
});

function execute(params: Record<string, unknown> = {}, context = testContext()) {
  const spec = MANAGED_CAPABILITY_ACTIONS_BY_ID.get("image.generate");
  if (spec?.executionProvider !== "ai-gateway") throw new Error("Missing image capability");
  return executeImageGenerationCapability({
    spec,
    params: { prompt: "A blue circle", ...params },
    context,
  });
}

function testContext(): ActionExecuteContext {
  return {
    userWorkosId: "user_test",
    workspaceId: "workspace_test",
    chatSessionId: "chat_test",
    toolCallId: "tool_test",
    sourceTurnId: "turn_test",
    sourceMessageId: "message_test",
    sourceEngine: "opencompany",
    signal: new AbortController().signal,
    currentDate: new Date(),
    userTimezone: "UTC",
    capabilityTurnState: {
      quotedTotalUsdMicros: 0,
      admittedToolCallIds: [],
      quotesByToolCallId: new Map(),
      asyncRunsStarted: 0,
    },
  };
}
