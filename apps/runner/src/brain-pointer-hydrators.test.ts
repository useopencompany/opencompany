import { normalizeBrainPointerCapture, normalizeGmailThreadWindow } from "@opencompany/brain";
import { describe, expect, it, vi } from "vitest";
import { runBrainPointerHydrate } from "./brain-pointer-hydrators";

const ENV = {
  vercelAiGatewayApiKey: "gateway_test",
};

function pointerItem(fallbackText?: string) {
  return normalizeBrainPointerCapture({
    sourceRef: "gmail:thread:thread_123",
    title: "Launch decision",
    ...(fallbackText ? { fallbackText } : {}),
    chatSessionId: "session_1",
    userMessageId: "message_1",
    draftBrainId: "launch-decision",
    draftFolder: "inbox",
    capturedAt: "2026-07-22T10:00:00.000Z",
  });
}

function hydratedGmailItem() {
  return normalizeGmailThreadWindow({
    windowId: "pointer:gmail:thread:thread_123",
    threadId: "thread_123",
    subject: "Launch decision",
    messages: [
      {
        messageId: "message_123",
        direction: "received",
        from: "ada@example.com",
        sentAt: "2026-07-22T10:00:00.000Z",
        bodyText: "Approved the launch plan.",
      },
    ],
    flushedAt: "2026-07-22T10:01:00.000Z",
  });
}

function runInput(fallbackText?: string) {
  return {
    jobId: "goat_brain_job_1",
    userWorkosId: "user_1",
    brainRef: "goat_brain_1",
    integrationId: "gint_gmail_1",
    item: pointerItem(fallbackText),
    env: ENV,
  };
}

describe("runBrainPointerHydrate", () => {
  it("delegates a hydrated source to its existing provider ingest", async () => {
    const hydrated = hydratedGmailItem();
    const runGmail = vi.fn(async () => ({ handled: true, traceId: "trace_1" }));

    const result = await runBrainPointerHydrate(runInput(), {
      hydrate: vi.fn(async () => hydrated),
      runGmail,
    });

    expect(runGmail).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "goat_brain_job_1",
        integrationId: "gint_gmail_1",
        item: hydrated,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(result).toMatchObject({
      handled: true,
      traceId: "trace_1",
      pointerHydrated: true,
      sourceRef: "gmail:thread:thread_123",
      hydratedContentHash: hydrated.contentHash,
    });
  });

  it("skips an unreachable source with no fallback", async () => {
    const runFallback = vi.fn();

    const result = await runBrainPointerHydrate(runInput(), {
      hydrate: vi.fn(async () => null),
      runFallback,
    });

    expect(result).toEqual({
      skipped: true,
      reason: "pointer_source_unreachable",
      summary: "pointer_source_unreachable",
      sourceRef: "gmail:thread:thread_123",
    });
    expect(runFallback).not.toHaveBeenCalled();
  });

  it("curates fallback content when the provider source is unreachable", async () => {
    const runFallback = vi.fn(async () => ({ handled: true }));

    const result = await runBrainPointerHydrate(runInput("The team approved the launch plan."), {
      hydrate: vi.fn(async () => null),
      runFallback,
    });

    expect(runFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        integrationId: null,
        item: expect.objectContaining({
          sourceProvider: "goat-chat",
          sourceType: "capture",
          sourceRef: "gmail:thread:thread_123",
          content: expect.objectContaining({
            capture: expect.objectContaining({
              text: "The team approved the launch plan.",
              draftBrainId: "launch-decision",
            }),
          }),
        }),
      }),
    );
    expect(result).toMatchObject({
      handled: true,
      pointerFallback: true,
      sourceRef: "gmail:thread:thread_123",
    });
  });
});
