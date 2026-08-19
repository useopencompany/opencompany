import { createHmac } from "node:crypto";
import { createHubspotIngestState } from "@opencompany/agent/integrations/hubspot-ingest";
import {
  insertHubspotObjectEvents,
  listEnabledHubspotBrainSourceRoutes,
  listHubspotIntegrationsForPortal,
} from "@opencompany/db/hubspot";
import { listWorkspacesForUser } from "@opencompany/db/workspaces";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./errors";
import { createHubspotIngress } from "./hubspot-ingress";

vi.mock("@opencompany/db/hubspot", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  insertHubspotObjectEvents: vi.fn(),
  listEnabledHubspotBrainSourceRoutes: vi.fn(),
  listHubspotIntegrationsForPortal: vi.fn(),
}));
vi.mock("@opencompany/db/workspaces", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listWorkspacesForUser: vi.fn(),
}));

const CLIENT_SECRET = "hubspot-client-secret";
// HubSpot signs the URI it delivered to: the web origin URL, which relays to
// the API. The parity-critical case below verifies against this canonical web
// URL while the observed request URL is the API origin.
const SIGNED_WEB_URI = "https://opencompany.example.com/api/webhooks/hubspot/events";
const sentinelDb = { sentinel: "db" };

function ingress(overrides: { authError?: ApiError } = {}) {
  vi.mocked(listWorkspacesForUser).mockResolvedValue([
    { workspace: { id: "workspace_1", workosOrganizationId: null }, role: "admin" },
  ] as never);
  return createHubspotIngress({
    db: sentinelDb,
    identify: async () => {
      if (overrides.authError) throw overrides.authError;
      return {
        userId: "user_1",
        organizationId: null,
        method: "session",
        activeWorkspaceId: null,
        activeBrainId: null,
      };
    },
  });
}

function signedRequest(
  events: unknown[],
  overrides: { signature?: string; timestamp?: string } = {},
) {
  const rawBody = JSON.stringify(events);
  const timestamp = overrides.timestamp ?? String(Date.now());
  const signature =
    overrides.signature ??
    createHmac("sha256", CLIENT_SECRET)
      .update(`POST${SIGNED_WEB_URI}${rawBody}${timestamp}`)
      .digest("base64");
  return new Request("https://api.example.com/webhooks/hubspot/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hubspot-signature-v3": signature,
      "x-hubspot-request-timestamp": timestamp,
    },
    body: rawBody,
  });
}

function dealEvent(overrides: Record<string, unknown> = {}) {
  return {
    eventId: 123,
    portalId: 62515,
    occurredAt: Date.now(),
    subscriptionType: "deal.propertyChange",
    objectId: 9876,
    propertyName: "dealstage",
    propertyValue: "closedwon",
    ...overrides,
  };
}

describe("HubSpot ingress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OPENCOMPANY_NEXT_PUBLIC_APP_URL", "https://opencompany.example.com");
    vi.stubEnv("OPENCOMPANY_HUBSPOT_CLIENT_ID", "hubspot-client");
    vi.stubEnv("OPENCOMPANY_HUBSPOT_CLIENT_SECRET", CLIENT_SECRET);
    vi.stubEnv("OPENCOMPANY_HUBSPOT_STATE_SECRET", "hubspot-state-secret-hubspot-state-secret");
    vi.mocked(listHubspotIntegrationsForPortal).mockResolvedValue([
      { id: "gint_hubspot_1", userWorkosId: "user_1", status: "connected" },
    ] as never);
    vi.mocked(listEnabledHubspotBrainSourceRoutes).mockResolvedValue([
      {
        integrationId: "gint_hubspot_1",
        brainRef: "gbrain_1",
        config: {
          objectTypes: [{ id: "deal" }],
          events: [{ id: "object_stage_changed" }],
        },
      },
    ] as never);
    vi.mocked(insertHubspotObjectEvents).mockResolvedValue(1);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe("oauth", () => {
    it("redirects an authenticated user to HubSpot authorization with signed state", async () => {
      const response = await ingress().start(
        new Request("https://api.example.com/integrations/hubspot/start?returnTo=/settings"),
      );
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("location") ?? "");
      expect(location.origin).toBe("https://app.hubspot.com");
      expect(location.searchParams.get("client_id")).toBe("hubspot-client");
      expect(location.searchParams.get("state")).toBeTruthy();
    });

    it("redirects anonymous browsers to the web sign-in", async () => {
      const response = await ingress({
        authError: new ApiError(401, "authentication_required", "Authentication required."),
      }).start(new Request("https://api.example.com/integrations/hubspot/start"));
      expect(response.headers.get("location")).toBe("https://opencompany.example.com/signin");
    });

    it("rejects a tampered state with invalid_state", async () => {
      const response = await ingress().callback(
        new Request("https://api.example.com/integrations/hubspot/callback?state=garbage&code=abc"),
      );
      expect(response.headers.get("location")).toBe(
        "https://opencompany.example.com/settings?integration=hubspot&setup=error&reason=invalid_state",
      );
    });

    it("rejects a state minted for another user with session_mismatch", async () => {
      const state = createHubspotIngestState({
        userWorkosId: "user_other",
        returnTo: "/settings",
      });
      const response = await ingress().callback(
        new Request(
          `https://api.example.com/integrations/hubspot/callback?state=${encodeURIComponent(state)}&code=abc`,
        ),
      );
      const location = new URL(response.headers.get("location") ?? "");
      expect(location.searchParams.get("reason")).toBe("session_mismatch");
    });
  });

  describe("webhook", () => {
    it("accepts a v3 signature over the canonical web URL when delivered via the relay", async () => {
      const response = await ingress().webhook(signedRequest([dealEvent()]));
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true, buffered: 1 });
      expect(insertHubspotObjectEvents).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            integrationId: "gint_hubspot_1",
            portalId: "62515",
            objectType: "deal",
            objectId: "9876",
            deliveryId: "123:deal.propertyChange",
            action: "update",
            propertyName: "dealstage",
          }),
        ],
        expect.objectContaining({ sentinel: "db" }),
      );
      expect(listHubspotIntegrationsForPortal).toHaveBeenCalledWith(
        "62515",
        expect.objectContaining({ sentinel: "db" }),
      );
    });

    it("rejects a stale timestamp", async () => {
      const response = await ingress().webhook(
        signedRequest([dealEvent()], { timestamp: String(Date.now() - 10 * 60_000) }),
      );
      expect(response.status).toBe(401);
      expect(insertHubspotObjectEvents).not.toHaveBeenCalled();
    });

    it("rejects a signature that matches no candidate URI", async () => {
      const response = await ingress().webhook(
        signedRequest([dealEvent()], { signature: "bm9wZQ==" }),
      );
      expect(response.status).toBe(401);
      expect(insertHubspotObjectEvents).not.toHaveBeenCalled();
    });

    it("returns a retryable response when buffering fails", async () => {
      vi.mocked(insertHubspotObjectEvents).mockRejectedValueOnce(new Error("database unavailable"));
      const response = await ingress().webhook(signedRequest([dealEvent()]));
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: "Unable to buffer HubSpot events.",
      });
    });
  });
});
