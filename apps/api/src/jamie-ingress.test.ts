import { JAMIE_WEBHOOK_API_KEY_HEADER } from "@opencompany/agent/integrations/jamie-constants";
import {
  listJamieEventIntegrationsForApiKey,
  markJamieEventsDelivered,
} from "@opencompany/db/jamie";
import {
  enqueueWorkflowEventRuns,
  listWorkflowEventTriggerRoutes,
} from "@opencompany/db/workflow-event-routes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJamieIngress } from "./jamie-ingress";

vi.mock("@opencompany/db/jamie", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listJamieEventIntegrationsForApiKey: vi.fn(),
  markJamieEventsDelivered: vi.fn(),
}));
vi.mock("@opencompany/db/workflow-event-routes", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listWorkflowEventTriggerRoutes: vi.fn(),
  enqueueWorkflowEventRuns: vi.fn(),
}));

const API_KEY = "sk_jamie_webhook_key_value";
const CONNECTION = {
  id: "gint_jamie_events",
  workspaceId: null,
  userWorkosId: "user_1",
  status: "connected" as const,
};
const sentinelDb = { sentinel: "db" };

function ingress() {
  return createJamieIngress({ db: sentinelDb });
}

function route(filters: Record<string, { id: string }> = {}) {
  return {
    workflowId: "wf_1",
    workspaceId: "ws_1",
    userWorkosId: "user_1",
    workflowSlug: "follow-up",
    workflowName: "Follow up",
    prompt: "Draft the follow-up.",
    harnessSpec: { kind: "claude_code" },
    provider: "jamie",
    event: "meeting.completed",
    filters,
  };
}

function meetingDelivery(overrides: Record<string, unknown> = {}) {
  return {
    metadata: { id: "78934567", event: "meeting.completed", created: 1_764_600_000 },
    data: {
      title: "Acme onboarding",
      startTime: "2026-09-12T14:00:00.000Z",
      endTime: "2026-09-12T15:00:00.000Z",
      user: { id: "jamie_user_1", email: "founder@northwind.co" },
      summary: { markdown: "# Notes\nAcme wants SSO.", short: "Acme wants SSO." },
      participants: [{ id: "1", name: "Dana", email: "dana@acme.com" }],
      event: {
        id: "cal_1",
        title: "Acme onboarding",
        attendees: [
          { name: "Founder", email: "founder@northwind.co", organizer: true },
          { name: "Dana", email: "dana@acme.com", organizer: false },
        ],
      },
      tasks: [{ content: "Send the SSO doc", completed: false, assignee: { name: "Founder" } }],
      tags: [{ name: "Customer", color: "#4A90D9" }],
      ...overrides,
    },
  };
}

function jamieRequest(body: unknown, apiKey: string | null = API_KEY) {
  return new Request("https://api.example.com/webhooks/jamie/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { [JAMIE_WEBHOOK_API_KEY_HEADER]: apiKey } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("Jamie ingress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listJamieEventIntegrationsForApiKey).mockResolvedValue([CONNECTION]);
    vi.mocked(markJamieEventsDelivered).mockResolvedValue(undefined);
    vi.mocked(listWorkflowEventTriggerRoutes).mockResolvedValue([route()] as never);
    vi.mocked(enqueueWorkflowEventRuns).mockResolvedValue(1);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("enqueues one run per matched route and passes the injected db through", async () => {
    const response = await ingress().webhook(jamieRequest(meetingDelivery()));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, workflowRuns: 1 });
    expect(listJamieEventIntegrationsForApiKey).toHaveBeenCalledWith(
      API_KEY,
      expect.objectContaining({ sentinel: "db" }),
    );
    const enqueued = vi.mocked(enqueueWorkflowEventRuns).mock.calls[0]?.[0];
    expect(enqueued?.eventAt).toEqual(new Date(1_764_600_000 * 1000));
    expect(enqueued?.context.tag).toBe("jamie_meeting_context");
    expect(enqueued?.context.lines.join("\n")).toContain("Acme wants SSO");
  });

  it("rejects a delivery with no key and one with an unknown key", async () => {
    const missing = await ingress().webhook(jamieRequest(meetingDelivery(), null));
    expect(missing.status).toBe(401);
    expect(listJamieEventIntegrationsForApiKey).not.toHaveBeenCalled();

    vi.mocked(listJamieEventIntegrationsForApiKey).mockResolvedValue([]);
    const unknown = await ingress().webhook(jamieRequest(meetingDelivery()));
    expect(unknown.status).toBe(401);
    expect(enqueueWorkflowEventRuns).not.toHaveBeenCalled();
  });

  it("derives a delivery id from the meeting rather than the delivery attempt", async () => {
    await ingress().webhook(jamieRequest(meetingDelivery()));
    const first = vi.mocked(enqueueWorkflowEventRuns).mock.calls[0]?.[0]?.deliveryId;

    const retry = meetingDelivery();
    retry.metadata = { id: "99999999", event: "meeting.completed", created: 1_764_600_060 };
    await ingress().webhook(jamieRequest(retry));

    expect(vi.mocked(enqueueWorkflowEventRuns).mock.calls[1]?.[0]?.deliveryId).toBe(first);
  });

  it("matches the guests filter against the meeting's own attendees", async () => {
    vi.mocked(listWorkflowEventTriggerRoutes).mockResolvedValue([
      route({ guests: { id: "internal" } }),
    ] as never);
    await ingress().webhook(jamieRequest(meetingDelivery()));
    expect(enqueueWorkflowEventRuns).not.toHaveBeenCalled();

    vi.mocked(listWorkflowEventTriggerRoutes).mockResolvedValue([
      route({ guests: { id: "external" } }),
    ] as never);
    await ingress().webhook(jamieRequest(meetingDelivery()));
    expect(enqueueWorkflowEventRuns).toHaveBeenCalledTimes(1);
  });

  it("records the delivery but routes nothing for an event it does not declare", async () => {
    const response = await ingress().webhook(
      jamieRequest({ metadata: { id: "1", event: "meeting.started", created: 1 }, data: {} }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, ignored: true });
    expect(markJamieEventsDelivered).toHaveBeenCalledWith(
      expect.objectContaining({ integrationIds: ["gint_jamie_events"] }),
      expect.objectContaining({ sentinel: "db" }),
    );
    expect(listWorkflowEventTriggerRoutes).not.toHaveBeenCalled();
  });

  it("asks Jamie to retry when a durable write fails", async () => {
    vi.mocked(enqueueWorkflowEventRuns).mockRejectedValue(new Error("connection terminated"));

    const response = await ingress().webhook(jamieRequest(meetingDelivery()));

    expect(response.status).toBe(503);
  });
});
