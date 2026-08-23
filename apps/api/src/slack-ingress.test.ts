import { createHmac } from "node:crypto";
import { loadIntegrationCredential, markIntegrationStatus } from "@opencompany/db/integrations";
import {
  insertSlackMessageEvents,
  listEnabledSlackBrainSourceRoutes,
  listSlackIntegrationsForTeam,
} from "@opencompany/db/slack";
import { listWorkspacesForUser } from "@opencompany/db/workspaces";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./errors";
import { createSlackIngress } from "./slack-ingress";

vi.mock("@opencompany/db/integrations", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadIntegrationCredential: vi.fn(),
  markIntegrationStatus: vi.fn(async () => undefined),
}));
vi.mock("@opencompany/db/slack", async (importOriginal) => {
  const original = await importOriginal<typeof import("@opencompany/db/slack")>();
  return {
    ...original,
    insertSlackMessageEvents: vi.fn(),
    listEnabledSlackBrainSourceRoutes: vi.fn(),
    listSlackIntegrationsForTeam: vi.fn(),
  };
});
vi.mock("@opencompany/db/workspaces", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listWorkspacesForUser: vi.fn(),
}));

const SIGNING_SECRET = "test-signing-secret";
const sentinelDb = { sentinel: "db" };

function ingress(overrides: { authError?: ApiError } = {}) {
  vi.mocked(listWorkspacesForUser).mockResolvedValue([
    { workspace: { id: "workspace_1", workosOrganizationId: null }, role: "admin" },
  ] as never);
  return createSlackIngress({
    db: sentinelDb,
    identify: async () => {
      if (overrides.authError) throw overrides.authError;
      return {
        userId: "user_1",
        organizationId: null,
        method: "session",
        credentialKind: "browser_cookie",
        activeWorkspaceId: null,
        activeBrainId: null,
      };
    },
  });
}

