import { createHmac } from "node:crypto";
import {
  insertAttioObjectEvents,
  listAttioIntegrationsForWorkspace,
  listEnabledAttioBrainSourceRoutes,
} from "@opencompany/db/attio";
import { loadIntegrationCredential } from "@opencompany/db/integrations";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAttioIngress } from "./attio-ingress";

vi.mock("@opencompany/db/attio", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  insertAttioObjectEvents: vi.fn(),
  listEnabledAttioBrainSourceRoutes: vi.fn(),
  listAttioIntegrationsForWorkspace: vi.fn(),
}));
vi.mock("@opencompany/db/integrations", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadIntegrationCredential: vi.fn(),
}));

const WORKSPACE_ID = "14beef7a-99f7-4534-a87e-70b564330a4c";
const DEAL_OBJECT_ID = "97052eb9-e65e-443f-a297-f2d9a4a7f795";
const PERSON_OBJECT_ID = "1f0f04a9-64f7-4dbd-b8b2-6a89e9e1c0aa";
const RECORD_ID = "bf071e1f-6035-429d-b874-d83ea64ea13b";
const WEBHOOK_SECRET = "attio-webhook-secret";
const sentinelDb = { sentinel: "db" };

function ingress() {
  return createAttioIngress({ db: sentinelDb });
}

describe("Attio ingress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listAttioIntegrationsForWorkspace).mockResolvedValue([
      { id: "gint_attio_1", userWorkosId: "user_1", status: "connected" },
    ] as never);
    vi.mocked(loadIntegrationCredential).mockResolvedValue({
      payload: {
        apiKey: "attio-key",
        workspaceId: WORKSPACE_ID,
        webhookId: "wh_1",
        webhookSecret: WEBHOOK_SECRET,
        objectIdBySlug: { deal: DEAL_OBJECT_ID, person: PERSON_OBJECT_ID },
        createdAt: "2026-07-17T00:00:00.000Z",
      },
      expiresAt: null,
      lastRotatedAt: null,
      updatedAt: new Date(),
      encryptionKeyVersion: 1,
    } as never);
    vi.mocked(listEnabledAttioBrainSourceRoutes).mockResolvedValue([
      {
        integrationId: "gint_attio_1",
        brainRef: "gbrain_1",
        config: {
          objectTypes: [{ id: "deal" }],
          events: [{ id: "object_updated" }, { id: "note_added" }],
        },
      },
    ] as never);
    vi.mocked(insertAttioObjectEvents).mockImplementation(
      async (events: readonly unknown[]) => events.length,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("buffers a matched record update through the injected db", async () => {
    const response = await ingress().webhook(attioRequest(recordUpdatedEvent(DEAL_OBJECT_ID)));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, buffered: 1 });
    expect(listAttioIntegrationsForWorkspace).toHaveBeenCalledWith(
      WORKSPACE_ID,
      expect.objectContaining({ sentinel: "db" }),
    );
    expect(loadIntegrationCredential).toHaveBeenCalledWith(
      expect.objectContaining({ integrationId: "gint_attio_1", db: sentinelDb }),
    );
    expect(insertAttioObjectEvents).toHaveBeenCalledWith(
      [
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
      ],
      expect.objectContaining({ sentinel: "db" }),
    );
  });

  it("always ignores Attio system record updates", async () => {
    const ignored = await ingress().webhook(
      attioRequest(recordUpdatedEvent(DEAL_OBJECT_ID, "system"), "system-update"),
    );

    expect(ignored.status).toBe(200);
    await expect(ignored.json()).resolves.toEqual({ ok: true, buffered: 0 });
    expect(insertAttioObjectEvents).toHaveBeenLastCalledWith([], sentinelDb);
  });

  it("uses Attio's idempotency key as the stable retry identity", async () => {
    await ingress().webhook(attioRequest(recordUpdatedEvent(DEAL_OBJECT_ID), "retry-stable"));
    await ingress().webhook(attioRequest(recordUpdatedEvent(DEAL_OBJECT_ID), "retry-stable"));

    const first = vi.mocked(insertAttioObjectEvents).mock.calls[0]?.[0]?.[0] as
      | { deliveryId?: string }
      | undefined;
    const second = vi.mocked(insertAttioObjectEvents).mock.calls[1]?.[0]?.[0] as
      | { deliveryId?: string }
      | undefined;
    expect(first?.deliveryId).toBe("delivery:retry-stable:0");
    expect(second?.deliveryId).toBe(first?.deliveryId);
  });

  it("keys note events on the stable note id", async () => {
    const response = await ingress().webhook(
      attioRequest({
        event_type: "note.created",
        id: { workspace_id: WORKSPACE_ID, note_id: "note_1" },
        parent_object_id: DEAL_OBJECT_ID,
        parent_record_id: RECORD_ID,
        actor: { type: "workspace-member", id: "member_1" },
      }),
    );

    expect(response.status).toBe(200);
    expect(insertAttioObjectEvents).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          action: "note",
          noteId: "note_1",
          deliveryId: "note:note_1",
        }),
      ],
      expect.objectContaining({ sentinel: "db" }),
    );
  });

  it("ignores events for unselected object types", async () => {
    const response = await ingress().webhook(attioRequest(recordUpdatedEvent(PERSON_OBJECT_ID)));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, buffered: 0 });
    expect(insertAttioObjectEvents).toHaveBeenCalledWith([], sentinelDb);
  });

  it("rejects deliveries whose webhook id matches no integration", async () => {
    vi.mocked(loadIntegrationCredential).mockResolvedValue(null);

    const response = await ingress().webhook(attioRequest(recordUpdatedEvent(DEAL_OBJECT_ID)));

    expect(response.status).toBe(401);
    expect(insertAttioObjectEvents).not.toHaveBeenCalled();
  });

  it("rejects deliveries with an invalid signature", async () => {
    const response = await ingress().webhook(
      attioRequest(recordUpdatedEvent(DEAL_OBJECT_ID), "delivery_1", "deadbeef"),
    );

    expect(response.status).toBe(401);
    expect(insertAttioObjectEvents).not.toHaveBeenCalled();
  });

  it("returns a retryable response when buffering fails", async () => {
    vi.mocked(insertAttioObjectEvents).mockRejectedValueOnce(new Error("database unavailable"));

    const response = await ingress().webhook(attioRequest(recordUpdatedEvent(DEAL_OBJECT_ID)));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "Unable to buffer Attio events." });
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

function attioRequest(
  event: Record<string, unknown>,
  idempotencyKey = "delivery_1",
  signature?: string,
) {
  const rawBody = JSON.stringify({ webhook_id: "wh_1", events: [event] });
  return new Request("https://api.example.com/webhooks/attio/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "attio-signature":
        signature ?? createHmac("sha256", WEBHOOK_SECRET).update(rawBody, "utf8").digest("hex"),
      "idempotency-key": idempotencyKey,
    },
    body: rawBody,
  });
}
