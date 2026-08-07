import {
  insertGoatHubspotObjectEvents,
  listEnabledGoatHubspotBrainSourceRoutes,
  listGoatHubspotIntegrationsForPortal,
} from "@opencompany/db/hubspot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyGoatHubspotWebhookSignature } from "@/lib/integrations/hubspot-signature";
import { POST } from "./route";

vi.mock("@opencompany/db/hubspot", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  insertGoatHubspotObjectEvents: vi.fn(),
  listEnabledGoatHubspotBrainSourceRoutes: vi.fn(),
  listGoatHubspotIntegrationsForPortal: vi.fn(),
}));
vi.mock("@/lib/integrations/hubspot-signature", () => ({
  verifyGoatHubspotWebhookSignature: vi.fn(),
}));
vi.mock("@/lib/workos", () => ({
  getGoatAppUrl: () => "https://goat.example.com",
}));

describe("POST /api/webhooks/hubspot/events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(verifyGoatHubspotWebhookSignature).mockReturnValue(true);
    vi.mocked(listGoatHubspotIntegrationsForPortal).mockResolvedValue([
      { id: "gint_hubspot_1", userWorkosId: "user_1", status: "connected" },
    ]);
    vi.mocked(listEnabledGoatHubspotBrainSourceRoutes).mockResolvedValue([
      {
        integrationId: "gint_hubspot_1",
        brainRef: "gbrain_1",
        config: {
          objectTypes: [{ id: "deal" }],
          events: [{ id: "object_stage_changed" }],
        },
      },
    ]);
    vi.mocked(insertGoatHubspotObjectEvents).mockResolvedValue(1);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a retryable response when buffering fails", async () => {
    vi.mocked(insertGoatHubspotObjectEvents).mockRejectedValueOnce(
      new Error("database unavailable"),
    );

    const response = await POST(hubspotRequest());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "Unable to buffer HubSpot events." });
    expect(console.error).toHaveBeenCalledWith(
      "[goat-hubspot] Failed to process HubSpot events",
      expect.objectContaining({ eventCount: 1, error: "database unavailable" }),
    );
  });

  it("keeps successful buffering responses unchanged", async () => {
    const response = await POST(hubspotRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, buffered: 1 });
  });
});

function hubspotRequest() {
  return new Request("https://goat.example.com/api/webhooks/hubspot/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hubspot-signature-v3": "valid-signature",
      "x-hubspot-request-timestamp": String(Date.now()),
    },
    body: JSON.stringify([
      {
        eventId: 123,
        portalId: 62515,
        occurredAt: Date.now(),
        subscriptionType: "deal.propertyChange",
        objectId: 9876,
        propertyName: "dealstage",
        propertyValue: "closedwon",
      },
    ]),
  });
}
