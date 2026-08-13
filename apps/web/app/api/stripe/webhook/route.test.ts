import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

describe("POST /api/stripe/webhook relay", () => {
  beforeEach(() => vi.stubEnv("GOAT_API_ORIGIN", "https://api.example.test"));
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("streams the exact signed payload to the canonical API", async () => {
    let upstream: Request | null = null;
    let upstreamBody: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (requestInput: URL | RequestInfo, init?: RequestInit) => {
        upstream = requestInput instanceof Request ? requestInput : new Request(requestInput, init);
        upstreamBody = await upstream.text();
        return Response.json({ received: true });
      }),
    );
    const rawBody = '{\n  "id": "evt_1"\n}';
    const response = await POST(
      new Request("https://my.opencompany.chat/api/stripe/webhook", {
        method: "POST",
        headers: { "stripe-signature": "t=1,v1=signature" },
        body: rawBody,
      }),
    );

    expect(response.status).toBe(200);
    const request = upstream as unknown as Request;
    expect(request.url).toBe("https://api.example.test/webhooks/stripe");
    expect(request.headers.get("stripe-signature")).toBe("t=1,v1=signature");
    expect(upstreamBody).toBe(rawBody);
  });

  it("fails closed when the canonical API is unavailable", async () => {
    vi.stubEnv("GOAT_API_ORIGIN", "");
    const response = await POST(
      new Request("https://my.opencompany.chat/api/stripe/webhook", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(response.status).toBe(503);
  });
});