function signedRequest(
  payload: unknown,
  overrides: { timestamp?: string; signature?: string } = {},
) {
  const rawBody = JSON.stringify(payload);
  const timestamp = overrides.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature =
    overrides.signature ??
    `v0=${createHmac("sha256", SIGNING_SECRET).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
  return new Request("https://api.example.com/webhooks/slack/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    body: rawBody,
  });
}

function messageEnvelope(event: Record<string, unknown> = {}) {
  return {
    type: "event_callback",
    team_id: "T012345",
    event: {
      type: "message",
      channel: "C09ABC",
      channel_type: "channel",
      user: "U01",
      ts: "1783950060.000100",
      text: "We decided to ship next week.",
      ...event,
    },
  };
}

describe("Slack ingress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OPENCOMPANY_NEXT_PUBLIC_APP_URL", "https://opencompany.example.com");
    vi.stubEnv("OPENCOMPANY_SLACK_SIGNING_SECRET", SIGNING_SECRET);
    vi.stubEnv("OPENCOMPANY_SLACK_CLIENT_ID", "slack-client");
    vi.stubEnv("OPENCOMPANY_SLACK_CLIENT_SECRET", "slack-secret");
    vi.stubEnv("OPENCOMPANY_SLACK_STATE_SECRET", "slack-state-secret-slack-state-secret");
    vi.stubEnv("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", "a".repeat(44));
    vi.mocked(listSlackIntegrationsForTeam).mockResolvedValue([
      { id: "gint_1", userWorkosId: "user_1", status: "connected" },
    ] as never);
    vi.mocked(listEnabledSlackBrainSourceRoutes).mockResolvedValue([
      {
        integrationId: "gint_1",
        brainRef: "gbrain_1",
        config: { channels: [{ id: "C09ABC", name: "product" }] },
      },
    ] as never);
    vi.mocked(insertSlackMessageEvents).mockResolvedValue(1);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe("oauth", () => {
    it("redirects an authenticated user to the Slack consent screen with signed state", async () => {
      const response = await ingress().start(
        new Request("https://api.example.com/integrations/slack/start?returnTo=/settings"),
      );
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("location") ?? "");
      expect(location.origin).toBe("https://slack.com");
      expect(location.searchParams.get("client_id")).toBe("slack-client");
      expect(location.searchParams.get("state")).toBeTruthy();
    });

    it("redirects anonymous browsers to the web sign-in", async () => {
      const response = await ingress({
        authError: new ApiError(401, "authentication_required", "Authentication required."),
      }).start(new Request("https://api.example.com/integrations/slack/start"));
      expect(response.headers.get("location")).toBe("https://opencompany.example.com/signin");
    });

    it("rejects a tampered callback state", async () => {
      const response = await ingress().callback(
        new Request("https://api.example.com/integrations/slack/callback?state=garbage"),
      );
      const location = new URL(response.headers.get("location") ?? "");
      expect(location.origin).toBe("https://opencompany.example.com");
      expect(location.searchParams.get("reason")).toBe("invalid_state");
    });
  });

  describe("webhook", () => {
    it("rejects a bad signature", async () => {
      const response = await ingress().webhook(
        signedRequest(messageEnvelope(), { signature: "v0=nope" }),
      );
      expect(response.status).toBe(401);
      expect(insertSlackMessageEvents).not.toHaveBeenCalled();
    });

    it("rejects a stale timestamp (replay guard)", async () => {
      const stale = String(Math.floor(Date.now() / 1000) - 3600);
      const response = await ingress().webhook(
        signedRequest(messageEnvelope(), { timestamp: stale }),
      );
      expect(response.status).toBe(401);
    });

    it("answers the url_verification challenge", async () => {
      const response = await ingress().webhook(
        signedRequest({ type: "url_verification", challenge: "challenge_123" }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ challenge: "challenge_123" });
    });

    it("buffers a selected-channel message through the injected db", async () => {
      const response = await ingress().webhook(signedRequest(messageEnvelope()));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, buffered: 1 });
      expect(insertSlackMessageEvents).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            integrationId: "gint_1",
            teamId: "T012345",
            channelId: "C09ABC",
            messageTs: "1783950060.000100",
            text: "We decided to ship next week.",
          }),
        ],
        expect.objectContaining({ sentinel: "db" }),
      );
    });

    it("drops unselected channels, bots, and noise subtypes", async () => {
      for (const event of [
        { channel: "C_OTHER" },
        { bot_id: "B01" },
        { subtype: "message_changed" },
        { user: undefined },
      ]) {
        const response = await ingress().webhook(signedRequest(messageEnvelope(event)));
        expect(await response.json()).toMatchObject({ ok: true, dropped: true });
      }
      expect(insertSlackMessageEvents).not.toHaveBeenCalled();
    });

    it("keeps file_share and thread_broadcast subtypes", async () => {
      for (const subtype of ["file_share", "thread_broadcast"]) {
        const response = await ingress().webhook(signedRequest(messageEnvelope({ subtype })));
        expect(await response.json()).toMatchObject({ ok: true, buffered: 1 });
      }
      expect(insertSlackMessageEvents).toHaveBeenCalledTimes(2);
    });

    it("marks all team integrations needs_reauth on app_uninstalled with the injected db", async () => {
      const response = await ingress().webhook(
        signedRequest({
          type: "event_callback",
          team_id: "T012345",
          event: { type: "app_uninstalled" },
        }),
      );
      expect(await response.json()).toMatchObject({ ok: true, marked: 1 });
      expect(markIntegrationStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          integrationId: "gint_1",
          status: "needs_reauth",
          db: expect.objectContaining({ sentinel: "db" }),
        }),
      );
    });

    it("marks only the revoked user's integration on tokens_revoked", async () => {
      vi.mocked(listSlackIntegrationsForTeam).mockResolvedValue([
        { id: "gint_1", userWorkosId: "user_1", status: "connected" },
        { id: "gint_2", userWorkosId: "user_2", status: "connected" },
      ] as never);
      vi.mocked(loadIntegrationCredential).mockImplementation(
        async (input) =>
          ({
            payload: { authed_user_id: input.integrationId === "gint_1" ? "U01" : "U02" },
            expiresAt: null,
            lastRotatedAt: null,
            updatedAt: new Date(),
            encryptionKeyVersion: 1,
          }) as never,
      );

      const response = await ingress().webhook(
        signedRequest({
          type: "event_callback",
          team_id: "T012345",
          event: { type: "tokens_revoked", tokens: { oauth: ["U02"] } },
        }),
      );
      expect(await response.json()).toMatchObject({ ok: true, marked: 1 });
      expect(markIntegrationStatus).toHaveBeenCalledTimes(1);
      expect(markIntegrationStatus).toHaveBeenCalledWith(
        expect.objectContaining({ integrationId: "gint_2" }),
      );
    });

    it("acks with 200 when processing fails after verification", async () => {
      vi.mocked(listSlackIntegrationsForTeam).mockRejectedValue(new Error("db down"));
      const response = await ingress().webhook(signedRequest(messageEnvelope()));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    });
  });
});
