import { createHmac } from "node:crypto";
import { createLinearIngestState } from "@opencompany/agent/integrations/linear-ingest";
import {
  enqueueLinearWorkflowEventRuns,
  insertLinearIssueEvents,
  listEnabledLinearBrainSourceRoutes,
  listLinearIntegrationsForOrganization,
  listLinearWorkflowTriggerRoutes,
} from "@opencompany/db/linear";
import { listWorkspacesForUser } from "@opencompany/db/workspaces";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./errors";
import { createLinearIngress } from "./linear-ingress";

vi.mock("@opencompany/db/linear", async (importOriginal) => {
  const original = await importOriginal<typeof import("@opencompany/db/linear")>();
  return {
    ...original,
    enqueueLinearWorkflowEventRuns: vi.fn(),
    insertLinearIssueEvents: vi.fn(),
    listEnabledLinearBrainSourceRoutes: vi.fn(),
    listLinearIntegrationsForOrganization: vi.fn(),
    listLinearWorkflowTriggerRoutes: vi.fn(),
  };
});
vi.mock("@opencompany/db/workspaces", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listWorkspacesForUser: vi.fn(),
}));

const WEBHOOK_SECRET = "linear-webhook-secret";
const sentinelDb = { sentinel: "db" };

function ingress(overrides: { authError?: ApiError } = {}) {
  vi.mocked(listWorkspacesForUser).mockResolvedValue([
    { workspace: { id: "workspace_1", workosOrganizationId: null }, role: "admin" },
  ] as never);
  return createLinearIngress({
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

function signedRequest(payload: Record<string, unknown>, overrides: { signature?: string } = {}) {
  const envelope = { webhookTimestamp: Date.now(), webhookId: "wh_1", ...payload };
  const rawBody = JSON.stringify(envelope);
  const signature =
    overrides.signature ?? createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex");
  return new Request("https://api.example.com/webhooks/linear/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "linear-signature": signature,
      "linear-delivery": "delivery_1",
    },
    body: rawBody,
  });
}

function issueEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    action: "create",
    type: "Issue",
    createdAt: new Date().toISOString(),
    organizationId: "org_1",
    data: { id: "issue_1", teamId: "team_1", title: "Billing bug" },
    ...overrides,
  };
}

