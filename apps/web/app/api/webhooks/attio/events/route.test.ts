import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

describe("POST /api/webhooks/attio/events relay", () => {
  beforeEach(() => {
    vi.stubEnv("GOAT_API_ORIGIN", "https://api.example.test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("streams the signed delivery to the canonical API ingress path unchanged", async () => {
    let upstream: Request | null = null;
    let upstreamBody: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        upstream = input instanceof Request ? input : new Request(input, init);
        upstreamBody = await upstream.text();
        return Response.json({ ok: true, buffered: 1 });
      }),
    );

    const rawBody = JSON.stringify({ webhook_id: "wh_1", events: [] });
    const response = await POST(
      new Request("https://my.opencompany.chat/api/webhooks/attio/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "attio-signature": "signature",
          "idempotency-key": "delivery_1",
        },
        body: rawBody,
      }),
    );

    expect(response.status).toBe(200);
    const request = upstream as unknown as Request;
    expect(new URL(request.url).href).toBe("https://api.example.test/webhooks/attio/events");
    expect(request.headers.get("attio-signature")).toBe("signature");
    expect(request.headers.get("idempotency-key")).toBe("delivery_1");
    expect(upstreamBody).toBe(rawBody);
  });

  it("fails closed when the API origin is unset", async () => {
    vi.stubEnv("GOAT_API_ORIGIN", "");
    const response = await POST(
      new Request("https://my.opencompany.chat/api/webhooks/attio/events", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(response.status).toBe(503);
  });
});
