import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

describe("POST /api/webhooks/github/events relay", () => {
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

    const rawBody = JSON.stringify({ action: "opened", installation: { id: 777 } });
    const response = await POST(
      new Request("https://my.opencompany.chat/api/webhooks/github/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "pull_request",
          "x-github-delivery": "delivery_123",
          "x-hub-signature-256": "sha256=abc",
        },
        body: rawBody,
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, buffered: 1 });
    const request = upstream as unknown as Request;
    expect(new URL(request.url).href).toBe("https://api.example.test/webhooks/github/events");
    expect(request.method).toBe("POST");
    expect(request.headers.get("x-hub-signature-256")).toBe("sha256=abc");
    expect(request.headers.get("x-github-event")).toBe("pull_request");
    expect(request.headers.get("x-github-delivery")).toBe("delivery_123");
    expect(upstreamBody).toBe(rawBody);
  });

  it("fails closed with the unavailable envelope when the API origin is unset", async () => {
    vi.stubEnv("GOAT_API_ORIGIN", "");
    const response = await POST(
      new Request("https://my.opencompany.chat/api/webhooks/github/events", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(response.status).toBe(503);
  });
});
