import { createHmac } from "node:crypto";
import { loadConvexWebhookSecret } from "@opencompany/agent/integrations/convex-log-stream";
import {
  findConvexEventConnection,
  markConvexEventsDelivered,
} from "@opencompany/db/convex-events";
import {
  enqueueWorkflowEventRuns,
  listWorkflowEventTriggerRoutes,
} from "@opencompany/db/workflow-event-routes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConvexIngress } from "./convex-ingress";

vi.mock("@opencompany/db/convex-events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  findConvexEventConnection: vi.fn(),
  markConvexEventsDelivered: vi.fn(),
}));
vi.mock("@opencompany/agent/integrations/convex-log-stream", () => ({
  loadConvexWebhookSecret: vi.fn(),
}));
vi.mock("@opencompany/db/workflow-event-routes", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listWorkflowEventTriggerRoutes: vi.fn(),
  enqueueWorkflowEventRuns: vi.fn(),
}));

const ENDPOINT_ID = "gint_convex_events";
const SECRET = "convex_hmac_secret_value";
const CONNECTION = {
  id: ENDPOINT_ID,
  workspaceId: null,
  userWorkosId: "user_1",
  status: "connected" as const,
};
const sentinelDb = { sentinel: "db" };
const NOW = new Date("2026-09-14T12:00:00.000Z");

function route(filters: Record<string, { id: string }> = {}) {
  return {
    workflowId: "wf_1",
    workspaceId: "ws_1",
    userWorkosId: "user_1",
    workflowSlug: "triage-convex",
    workflowName: "Triage Convex failures",
    prompt: "Triage this failure.",
    harnessSpec: { kind: "claude_code" },
    provider: "convex",
    event: "function.failed",
    filters,
  };
}

function failure(overrides: Record<string, unknown> = {}) {
  return {
    topic: "function_execution",
    timestamp: NOW.getTime() - 30_000,
    convex: {
      deployment_name: "happy-otter-123",
      deployment_type: "prod",
      project_name: "northwind",
      project_slug: "northwind",
    },
    function: { path: "messages:send", type: "mutation", request_id: "d064ef901f7ec0b7" },
    status: "failure",
    error_message: "Uncaught Error: boom\n  at handler",
    execution_time_ms: 42,
    run_reason: "webSocket",
    ...overrides,
  };
}

function deliver(events: unknown, secret: string | null = SECRET) {
  const body = JSON.stringify(events);
  const signature =
    secret === null
      ? null
      : `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
  return createConvexIngress({ db: sentinelDb }).webhook(
    ENDPOINT_ID,
    new Request(`https://api.example.com/webhooks/convex/${ENDPOINT_ID}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(signature ? { "x-webhook-signature": signature } : {}),
      },
      body,
    }),
  );
}

describe("Convex ingress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.mocked(findConvexEventConnection).mockResolvedValue(CONNECTION);
    vi.mocked(loadConvexWebhookSecret).mockResolvedValue(SECRET);
    vi.mocked(markConvexEventsDelivered).mockResolvedValue(undefined);
    vi.mocked(listWorkflowEventTriggerRoutes).mockResolvedValue([route()] as never);
    vi.mocked(enqueueWorkflowEventRuns).mockResolvedValue(1);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("enqueues one run per incident and passes the injected db through", async () => {
    const response = await deliver([failure()]);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, workflowRuns: 1 });
    expect(findConvexEventConnection).toHaveBeenCalledWith(
      ENDPOINT_ID,
      expect.objectContaining({ sentinel: "db" }),
    );
    const enqueued = vi.mocked(enqueueWorkflowEventRuns).mock.calls[0]?.[0];
    expect(enqueued?.context.tag).toBe("convex_function_failure");
    expect(enqueued?.context.lines.join("\n")).toContain("messages:send");
  });

  it("collapses a burst of the same failure into one run", async () => {
    const response = await deliver(
      Array.from({ length: 200 }, (_, index) =>
        failure({ timestamp: NOW.getTime() - 30_000 + index }),
      ),
    );

    await expect(response.json()).resolves.toEqual({ ok: true, workflowRuns: 1 });
    expect(enqueueWorkflowEventRuns).toHaveBeenCalledTimes(1);
  });

  it("rejects a missing signature, an unknown endpoint, and a wrong secret alike", async () => {
    const missing = await deliver([failure()], null);
    expect(missing.status).toBe(401);
    expect(findConvexEventConnection).not.toHaveBeenCalled();

    vi.mocked(findConvexEventConnection).mockResolvedValue(null);
    const unknownEndpoint = await deliver([failure()]);
    expect(unknownEndpoint.status).toBe(401);
    // An unknown endpoint is rejected before any credential is read.
    expect(loadConvexWebhookSecret).not.toHaveBeenCalled();

    vi.mocked(findConvexEventConnection).mockResolvedValue(CONNECTION);
    const wrongSecret = await deliver([failure()], "someone-elses-secret");
    expect(wrongSecret.status).toBe(401);
    await expect(wrongSecret.json()).resolves.toEqual(await unknownEndpoint.clone().json());
    expect(enqueueWorkflowEventRuns).not.toHaveBeenCalled();
  });

  it("records the verification event Convex sends without routing anything", async () => {
    const response = await deliver([
      { topic: "verification", timestamp: NOW.getTime(), message: "Log stream is working" },
    ]);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, workflowRuns: 0 });
    expect(markConvexEventsDelivered).toHaveBeenCalledWith(
      expect.objectContaining({ integrationId: ENDPOINT_ID }),
      expect.objectContaining({ sentinel: "db" }),
    );
    expect(listWorkflowEventTriggerRoutes).not.toHaveBeenCalled();
  });

  it("acknowledges but does not route failures that are already stale", async () => {
    const response = await deliver([failure({ timestamp: NOW.getTime() - 60 * 60 * 1000 })]);

    await expect(response.json()).resolves.toEqual({ ok: true, workflowRuns: 0 });
    expect(markConvexEventsDelivered).toHaveBeenCalled();
    expect(listWorkflowEventTriggerRoutes).not.toHaveBeenCalled();
  });

  it("matches the function_type filter against the failing function", async () => {
    vi.mocked(listWorkflowEventTriggerRoutes).mockResolvedValue([
      route({ function_type: { id: "http_action" } }),
    ] as never);
    await deliver([failure()]);
    expect(enqueueWorkflowEventRuns).not.toHaveBeenCalled();

    vi.mocked(listWorkflowEventTriggerRoutes).mockResolvedValue([
      route({ function_type: { id: "mutation" } }),
    ] as never);
    await deliver([failure()]);
    expect(enqueueWorkflowEventRuns).toHaveBeenCalledTimes(1);
  });

  it("asks for a retry when a durable write fails", async () => {
    vi.mocked(enqueueWorkflowEventRuns).mockRejectedValue(new Error("connection terminated"));

    const response = await deliver([failure()]);

    expect(response.status).toBe(503);
  });

  it("rejects a signed body that is not JSON", async () => {
    const body = "not json";
    const response = await createConvexIngress({ db: sentinelDb }).webhook(
      ENDPOINT_ID,
      new Request(`https://api.example.com/webhooks/convex/${ENDPOINT_ID}`, {
        method: "POST",
        headers: {
          "x-webhook-signature": `sha256=${createHmac("sha256", SECRET).update(body, "utf8").digest("hex")}`,
        },
        body,
      }),
    );

    expect(response.status).toBe(400);
  });
});
