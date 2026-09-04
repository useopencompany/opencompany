import { describe, expect, it, vi } from "vitest";
import { headlessApiTarget, proxyHeadlessApiRequest } from "./headless-api-proxy";

describe("web /v1 API adapter", () => {
  it("preserves the canonical path/query without allowing a same-origin loop", () => {
    expect(
      headlessApiTarget(
        "https://app.example.test/v1/runs/run_1/events?cursor=v1%3A2",
        ["runs", "run_1", "events"],
        "https://api.example.test",
      )?.toString(),
    ).toBe("https://api.example.test/v1/runs/run_1/events?cursor=v1%3A2");
    expect(
      headlessApiTarget(
        "https://app.example.test/v1/messages",
        ["messages"],
        "https://app.example.test",
      ),
    ).toBeNull();
  });

  it("targets top-level ingress paths when the /v1 base path is disabled", () => {
    expect(
      headlessApiTarget(
        "https://app.example.test/api/webhooks/linear/events",
        ["webhooks", "linear", "events"],
        "https://api.example.test",
        "",
      )?.toString(),
    ).toBe("https://api.example.test/webhooks/linear/events");
    expect(
      headlessApiTarget(
        "https://app.example.test/api/integrations/github-user/start?returnTo=%2Fsettings",
        ["integrations", "github-user", "start"],
        "https://api.example.test",
        "",
      )?.toString(),
    ).toBe("https://api.example.test/integrations/github-user/start?returnTo=%2Fsettings");
  });

  it("forwards authentication/idempotency headers and streams the upstream response", async () => {
    const fetchMock = vi.fn(async (_url: URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("cookie")).toBe("wos-session=test");
      expect(headers.get("idempotency-key")).toBe("send_1");
      expect(headers.has("host")).toBe(false);
      return new Response("accepted", {
        status: 202,
        headers: { "X-Request-Id": "request_1", "Content-Length": "8" },
      });
    });
    const response = await proxyHeadlessApiRequest(
      new Request("https://app.example.test/v1/messages", {
        method: "POST",
        headers: { Cookie: "wos-session=test", "Idempotency-Key": "send_1" },
        body: "{}",
      }),
      ["messages"],
      { apiOrigin: "https://api.example.test", fetch: fetchMock as typeof fetch },
    );
    expect(response.status).toBe(202);
    await expect(response.text()).resolves.toBe("accepted");
    expect(response.headers.has("content-length")).toBe(false);
  });

  it("fails closed when no separate API origin is configured", async () => {
    const response = await proxyHeadlessApiRequest(
      new Request("https://app.example.test/v1/conversations"),
      ["conversations"],
      { apiOrigin: "" },
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "unavailable" } });
  });
});