describe("Linear ingress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OPENCOMPANY_NEXT_PUBLIC_APP_URL", "https://opencompany.example.com");
    vi.stubEnv("OPENCOMPANY_LINEAR_CLIENT_ID", "linear-client");
    vi.stubEnv("OPENCOMPANY_LINEAR_CLIENT_SECRET", "linear-secret");
    vi.stubEnv("OPENCOMPANY_LINEAR_WEBHOOK_SECRET", WEBHOOK_SECRET);
    vi.stubEnv("OPENCOMPANY_LINEAR_STATE_SECRET", "linear-state-secret-linear-state-secret");
    vi.stubEnv("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", "a".repeat(44));
    vi.mocked(listLinearIntegrationsForOrganization).mockResolvedValue([
      { id: "gint_1", userWorkosId: "user_1", status: "connected" },
    ] as never);
    vi.mocked(listEnabledLinearBrainSourceRoutes).mockResolvedValue([
      {
        integrationId: "gint_1",
        brainRef: "gbrain_1",
        config: {
          teams: [{ id: "team_1", name: "Core" }],
          events: [{ id: "issue_created" }, { id: "comment_created" }],
        },
      },
    ] as never);
    vi.mocked(insertLinearIssueEvents).mockResolvedValue(1);
    vi.mocked(listLinearWorkflowTriggerRoutes).mockResolvedValue([]);
    vi.mocked(enqueueLinearWorkflowEventRuns).mockResolvedValue(0);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe("oauth", () => {
    it("redirects an authenticated user to Linear authorization with signed state", async () => {
      const response = await ingress().start(
        new Request("https://api.example.com/integrations/linear-ingest/start?returnTo=/settings"),
      );
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("location") ?? "");
      expect(location.origin).toBe("https://linear.app");
      expect(location.searchParams.get("client_id")).toBe("linear-client");
      expect(location.searchParams.get("state")).toBeTruthy();
    });

    it("redirects anonymous browsers to the web sign-in", async () => {
      const response = await ingress({
        authError: new ApiError(401, "authentication_required", "Authentication required."),
      }).start(new Request("https://api.example.com/integrations/linear-ingest/start"));
      expect(response.headers.get("location")).toBe("https://opencompany.example.com/signin");
    });

    it("rejects a state minted for another user with session_mismatch", async () => {
      const state = createLinearIngestState({
        userWorkosId: "user_other",
        returnTo: "/settings",
      });
      const response = await ingress().callback(
        new Request(
          `https://api.example.com/integrations/linear-ingest/callback?state=${encodeURIComponent(state)}&code=abc`,
        ),
      );
      const location = new URL(response.headers.get("location") ?? "");
      expect(location.searchParams.get("reason")).toBe("session_mismatch");
    });
  });

  describe("webhook", () => {
    it("rejects a bad signature", async () => {
      const response = await ingress().webhook(
        signedRequest(issueEnvelope(), { signature: "nope" }),
      );
      expect(response.status).toBe(401);
      expect(insertLinearIssueEvents).not.toHaveBeenCalled();
    });

    it("buffers a selected-team issue event through the injected db", async () => {
      const response = await ingress().webhook(signedRequest(issueEnvelope()));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, buffered: 1 });
      expect(insertLinearIssueEvents).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            integrationId: "gint_1",
            organizationId: "org_1",
            teamId: "team_1",
            issueId: "issue_1",
            deliveryId: "delivery_1",
            entityType: "issue",
            action: "create",
          }),
        ],
        expect.objectContaining({ sentinel: "db" }),
      );
    });

    it("drops board-reordering noise updates", async () => {
      const response = await ingress().webhook(
        signedRequest(
          issueEnvelope({
            action: "update",
            updatedFrom: { updatedAt: "x", sortOrder: 1 },
          }),
        ),
      );
      expect(await response.json()).toMatchObject({ ok: true, dropped: true });
      expect(insertLinearIssueEvents).not.toHaveBeenCalled();
    });

    it("durably enqueues a matching issue that enters triage", async () => {
      vi.mocked(listEnabledLinearBrainSourceRoutes).mockResolvedValue([]);
      vi.mocked(listLinearWorkflowTriggerRoutes).mockResolvedValue([
        {
          workflowId: "workflow_1",
          workspaceId: "workspace_1",
          userWorkosId: "user_1",
          workflowSlug: "triage-issues",
          workflowName: "Triage issues",
          prompt: "Assess this issue.",
          harnessSpec: { engine: "opencompany", model: "default" },
          triageStateId: "state_triage",
        },
      ] as never);
      vi.mocked(enqueueLinearWorkflowEventRuns).mockResolvedValue(1);

      const response = await ingress().webhook(
        signedRequest(
          issueEnvelope({
            data: {
              id: "issue_1",
              teamId: "team_1",
              title: "Billing bug",
              state: { id: "state_triage", name: "Triage", type: "triage" },
            },
          }),
        ),
      );

      expect(await response.json()).toMatchObject({ ok: true, workflowRuns: 1 });
      expect(enqueueLinearWorkflowEventRuns).toHaveBeenCalledWith(
        expect.objectContaining({
          deliveryId: "delivery_1",
          routes: [expect.objectContaining({ workflowId: "workflow_1" })],
        }),
        expect.objectContaining({ sentinel: "db" }),
      );
    });

    it("drops events for unselected teams", async () => {
      const response = await ingress().webhook(
        signedRequest(issueEnvelope({ data: { id: "issue_2", teamId: "team_other", title: "x" } })),
      );
      expect(await response.json()).toMatchObject({ ok: true, dropped: true });
    });

    it("requests a retry when durable processing fails after verification", async () => {
      vi.mocked(listLinearIntegrationsForOrganization).mockRejectedValue(new Error("db down"));
      const response = await ingress().webhook(signedRequest(issueEnvelope()));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: "Linear event processing failed; retry this delivery.",
      });
    });
  });
});
