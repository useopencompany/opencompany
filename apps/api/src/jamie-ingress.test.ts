import {
  hashJamieWebhookApiKey,
  loadJamieWebhookContext,
  loadJamieWebhookContextForApiKey,
  markJamieWebhookConnected,
} from "@opencompany/agent/integrations/jamie";
import { upsertBrainSourceItemAndEnqueue } from "@opencompany/db/brain-ingest";
import {
  hasAnyBrainSourceForIntegration,
  listEnabledBrainRefsForIntegration,
} from "@opencompany/db/brain-sources";
import {
  attributeWikiSourceEventClaims,
  claimWikiSourceEvents,
} from "@opencompany/db/wiki-event-claims";
import { upsertWikiSourceItemAndEnqueue } from "@opencompany/db/wiki-ingest";
import { listEnabledWikiSourcesForIntegration } from "@opencompany/db/wiki-sources";
import { getDefaultBrainForUser } from "@opencompany/db/workspaces";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createJamieIngress } from "./jamie-ingress";

vi.mock("@opencompany/agent/integrations/jamie", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadJamieWebhookContext: vi.fn(),
  loadJamieWebhookContextForApiKey: vi.fn(),
  markJamieWebhookConnected: vi.fn(),
}));
vi.mock("@opencompany/db/brain-ingest", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  upsertBrainSourceItemAndEnqueue: vi.fn(),
}));
vi.mock("@opencompany/db/brain-sources", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hasAnyBrainSourceForIntegration: vi.fn(),
  listEnabledBrainRefsForIntegration: vi.fn(),
}));
vi.mock("@opencompany/db/workspaces", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDefaultBrainForUser: vi.fn(),
}));
vi.mock("@opencompany/db/wiki-event-claims", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  attributeWikiSourceEventClaims: vi.fn(),
  claimWikiSourceEvents: vi.fn(),
}));
vi.mock("@opencompany/db/wiki-ingest", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  upsertWikiSourceItemAndEnqueue: vi.fn(),
}));
vi.mock("@opencompany/db/wiki-sources", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listEnabledWikiSourcesForIntegration: vi.fn(),
}));

const sentinelDb = { sentinel: "db" };

function ingress(wakeWikiIngest?: () => Promise<unknown>) {
  return createJamieIngress({ db: sentinelDb, ...(wakeWikiIngest ? { wakeWikiIngest } : {}) });
}

