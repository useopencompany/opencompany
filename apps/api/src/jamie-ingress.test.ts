import { upsertGoatBrainSourceItemAndEnqueue } from "@opencompany/db/goat-brain-ingest";
import {
  hasAnyBrainSourceForIntegration,
  listEnabledBrainRefsForIntegration,
} from "@opencompany/db/goat-brain-sources";
import { getDefaultGoatBrainForUser } from "@opencompany/db/goat-workspaces";
import {
  hashGoatJamieWebhookApiKey,
  loadGoatJamieWebhookContext,
  loadGoatJamieWebhookContextForApiKey,
  markGoatJamieWebhookConnected,
} from "@opencompany/goat-agent/integrations/jamie";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createJamieIngress } from "./jamie-ingress";

vi.mock("@opencompany/goat-agent/integrations/jamie", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadGoatJamieWebhookContext: vi.fn(),
  loadGoatJamieWebhookContextForApiKey: vi.fn(),
  markGoatJamieWebhookConnected: vi.fn(),
}));
vi.mock("@opencompany/db/goat-brain-ingest", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  upsertGoatBrainSourceItemAndEnqueue: vi.fn(),
}));
vi.mock("@opencompany/db/goat-brain-sources", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hasAnyBrainSourceForIntegration: vi.fn(),
  listEnabledBrainRefsForIntegration: vi.fn(),
}));
vi.mock("@opencompany/db/goat-workspaces", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDefaultGoatBrainForUser: vi.fn(),
}));

const sentinelDb = { sentinel: "db" };

function ingress() {
  return createJamieIngress({ db: sentinelDb });
}

describe("Jamie ingress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadGoatJamieWebhookContextForApiKey).mockResolvedValue(webhookContext());
    vi.mocked(loadGoatJamieWebhookContext).mockResolvedValue(webhookContext());
    vi.mocked(upsertGoatBrainSourceItemAndEnqueue).mockResolvedValue({
      sourceItemId: "gbsrc_123",
      jobId: "gbjob_123",
      jobIds: ["gbjob_123"],
      enqueued: true,
      skipped: false,
    } as never);
    vi.mocked(listEnabledBrainRefsForIntegration).mockResolvedValue([]);
    vi.mocked(hasAnyBrainSourceForIntegration).mockResolvedValue(false);
    vi.mocked(getDefaultGoatBrainForUser).mockResolvedValue({ id: "gbrain_123" } as never);
    vi.mocked(markGoatJamieWebhookConnected).mockResolvedValue(undefined);
  });

  it("resolves the global path by API key and enqueues through the injected db", async () => {
    const response = await ingress().webhook(jamieRequest(jamiePayload()));
    const body = (await response.json()) as { ok?: boolean; enqueued?: boolean };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, enqueued: true });
    expect(loadGoatJamieWebhookContextForApiKey).toHaveBeenCalledWith(jamieApiKey(), sentinelDb);
    expect(listEnabledBrainRefsForIntegration).toHaveBeenCalledWith("gint_123", sentinelDb);
    expect(getDefaultGoatBrainForUser).toHaveBeenCalledWith("user_123", { db: sentinelDb });
    expect(upsertGoatBrainSourceItemAndEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        userWorkosId: "user_123",
        sourceConnectionId: "gint_123",
        integrationId: "gint_123",
        rawPayload: jamiePayload(),
        kind: "brain_agent_ingest",
        brainRefs: ["gbrain_123"],
        db: sentinelDb,
        item: expect.objectContaining({
          sourceProvider: "jamie",
          sourceType: "meeting",
          externalId: "calendar_event_123",
        }),
      }),
    );
    expect(markGoatJamieWebhookConnected).toHaveBeenCalledWith(
      expect.objectContaining({ integrationId: "gint_123", userWorkosId: "user_123" }),
      sentinelDb,
    );
  });

  it("fans out to every enabled brain source and skips the default-brain lookup", async () => {
    vi.mocked(listEnabledBrainRefsForIntegration).mockResolvedValue(["gbrain_a", "gbrain_b"]);

    const response = await ingress().webhook(jamieRequest(jamiePayload()));

    expect(response.status).toBe(200);
    expect(getDefaultGoatBrainForUser).not.toHaveBeenCalled();
    expect(hasAnyBrainSourceForIntegration).not.toHaveBeenCalled();
    expect(upsertGoatBrainSourceItemAndEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({ brainRefs: ["gbrain_a", "gbrain_b"] }),
    );
  });

  it("persists the item but enqueues nothing when all brain sources are disabled", async () => {
    vi.mocked(listEnabledBrainRefsForIntegration).mockResolvedValue([]);
    vi.mocked(hasAnyBrainSourceForIntegration).mockResolvedValue(true);

    const response = await ingress().webhook(jamieRequest(jamiePayload()));

    expect(response.status).toBe(200);
    expect(getDefaultGoatBrainForUser).not.toHaveBeenCalled();
    expect(upsertGoatBrainSourceItemAndEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({ brainRefs: [] }),
    );
  });

  it("returns 401 on the global path when the API key resolves no integration", async () => {
    vi.mocked(loadGoatJamieWebhookContextForApiKey).mockResolvedValue(null);

    const response = await ingress().webhook(jamieRequest(jamiePayload()));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Invalid Jamie webhook API key." });
    expect(upsertGoatBrainSourceItemAndEnqueue).not.toHaveBeenCalled();
  });

  it("returns 401 when the delivery's API key does not match the stored hash", async () => {
    const response = await ingress().webhook(
      jamieRequest(jamiePayload(), { secret: `${jamieApiKey().slice(0, -1)}f` }),
    );

    expect(response.status).toBe(401);
    expect(upsertGoatBrainSourceItemAndEnqueue).not.toHaveBeenCalled();
  });

  it("returns 404 on the per-integration path for an unknown integration", async () => {
    vi.mocked(loadGoatJamieWebhookContext).mockResolvedValue(null);

    const response = await ingress().webhookForIntegration(
      "gint_missing",
      jamieRequest(jamiePayload()),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Jamie integration not found." });
    expect(loadGoatJamieWebhookContext).toHaveBeenCalledWith("gint_missing", sentinelDb);
    expect(upsertGoatBrainSourceItemAndEnqueue).not.toHaveBeenCalled();
  });

  it("returns 400 for unsupported Jamie events", async () => {
    const response = await ingress().webhook(
      jamieRequest(jamiePayload(), { event: "meeting.started" }),
    );

    expect(response.status).toBe(400);
    expect(upsertGoatBrainSourceItemAndEnqueue).not.toHaveBeenCalled();
  });
});

function webhookContext() {
  return {
    integrationId: "gint_123",
    userWorkosId: "user_123",
    apiKeyHash: hashGoatJamieWebhookApiKey(jamieApiKey()),
    legacySecretHash: null,
  };
}

function jamieRequest(payload: unknown, options: { event?: string; secret?: string } = {}) {
  return new Request("https://api.example.com/webhooks/jamie", {
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
