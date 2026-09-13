import { JAMIE_WEBHOOK_API_KEY_HEADER } from "@opencompany/agent/integrations/jamie-constants";
import { loadJamieWebhookSecret } from "@opencompany/agent/integrations/jamie-events";
import { findJamieEventConnection, markJamieEventsDelivered } from "@opencompany/db/jamie";
import {
  enqueueWorkflowEventRuns,
  listWorkflowEventTriggerRoutes,
} from "@opencompany/db/workflow-event-routes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJamieIngress } from "./jamie-ingress";

vi.mock("@opencompany/db/jamie", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  findJamieEventConnection: vi.fn(),
  markJamieEventsDelivered: vi.fn(),
}));
vi.mock("@opencompany/agent/integrations/jamie-events", () => ({
  loadJamieWebhookSecret: vi.fn(),
}));
vi.mock("@opencompany/db/workflow-event-routes", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listWorkflowEventTriggerRoutes: vi.fn(),
  enqueueWorkflowEventRuns: vi.fn(),
}));

const ENDPOINT_ID = "gint_jamie_events";
const WEBHOOK_KEY = "sk_jamie_webhook_key_value";
const CONNECTION = {
  id: ENDPOINT_ID,
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

function jamieRequest(body: unknown, webhookKey: string | null = WEBHOOK_KEY) {
  return new Request(`https://api.example.com/webhooks/jamie/${ENDPOINT_ID}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(webhookKey ? { [JAMIE_WEBHOOK_API_KEY_HEADER]: webhookKey } : {}),
    },
    body: JSON.stringify(body),
  });
}

function deliver(body: unknown, webhookKey: string | null = WEBHOOK_KEY) {
  return ingress().webhook(ENDPOINT_ID, jamieRequest(body, webhookKey));
}

describe("Jamie ingress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(findJamieEventConnection).mockResolvedValue(CONNECTION);
    vi.mocked(loadJamieWebhookSecret).mockResolvedValue(WEBHOOK_KEY);
    vi.mocked(markJamieEventsDelivered).mockResolvedValue(undefined);
    vi.mocked(listWorkflowEventTriggerRoutes).mockResolvedValue([route()] as never);
    vi.mocked(enqueueWorkflowEventRuns).mockResolvedValue(1);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("enqueues one run per matched route and passes the injected db through", async () => {
    const response = await deliver(meetingDelivery());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, workflowRuns: 1 });
    expect(findJamieEventConnection).toHaveBeenCalledWith(
      ENDPOINT_ID,
      expect.objectContaining({ sentinel: "db" }),
    );
    const enqueued = vi.mocked(enqueueWorkflowEventRuns).mock.calls[0]?.[0];
    expect(enqueued?.eventAt).toEqual(new Date(1_764_600_000 * 1000));
    expect(enqueued?.context.tag).toBe("jamie_meeting_context");
    expect(enqueued?.context.lines.join("\n")).toContain("Acme wants SSO");
  });

  it("rejects a missing key, an unknown endpoint, and a wrong key alike", async () => {
    const missing = await deliver(meetingDelivery(), null);
    expect(missing.status).toBe(401);
    expect(findJamieEventConnection).not.toHaveBeenCalled();

    vi.mocked(findJamieEventConnection).mockResolvedValue(null);
    const unknownEndpoint = await deliver(meetingDelivery());
    expect(unknownEndpoint.status).toBe(401);
    // An unknown endpoint is rejected before any credential is read.
    expect(loadJamieWebhookSecret).not.toHaveBeenCalled();

    vi.mocked(findJamieEventConnection).mockResolvedValue(CONNECTION);
    const wrongKey = await deliver(meetingDelivery(), "sk_someone_elses_key_value");
    expect(wrongKey.status).toBe(401);
    // The three rejections are indistinguishable to an unauthenticated caller.
    await expect(wrongKey.json()).resolves.toEqual(await unknownEndpoint.clone().json());
    expect(enqueueWorkflowEventRuns).not.toHaveBeenCalled();
  });

  it("derives a delivery id from the meeting rather than the delivery attempt", async () => {
    await deliver(meetingDelivery());
    const first = vi.mocked(enqueueWorkflowEventRuns).mock.calls[0]?.[0]?.deliveryId;

    const retry = meetingDelivery();
    retry.metadata = { id: "99999999", event: "meeting.completed", created: 1_764_600_060 };
    await deliver(retry);

    expect(vi.mocked(enqueueWorkflowEventRuns).mock.calls[1]?.[0]?.deliveryId).toBe(first);
  });

  it("matches the guests filter against the meeting's own attendees", async () => {
    vi.mocked(listWorkflowEventTriggerRoutes).mockResolvedValue([
      route({ guests: { id: "internal" } }),
    ] as never);
    await deliver(meetingDelivery());
    expect(enqueueWorkflowEventRuns).not.toHaveBeenCalled();

    vi.mocked(listWorkflowEventTriggerRoutes).mockResolvedValue([
      route({ guests: { id: "external" } }),
    ] as never);
    await deliver(meetingDelivery());
    expect(enqueueWorkflowEventRuns).toHaveBeenCalledTimes(1);
  });

  it("records the delivery but routes nothing for an event it does not declare", async () => {
    const response = await deliver({
      metadata: { id: "1", event: "meeting.started", created: 1 },
      data: {},
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, ignored: true });
    expect(markJamieEventsDelivered).toHaveBeenCalledWith(
      expect.objectContaining({ integrationId: ENDPOINT_ID }),
      expect.objectContaining({ sentinel: "db" }),
    );
    expect(listWorkflowEventTriggerRoutes).not.toHaveBeenCalled();
  });

  it("asks Jamie to retry when a durable write fails", async () => {
    vi.mocked(enqueueWorkflowEventRuns).mockRejectedValue(new Error("connection terminated"));

    const response = await deliver(meetingDelivery());

    expect(response.status).toBe(503);
  });
});
