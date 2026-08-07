import { upsertBrainSourceItemAndEnqueue } from "@opencompany/db/brain-ingest";
import {
  hasAnyBrainSourceForIntegration,
  listEnabledBrainRefsForIntegration,
} from "@opencompany/db/brain-sources";
import { getDefaultBrainForUser } from "@opencompany/db/workspaces";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadJamieWebhookContext,
  markJamieWebhookConnected,
  verifyJamieWebhookApiKey,
} from "@/lib/integrations/jamie";
import { triggerBrainIngestWake } from "@/lib/task-runner";
import { POST } from "./route";

vi.mock("@/lib/integrations/jamie", () => ({
  loadJamieWebhookContext: vi.fn(),
  markJamieWebhookConnected: vi.fn(),
  verifyJamieWebhookApiKey: vi.fn(),
}));

vi.mock("@/lib/task-runner", () => ({
  triggerBrainIngestWake: vi.fn(async () => undefined),
}));

vi.mock("@opencompany/db/brain-ingest", () => ({
  BRAIN_AGENT_INGEST_JOB_KIND: "brain_agent_ingest",
  upsertBrainSourceItemAndEnqueue: vi.fn(),
}));

vi.mock("@opencompany/db/brain-sources", () => ({
  hasAnyBrainSourceForIntegration: vi.fn(),
  listEnabledBrainRefsForIntegration: vi.fn(),
}));

vi.mock("@opencompany/db/workspaces", () => ({
  getDefaultBrainForUser: vi.fn(),
}));

describe("POST /api/webhooks/jamie/[integrationId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadJamieWebhookContext).mockResolvedValue({
      integrationId: "gint_123",
      userWorkosId: "user_123",
      apiKeyHash: "hash",
      legacySecretHash: null,
    });
    vi.mocked(verifyJamieWebhookApiKey).mockReturnValue({
      valid: true,
      apiKey: jamieApiKey(),
    });
    vi.mocked(upsertBrainSourceItemAndEnqueue).mockResolvedValue({
      sourceItemId: "gbsrc_123",
      jobId: "gbjob_123",
      jobIds: ["gbjob_123"],
      enqueued: true,
      skipped: false,
    });
    vi.mocked(listEnabledBrainRefsForIntegration).mockResolvedValue([]);
    vi.mocked(hasAnyBrainSourceForIntegration).mockResolvedValue(false);
    vi.mocked(getDefaultBrainForUser).mockResolvedValue({
      id: "gbrain_123",
    } as Awaited<ReturnType<typeof getDefaultBrainForUser>>);
    vi.mocked(markJamieWebhookConnected).mockResolvedValue(undefined);
  });

  it("returns 404 for an unknown Jamie integration", async () => {
    vi.mocked(loadJamieWebhookContext).mockResolvedValue(null);

    const response = await POST(jamieRequest(jamiePayload()), routeContext());

    expect(response.status).toBe(404);
    expect(upsertBrainSourceItemAndEnqueue).not.toHaveBeenCalled();
  });

  it("returns 401 for a missing or wrong Jamie API key", async () => {
    vi.mocked(verifyJamieWebhookApiKey).mockReturnValue({
      valid: false,
      apiKey: null,
    });

    const response = await POST(jamieRequest(jamiePayload()), routeContext());

    expect(response.status).toBe(401);
    expect(upsertBrainSourceItemAndEnqueue).not.toHaveBeenCalled();
  });

  it("returns 400 for unsupported Jamie events", async () => {
    const response = await POST(
      jamieRequest(jamiePayload(), { event: "meeting.started" }),
      routeContext(),
    );

    expect(response.status).toBe(400);
    expect(upsertBrainSourceItemAndEnqueue).not.toHaveBeenCalled();
  });

  it("normalizes, enqueues, marks connected, and wakes the runner", async () => {
    const response = await POST(jamieRequest(jamiePayload()), routeContext());
    const body = (await response.json()) as { ok?: boolean; enqueued?: boolean };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, enqueued: true });
    expect(upsertBrainSourceItemAndEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        userWorkosId: "user_123",
        sourceConnectionId: "gint_123",
        integrationId: "gint_123",
        rawPayload: jamiePayload(),
        kind: "brain_agent_ingest",
        brainRefs: ["gbrain_123"],
        item: expect.objectContaining({
          sourceProvider: "jamie",
          sourceType: "meeting",
          externalId: "calendar_event_123",
        }),
      }),
    );
    expect(markJamieWebhookConnected).toHaveBeenCalledWith(
      expect.objectContaining({
        integrationId: "gint_123",
        userWorkosId: "user_123",
      }),
    );
    expect(triggerBrainIngestWake).toHaveBeenCalledTimes(1);
  });

  it("fans out to every enabled brain source and skips the default-brain lookup", async () => {
    vi.mocked(listEnabledBrainRefsForIntegration).mockResolvedValue([
      "goat_brain_a",
      "goat_brain_b",
    ]);
    vi.mocked(upsertBrainSourceItemAndEnqueue).mockResolvedValue({
      sourceItemId: "gbsrc_123",
      jobId: "gbjob_b",
      jobIds: ["gbjob_a", "gbjob_b"],
      enqueued: true,
      skipped: false,
    });

    const response = await POST(jamieRequest(jamiePayload()), routeContext());

    expect(response.status).toBe(200);
    expect(getDefaultBrainForUser).not.toHaveBeenCalled();
    expect(upsertBrainSourceItemAndEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        brainRefs: ["goat_brain_a", "goat_brain_b"],
      }),
    );
  });

  it("persists the item but enqueues nothing when all brain sources are disabled", async () => {
    vi.mocked(listEnabledBrainRefsForIntegration).mockResolvedValue([]);
    vi.mocked(hasAnyBrainSourceForIntegration).mockResolvedValue(true);
    vi.mocked(upsertBrainSourceItemAndEnqueue).mockResolvedValue({
      sourceItemId: "gbsrc_123",
      jobId: null,
      jobIds: [],
      enqueued: false,
      skipped: false,
    });

    const response = await POST(jamieRequest(jamiePayload()), routeContext());
    const body = (await response.json()) as { ok?: boolean; enqueued?: boolean };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, enqueued: false });
    expect(getDefaultBrainForUser).not.toHaveBeenCalled();
    expect(upsertBrainSourceItemAndEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({ brainRefs: [] }),
    );
    expect(triggerBrainIngestWake).not.toHaveBeenCalled();
  });
});

function routeContext() {
  return { params: Promise.resolve({ integrationId: "gint_123" }) };
}

function jamieRequest(payload: unknown, options: { event?: string; secret?: string } = {}) {
  return new Request("https://app.test/api/webhooks/jamie/gint_123", {
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
