import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

describe("POST /api/webhooks/jamie/[integrationId] relay", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCOMPANY_API_ORIGIN", "https://api.example.test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("streams the delivery to the per-integration API ingress path unchanged", async () => {
    let upstream: Request | null = null;
    let upstreamBody: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        upstream = input instanceof Request ? input : new Request(input, init);
        upstreamBody = await upstream.text();
        return Response.json({ ok: true, enqueued: true });
      }),
    );

    const rawBody = JSON.stringify({ metadata: { event: "meeting.completed" } });
    const response = await POST(
      new Request("https://my.opencompany.chat/api/webhooks/jamie/gint_123", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "jamie-event": "meeting.completed",
          "x-jamie-api-key": "sk_test",
        },
        body: rawBody,
      }),
      { params: Promise.resolve({ integrationId: "gint_123" }) },
    );

    expect(response.status).toBe(200);
    const request = upstream as unknown as Request;
    expect(new URL(request.url).href).toBe("https://api.example.test/webhooks/jamie/gint_123");
    expect(request.headers.get("x-jamie-api-key")).toBe("sk_test");
    expect(upstreamBody).toBe(rawBody);
  });

  it("fails closed when the API origin is unset", async () => {
    vi.stubEnv("OPENCOMPANY_API_ORIGIN", "");
    const response = await POST(
      new Request("https://my.opencompany.chat/api/webhooks/jamie/gint_123", {
        method: "POST",
        body: "{}",
      }),
      { params: Promise.resolve({ integrationId: "gint_123" }) },
    );
    expect(response.status).toBe(503);
  });
});
