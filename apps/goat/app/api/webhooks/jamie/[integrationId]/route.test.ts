import { upsertGoatBrainSourceItemAndEnqueue } from "@opencompany/db/goat-brain-ingest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  bindGoatJamieWebhookApiKey,
  loadGoatJamieWebhookContext,
  markGoatJamieWebhookConnected,
  verifyGoatJamieWebhookApiKey,
} from "@/lib/integrations/jamie";
import { triggerGoatBrainIngestWake } from "@/lib/task-runner";
import { POST } from "./route";

vi.mock("@/lib/integrations/jamie", () => ({
  bindGoatJamieWebhookApiKey: vi.fn(),
  loadGoatJamieWebhookContext: vi.fn(),
  markGoatJamieWebhookConnected: vi.fn(),
  verifyGoatJamieWebhookApiKey: vi.fn(),
}));

vi.mock("@/lib/task-runner", () => ({
  triggerGoatBrainIngestWake: vi.fn(async () => undefined),
}));

vi.mock("@opencompany/db/goat-brain-ingest", () => ({
  upsertGoatBrainSourceItemAndEnqueue: vi.fn(),
}));

describe("POST /api/webhooks/jamie/[integrationId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadGoatJamieWebhookContext).mockResolvedValue({
      integrationId: "gint_123",
      userWorkosId: "user_123",
      apiKeyHash: "hash",
      legacySecretHash: null,
    });
    vi.mocked(verifyGoatJamieWebhookApiKey).mockReturnValue({
      valid: true,
      shouldBind: false,
      apiKey: jamieApiKey(),
    });
    vi.mocked(upsertGoatBrainSourceItemAndEnqueue).mockResolvedValue({
      sourceItemId: "gbsrc_123",
      jobId: "gbjob_123",
      enqueued: true,
    });
    vi.mocked(bindGoatJamieWebhookApiKey).mockResolvedValue(undefined);
    vi.mocked(markGoatJamieWebhookConnected).mockResolvedValue(undefined);
  });

  it("returns 404 for an unknown Jamie integration", async () => {
    vi.mocked(loadGoatJamieWebhookContext).mockResolvedValue(null);

    const response = await POST(jamieRequest(jamiePayload()), routeContext());

    expect(response.status).toBe(404);
    expect(upsertGoatBrainSourceItemAndEnqueue).not.toHaveBeenCalled();
  });

  it("returns 401 for a missing or wrong Jamie API key", async () => {
    vi.mocked(verifyGoatJamieWebhookApiKey).mockReturnValue({
      valid: false,
      shouldBind: false,
      apiKey: null,
    });

    const response = await POST(jamieRequest(jamiePayload()), routeContext());

    expect(response.status).toBe(401);
    expect(upsertGoatBrainSourceItemAndEnqueue).not.toHaveBeenCalled();
  });

  it("returns 400 for unsupported Jamie events", async () => {
    const response = await POST(
      jamieRequest(jamiePayload(), { event: "meeting.started" }),
      routeContext(),
    );

    expect(response.status).toBe(400);
    expect(upsertGoatBrainSourceItemAndEnqueue).not.toHaveBeenCalled();
  });

  it("normalizes, enqueues, marks connected, and wakes the runner", async () => {
    const response = await POST(jamieRequest(jamiePayload()), routeContext());
    const body = (await response.json()) as { ok?: boolean; enqueued?: boolean };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, enqueued: true });
    expect(upsertGoatBrainSourceItemAndEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        userWorkosId: "user_123",
        sourceConnectionId: "gint_123",
        integrationId: "gint_123",
        rawPayload: jamiePayload(),
        item: expect.objectContaining({
          sourceProvider: "jamie",
          sourceType: "meeting",
          externalId: "calendar_event_123",
        }),
      }),
    );
    expect(markGoatJamieWebhookConnected).toHaveBeenCalledWith(
      expect.objectContaining({
        integrationId: "gint_123",
        userWorkosId: "user_123",
      }),
    );
    expect(triggerGoatBrainIngestWake).toHaveBeenCalledTimes(1);
  });

  it("binds the Jamie API key on the first valid delivery", async () => {
    vi.mocked(loadGoatJamieWebhookContext).mockResolvedValue({
      integrationId: "gint_123",
      userWorkosId: "user_123",
      apiKeyHash: null,
      legacySecretHash: null,
    });
    vi.mocked(verifyGoatJamieWebhookApiKey).mockReturnValue({
      valid: true,
      shouldBind: true,
      apiKey: jamieApiKey(),
    });

    const response = await POST(jamieRequest(jamiePayload()), routeContext());

    expect(response.status).toBe(200);
    expect(bindGoatJamieWebhookApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        integrationId: "gint_123",
        userWorkosId: "user_123",
        apiKey: jamieApiKey(),
      }),
    );
    expect(upsertGoatBrainSourceItemAndEnqueue).toHaveBeenCalledTimes(1);
  });
});

function routeContext() {
  return { params: Promise.resolve({ integrationId: "gint_123" }) };
}

function jamieRequest(payload: unknown, options: { event?: string; secret?: string } = {}) {
  return new Request("https://goat.test/api/webhooks/jamie/gint_123", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "jamie-event": options.event ?? "meeting.completed",
      "x-jamie-api-key": options.secret ?? jamieApiKey(),
    },
    body: JSON.stringify(payload),
  });
}

function jamieApiKey() {
  return "sk_0000000000000000000000000000000000000000000000000000000000000000";
}

function jamiePayload() {
  return {
    metadata: {
      event: "meeting.completed",
      created: "2026-01-01T11:00:00.000Z",
    },
    data: {
      user: { id: "user_123" },
      event: {
        externalId: "calendar_event_123",
        title: "Product Review",
        startTime: "2026-01-01T10:00:00.000Z",
        summary: "We reviewed the product plan.",
        transcript: [{ speakerName: "Jamie", text: "Let's review the product plan." }],
      },
    },
  };
}