describe("Jamie ingress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadJamieWebhookContextForApiKey).mockResolvedValue(webhookContext());
    vi.mocked(loadJamieWebhookContext).mockResolvedValue(webhookContext());
    vi.mocked(upsertBrainSourceItemAndEnqueue).mockResolvedValue({
      sourceItemId: "gbsrc_123",
      jobId: "gbjob_123",
      jobIds: ["gbjob_123"],
      enqueued: true,
      skipped: false,
    } as never);
    vi.mocked(listEnabledBrainRefsForIntegration).mockResolvedValue([]);
    vi.mocked(hasAnyBrainSourceForIntegration).mockResolvedValue(false);
    vi.mocked(getDefaultBrainForUser).mockResolvedValue({ id: "gbrain_123" } as never);
    vi.mocked(markJamieWebhookConnected).mockResolvedValue(undefined);
    vi.mocked(listEnabledWikiSourcesForIntegration).mockResolvedValue([]);
    vi.mocked(claimWikiSourceEvents).mockResolvedValue({
      claimedCount: 1,
      claimedEventKeys: ["meeting:calendar_event_123"],
    });
    vi.mocked(upsertWikiSourceItemAndEnqueue).mockResolvedValue({
      sourceItemId: "gwsrc_123",
      jobId: "gwjob_123",
      enqueued: true,
      skipped: false,
    });
    vi.mocked(attributeWikiSourceEventClaims).mockResolvedValue(undefined);
  });

  it("resolves the global path by API key and enqueues through the injected db", async () => {
    const response = await ingress().webhook(jamieRequest(jamiePayload()));
    const body = (await response.json()) as { ok?: boolean; enqueued?: boolean };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, enqueued: true });
    expect(loadJamieWebhookContextForApiKey).toHaveBeenCalledWith(jamieApiKey(), sentinelDb);
    expect(listEnabledBrainRefsForIntegration).toHaveBeenCalledWith("gint_123", sentinelDb);
    expect(getDefaultBrainForUser).toHaveBeenCalledWith("user_123", { db: sentinelDb });
    expect(upsertBrainSourceItemAndEnqueue).toHaveBeenCalledWith(
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
    expect(markJamieWebhookConnected).toHaveBeenCalledWith(
      expect.objectContaining({ integrationId: "gint_123", userWorkosId: "user_123" }),
      sentinelDb,
    );
    expect(claimWikiSourceEvents).not.toHaveBeenCalled();
    expect(upsertWikiSourceItemAndEnqueue).not.toHaveBeenCalled();
  });

  it("claims and enqueues an enabled Jamie wiki source with the brain-normalized payload", async () => {
    vi.mocked(listEnabledWikiSourcesForIntegration).mockResolvedValue([
      {
        workspaceId: "workspace_1",
        provider: "jamie",
        integrationId: "gint_123",
      },
    ] as never);
    const wakeWikiIngest = vi.fn(async () => undefined);

    const response = await ingress(wakeWikiIngest).webhook(jamieRequest(jamiePayload()));

    expect(response.status).toBe(200);
    expect(claimWikiSourceEvents).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      sourceProvider: "jamie",
      eventKeys: ["meeting:calendar_event_123"],
      db: sentinelDb,
    });
    const brainItem = vi.mocked(upsertBrainSourceItemAndEnqueue).mock.calls[0]?.[0].item;
    expect(upsertWikiSourceItemAndEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace_1",
        sourceConnectionId: "gint_123",
        integrationId: "gint_123",
        item: brainItem,
        rawPayload: jamiePayload(),
        db: sentinelDb,
      }),
    );
    expect(attributeWikiSourceEventClaims).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace_1",
        eventKeys: ["meeting:calendar_event_123"],
        sourceItemId: "gwsrc_123",
      }),
    );
    expect(wakeWikiIngest).toHaveBeenCalledOnce();
  });

  it("does not enqueue or wake when the workspace already claimed the Jamie meeting", async () => {
    vi.mocked(listEnabledWikiSourcesForIntegration).mockResolvedValue([
      {
        workspaceId: "workspace_1",
        provider: "jamie",
        integrationId: "gint_123",
      },
    ] as never);
    vi.mocked(claimWikiSourceEvents).mockResolvedValue({
      claimedCount: 0,
      claimedEventKeys: [],
    });
    const wakeWikiIngest = vi.fn(async () => undefined);

    const response = await ingress(wakeWikiIngest).webhook(jamieRequest(jamiePayload()));

    expect(response.status).toBe(200);
    expect(upsertWikiSourceItemAndEnqueue).not.toHaveBeenCalled();
    expect(wakeWikiIngest).not.toHaveBeenCalled();
    expect(upsertBrainSourceItemAndEnqueue).toHaveBeenCalledOnce();
  });

  it("keeps the successful webhook response when the best-effort runner wake fails", async () => {
    vi.mocked(listEnabledWikiSourcesForIntegration).mockResolvedValue([
      {
        workspaceId: "workspace_1",
        provider: "jamie",
        integrationId: "gint_123",
      },
    ] as never);
    const wakeWikiIngest = vi.fn(async () => {
      throw new Error("runner unavailable");
    });

    const response = await ingress(wakeWikiIngest).webhook(jamieRequest(jamiePayload()));

    expect(response.status).toBe(200);
    expect(wakeWikiIngest).toHaveBeenCalledOnce();
  });

  it("fans out to every enabled brain source and skips the default-brain lookup", async () => {
    vi.mocked(listEnabledBrainRefsForIntegration).mockResolvedValue(["gbrain_a", "gbrain_b"]);

    const response = await ingress().webhook(jamieRequest(jamiePayload()));

    expect(response.status).toBe(200);
    expect(getDefaultBrainForUser).not.toHaveBeenCalled();
    expect(hasAnyBrainSourceForIntegration).not.toHaveBeenCalled();
    expect(upsertBrainSourceItemAndEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({ brainRefs: ["gbrain_a", "gbrain_b"] }),
    );
  });

  it("persists the item but enqueues nothing when all brain sources are disabled", async () => {
    vi.mocked(listEnabledBrainRefsForIntegration).mockResolvedValue([]);
    vi.mocked(hasAnyBrainSourceForIntegration).mockResolvedValue(true);

    const response = await ingress().webhook(jamieRequest(jamiePayload()));

    expect(response.status).toBe(200);
    expect(getDefaultBrainForUser).not.toHaveBeenCalled();
    expect(upsertBrainSourceItemAndEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({ brainRefs: [] }),
    );
  });

  it("returns 401 on the global path when the API key resolves no integration", async () => {
    vi.mocked(loadJamieWebhookContextForApiKey).mockResolvedValue(null);

    const response = await ingress().webhook(jamieRequest(jamiePayload()));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Invalid Jamie webhook API key." });
    expect(upsertBrainSourceItemAndEnqueue).not.toHaveBeenCalled();
  });

  it("returns 401 when the delivery's API key does not match the stored hash", async () => {
    const response = await ingress().webhook(
      jamieRequest(jamiePayload(), { secret: `${jamieApiKey().slice(0, -1)}f` }),
    );

    expect(response.status).toBe(401);
    expect(upsertBrainSourceItemAndEnqueue).not.toHaveBeenCalled();
  });

  it("returns 404 on the per-integration path for an unknown integration", async () => {
    vi.mocked(loadJamieWebhookContext).mockResolvedValue(null);

    const response = await ingress().webhookForIntegration(
      "gint_missing",
      jamieRequest(jamiePayload()),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Jamie integration not found." });
    expect(loadJamieWebhookContext).toHaveBeenCalledWith("gint_missing", sentinelDb);
    expect(upsertBrainSourceItemAndEnqueue).not.toHaveBeenCalled();
  });

  it("returns 400 for unsupported Jamie events", async () => {
    const response = await ingress().webhook(
      jamieRequest(jamiePayload(), { event: "meeting.started" }),
    );

    expect(response.status).toBe(400);
    expect(upsertBrainSourceItemAndEnqueue).not.toHaveBeenCalled();
  });
});

function webhookContext() {
  return {
    integrationId: "gint_123",
    userWorkosId: "user_123",
    apiKeyHash: hashJamieWebhookApiKey(jamieApiKey()),
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
