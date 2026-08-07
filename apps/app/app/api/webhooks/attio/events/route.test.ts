import {
  insertGoatAttioObjectEvents,
  listEnabledGoatAttioBrainSourceRoutes,
  listGoatAttioIntegrationsForWorkspace,
} from "@opencompany/db/attio";
import { loadGoatIntegrationCredential } from "@opencompany/db/integrations";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyGoatAttioWebhookSignature } from "@/lib/integrations/attio-signature";
import { POST } from "./route";

vi.mock("@opencompany/db/attio", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  insertGoatAttioObjectEvents: vi.fn(),
  listEnabledGoatAttioBrainSourceRoutes: vi.fn(),
  listGoatAttioIntegrationsForWorkspace: vi.fn(),
}));
vi.mock("@opencompany/db/integrations", () => ({
  loadGoatIntegrationCredential: vi.fn(),
}));
vi.mock("@/lib/integrations/attio-signature", () => ({
  verifyGoatAttioWebhookSignature: vi.fn(),
}));

const WORKSPACE_ID = "14beef7a-99f7-4534-a87e-70b564330a4c";
const DEAL_OBJECT_ID = "97052eb9-e65e-443f-a297-f2d9a4a7f795";
const PERSON_OBJECT_ID = "1f0f04a9-64f7-4dbd-b8b2-6a89e9e1c0aa";
const RECORD_ID = "bf071e1f-6035-429d-b874-d83ea64ea13b";

describe("POST /api/webhooks/attio/events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(verifyGoatAttioWebhookSignature).mockReturnValue(true);
    vi.mocked(listGoatAttioIntegrationsForWorkspace).mockResolvedValue([
      { id: "gint_attio_1", userWorkosId: "user_1", status: "connected" },
    ]);
    vi.mocked(loadGoatIntegrationCredential).mockResolvedValue({
      payload: {
        apiKey: "attio-key",
        workspaceId: WORKSPACE_ID,
        webhookId: "wh_1",
        webhookSecret: "secret",
        objectIdBySlug: { deal: DEAL_OBJECT_ID, person: PERSON_OBJECT_ID },
        createdAt: "2026-07-17T00:00:00.000Z",
      },
      expiresAt: null,
      lastRotatedAt: null,
      updatedAt: new Date(),
      encryptionKeyVersion: 1,
    } as never);
    vi.mocked(listEnabledGoatAttioBrainSourceRoutes).mockResolvedValue([
      {
        integrationId: "gint_attio_1",
        brainRef: "gbrain_1",
        config: {
          objectTypes: [{ id: "deal" }],
          events: [{ id: "object_updated" }, { id: "note_added" }],
        },
      },
    ]);
    vi.mocked(insertGoatAttioObjectEvents).mockImplementation(async (events) => events.length);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("buffers a matched record update for the webhook's integration", async () => {
    const response = await POST(attioRequest(recordUpdatedEvent(DEAL_OBJECT_ID)));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, buffered: 1 });
    expect(insertGoatAttioObjectEvents).toHaveBeenCalledWith([
      expect.objectContaining({
        integrationId: "gint_attio_1",
        userWorkosId: "user_1",
        workspaceId: WORKSPACE_ID,
        objectType: "deal",
        recordId: RECORD_ID,
        action: "update",
        attributeId: "attr_1",
        deliveryId: "delivery:delivery_1:0",
      }),
    ]);
  });

  it("always ignores Attio system record updates", async () => {
    const ignored = await POST(
      attioRequest(recordUpdatedEvent(DEAL_OBJECT_ID, "system"), "system-update"),
    );

    expect(ignored.status).toBe(200);
    await expect(ignored.json()).resolves.toEqual({ ok: true, buffered: 0 });
    expect(insertGoatAttioObjectEvents).toHaveBeenLastCalledWith([]);
  });

  it("uses Attio's idempotency key as the stable retry identity", async () => {
    await POST(attioRequest(recordUpdatedEvent(DEAL_OBJECT_ID), "retry-stable"));
    await POST(attioRequest(recordUpdatedEvent(DEAL_OBJECT_ID), "retry-stable"));

    const first = vi.mocked(insertGoatAttioObjectEvents).mock.calls[0]?.[0]?.[0];
    const second = vi.mocked(insertGoatAttioObjectEvents).mock.calls[1]?.[0]?.[0];
    expect(first?.deliveryId).toBe("delivery:retry-stable:0");
    expect(second?.deliveryId).toBe(first?.deliveryId);
  });

  it("keys note events on the stable note id", async () => {
    const response = await POST(
      attioRequest({
        event_type: "note.created",
        id: { workspace_id: WORKSPACE_ID, note_id: "note_1" },
        parent_object_id: DEAL_OBJECT_ID,
        parent_record_id: RECORD_ID,
        actor: { type: "workspace-member", id: "member_1" },
      }),
    );

    expect(response.status).toBe(200);
    expect(insertGoatAttioObjectEvents).toHaveBeenCalledWith([
      expect.objectContaining({
        action: "note",
        noteId: "note_1",
        deliveryId: "note:note_1",
      }),
    ]);
  });

  it("ignores events for unselected object types", async () => {
    const response = await POST(attioRequest(recordUpdatedEvent(PERSON_OBJECT_ID)));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, buffered: 0 });
    expect(insertGoatAttioObjectEvents).toHaveBeenCalledWith([]);
  });

  it("rejects deliveries whose webhook id matches no integration", async () => {
    vi.mocked(loadGoatIntegrationCredential).mockResolvedValue(null);

    const response = await POST(attioRequest(recordUpdatedEvent(DEAL_OBJECT_ID)));

    expect(response.status).toBe(401);
    expect(insertGoatAttioObjectEvents).not.toHaveBeenCalled();
  });

  it("rejects deliveries with an invalid signature", async () => {
    vi.mocked(verifyGoatAttioWebhookSignature).mockReturnValue(false);

    const response = await POST(attioRequest(recordUpdatedEvent(DEAL_OBJECT_ID)));

    expect(response.status).toBe(401);
    expect(insertGoatAttioObjectEvents).not.toHaveBeenCalled();
  });

  it("returns a retryable response when buffering fails", async () => {
    vi.mocked(insertGoatAttioObjectEvents).mockRejectedValueOnce(new Error("database unavailable"));

    const response = await POST(attioRequest(recordUpdatedEvent(DEAL_OBJECT_ID)));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "Unable to buffer Attio events." });
    expect(console.error).toHaveBeenCalledWith(
      "[goat-attio] Failed to process Attio events",
      expect.objectContaining({ eventCount: 1, error: "database unavailable" }),
    );
  });
});

function recordUpdatedEvent(objectId: string, actorType = "workspace-member") {
  return {
    event_type: "record.updated",
    id: {
      workspace_id: WORKSPACE_ID,
      object_id: objectId,
      record_id: RECORD_ID,
      attribute_id: "attr_1",
    },
    actor: { type: actorType, id: "member_1" },
  };
}

function attioRequest(event: Record<string, unknown>, idempotencyKey = "delivery_1") {
  return new Request("https://goat.example.com/api/webhooks/attio/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "attio-signature": "valid-signature",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify({ webhook_id: "wh_1", events: [event] }),
  });
}
