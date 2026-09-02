import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureAnalytics: vi.fn(),
  enqueue: vi.fn(),
  findExistingCapture: vi.fn(),
  findExistingPointer: vi.fn(),
  nextBrainId: vi.fn(),
  upsertFile: vi.fn(),
}));

vi.mock("@opencompany/analytics/product", () => ({
  captureProductIngestionQuotaAnalytics: mocks.captureAnalytics,
}));
vi.mock("@opencompany/db/brain-files", () => ({
  createBrainMarkdownContent: vi.fn((input: unknown) => JSON.stringify(input)),
  brainFilePathFor: vi.fn((folder: string, id: string) => `${folder}/${id}.md`),
  upsertBrainFile: mocks.upsertFile,
}));
vi.mock("@opencompany/db/brain-ingest", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@opencompany/db/brain-ingest")>();
  return {
    ...actual,
    findExistingBrainChatCaptureIngest: mocks.findExistingCapture,
    findExistingBrainPointerIngest: mocks.findExistingPointer,
    upsertBrainSourceItemAndEnqueue: mocks.enqueue,
  };
});
vi.mock("@opencompany/agent/brain-files", () => ({
  nextAvailableBrainId: mocks.nextBrainId,
}));

import { captureToBrainInbox } from "@/lib/brain-capture";

const BASE_INPUT = {
  brainRef: "goat_brain_1",
  userWorkosId: "user_1",
  title: "Launch decision",
  source: {
    kind: "chat" as const,
    connectionId: "session_1",
    itemId: "message_1",
  },
};

describe("captureToBrainInbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.nextBrainId.mockResolvedValue("launch-decision");
    mocks.findExistingCapture.mockResolvedValue(null);
    mocks.findExistingPointer.mockResolvedValue(null);
    mocks.enqueue.mockResolvedValue({
      jobId: "goat_brain_job_1",
      enqueued: true,
      paused: false,
      quotaUpdates: [],
    });
  });

  it("preserves source provenance for copied integration content", async () => {
    const result = await captureToBrainInbox({
      ...BASE_INPUT,
      text: "The team approved the launch plan.",
      sourceRef: "linear:issue:ENG-1",
    });

    expect(result).toMatchObject({ ok: true, draftBrainId: "launch-decision" });
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceConnectionId: "session_1",
        kind: "brain_agent_ingest",
        item: expect.objectContaining({
          sourceType: "capture",
          sourceRef: "linear:issue:ENG-1",
        }),
      }),
    );
    expect(mocks.upsertFile).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('"ref":"linear:issue:ENG-1"'),
      }),
    );
  });

  it("enqueues a bare integration source for pointer hydration", async () => {
    const result = await captureToBrainInbox({
      ...BASE_INPUT,
      sourceRef: "gmail:thread:thread_123",
      integrationId: "gint_gmail_1",
      fallbackText: "The team approved the launch plan.",
    });

    expect(result).toMatchObject({ ok: true, enqueued: true });
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceConnectionId: "gint_gmail_1",
        integrationId: "gint_gmail_1",
        kind: "brain_pointer_hydrate",
        item: expect.objectContaining({
          sourceProvider: "gmail",
          sourceType: "pointer",
          sourceRef: "gmail:thread:thread_123",
          content: expect.objectContaining({
            pointer: expect.objectContaining({
              fallbackText: "The team approved the launch plan.",
            }),
          }),
        }),
      }),
    );
  });

  it("rejects pointers without a provider integration id", async () => {
    const result = await captureToBrainInbox({
      ...BASE_INPUT,
      sourceRef: "gmail:thread:thread_1",
    });

    expect(result).toEqual({
      ok: false,
      error: "A bare integration source needs the integrationId returned by use_action.",
    });
    expect(mocks.upsertFile).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("reuses an existing pointer capture without creating another draft", async () => {
    mocks.findExistingPointer.mockResolvedValue({
      jobId: "goat_brain_job_existing",
      status: "succeeded",
      planPaused: false,
      draftBrainId: "existing-launch-decision",
      draftFolder: "projects",
      title: "Existing launch decision",
    });

    const result = await captureToBrainInbox({
      ...BASE_INPUT,
      sourceRef: "linear:issue:ENG-1",
      integrationId: "gint_linear_1",
    });

    expect(result).toEqual({
      ok: true,
      draftBrainId: "existing-launch-decision",
      path: "projects/existing-launch-decision.md",
      title: "Existing launch decision",
      jobId: "goat_brain_job_existing",
      enqueued: false,
      alreadyCaptured: true,
      quotaPaused: false,
    });
    expect(mocks.nextBrainId).not.toHaveBeenCalled();
    expect(mocks.upsertFile).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("reuses a durable chat capture idempotency key after a recovered tool call", async () => {
    mocks.findExistingCapture.mockResolvedValue({
      jobId: "goat_brain_job_existing",
      status: "queued",
      planPaused: false,
      draftBrainId: "existing-launch-decision",
      draftFolder: "inbox",
      title: "Existing launch decision",
    });

    const result = await captureToBrainInbox({
      ...BASE_INPUT,
      text: "The team approved the launch plan.",
      source: {
        ...BASE_INPUT.source,
        idempotencyKey: "codex-save:stable-capture-key",
      },
    });

    expect(result).toMatchObject({
      ok: true,
      draftBrainId: "existing-launch-decision",
      alreadyCaptured: true,
    });
    expect(mocks.findExistingCapture).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      sourceConnectionId: "session_1",
      externalId: "codex-save:stable-capture-key",
      brainRef: "goat_brain_1",
    });
    expect(mocks.nextBrainId).not.toHaveBeenCalled();
    expect(mocks.upsertFile).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("persists a new durable chat capture with its idempotency key", async () => {
    await captureToBrainInbox({
      ...BASE_INPUT,
      text: "The team approved the launch plan.",
      source: {
        ...BASE_INPUT.source,
        idempotencyKey: "codex-save:stable-capture-key",
      },
    });

    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        item: expect.objectContaining({
          externalId: "codex-save:stable-capture-key",
        }),
      }),
    );
  });

  it("requires copied content instead of hydrating a Slack pointer", async () => {
    const result = await captureToBrainInbox({
      ...BASE_INPUT,
      sourceRef: "slack:conversation:T123:C456:1234.5678",
      integrationId: "gint_slack_1",
    });

    expect(result).toEqual({
      ok: false,
      error: "This source needs fallback content because its provider cannot be hydrated.",
    });
    expect(mocks.upsertFile).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
