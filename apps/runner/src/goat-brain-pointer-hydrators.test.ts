import {
  normalizeGoatBrainPointerCapture,
  normalizeSlackConversationWindow,
} from "@opencompany/goat-brain";
import { describe, expect, it, vi } from "vitest";
import { runGoatBrainPointerHydrate } from "./goat-brain-pointer-hydrators";

const ENV = {
  vercelAiGatewayApiKey: "gateway_test",
};

function pointerItem(fallbackText?: string) {
  return normalizeGoatBrainPointerCapture({
    sourceRef: "slack:conversation:T123:C456:1234.5678",
    title: "Launch decision",
    ...(fallbackText ? { fallbackText } : {}),
    chatSessionId: "session_1",
    userMessageId: "message_1",
    draftBrainId: "launch-decision",
    draftFolder: "inbox",
    capturedAt: "2026-07-22T10:00:00.000Z",
  });
}

function hydratedSlackItem() {
  return normalizeSlackConversationWindow({
    windowId: "pointer:slack:conversation:T123:C456:1234.5678",
    teamId: "T123",
    teamDomain: "acme",
    channelId: "C456",
    channelName: "launch",
    channelType: "channel",
    messages: [
      {
        ts: "1234.5678",
        userId: "U123",
        userName: "Ada",
        text: "Approved the launch plan.",
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
    integrationId: "gint_slack_1",
    item: pointerItem(fallbackText),
    env: ENV,
  };
}

describe("runGoatBrainPointerHydrate", () => {
  it("delegates a hydrated source to its existing provider ingest", async () => {
    const hydrated = hydratedSlackItem();
    const runSlack = vi.fn(async () => ({ handled: true, traceId: "trace_1" }));

    const result = await runGoatBrainPointerHydrate(runInput(), {
      hydrate: vi.fn(async () => hydrated),
      runSlack,
    });

    expect(runSlack).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "goat_brain_job_1",
        integrationId: "gint_slack_1",
        item: hydrated,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(result).toMatchObject({
      handled: true,
      traceId: "trace_1",
      pointerHydrated: true,
      sourceRef: "slack:conversation:T123:C456:1234.5678",
      hydratedContentHash: hydrated.contentHash,
    });
  });

  it("skips an unreachable source with no fallback", async () => {
    const runFallback = vi.fn();

    const result = await runGoatBrainPointerHydrate(runInput(), {
      hydrate: vi.fn(async () => null),
      runFallback,
    });

    expect(result).toEqual({
      skipped: true,
      reason: "pointer_source_unreachable",
      summary: "pointer_source_unreachable",
      sourceRef: "slack:conversation:T123:C456:1234.5678",
    });
    expect(runFallback).not.toHaveBeenCalled();
  });

  it("curates fallback content when the provider source is unreachable", async () => {
    const runFallback = vi.fn(async () => ({ handled: true }));

    const result = await runGoatBrainPointerHydrate(
      runInput("The team approved the launch plan."),
      {
        hydrate: vi.fn(async () => null),
        runFallback,
      },
    );

    expect(runFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        integrationId: null,
        item: expect.objectContaining({
          sourceProvider: "goat-chat",
          sourceType: "capture",
          sourceRef: "slack:conversation:T123:C456:1234.5678",
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
      sourceRef: "slack:conversation:T123:C456:1234.5678",
    });
  });
});
