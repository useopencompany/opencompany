import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

describe("POST /api/webhooks/slack/events relay", () => {
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

    const rawBody = JSON.stringify({ type: "event_callback", team_id: "T1", event: {} });
    const response = await POST(
      new Request("https://my.opencompany.chat/api/webhooks/slack/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": "1700000000",
          "x-slack-signature": "v0=abc",
        },
        body: rawBody,
      }),
    );

    expect(response.status).toBe(200);
    const request = upstream as unknown as Request;
    expect(new URL(request.url).href).toBe("https://api.example.test/webhooks/slack/events");
    expect(request.headers.get("x-slack-signature")).toBe("v0=abc");
    expect(request.headers.get("x-slack-request-timestamp")).toBe("1700000000");
    expect(upstreamBody).toBe(rawBody);
  });

  it("fails closed when the API origin is unset", async () => {
    vi.stubEnv("GOAT_API_ORIGIN", "");
    const response = await POST(
      new Request("https://my.opencompany.chat/api/webhooks/slack/events", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(response.status).toBe(503);
  });
});
