import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHeadlessChatApiFetch,
  headlessChatApiBaseUrl,
  invalidateHeadlessChatApiSession,
} from "./headless-chat-api";

describe("headless Chat direct API transport", () => {
  beforeEach(() => invalidateHeadlessChatApiSession());

  it("uses the configured first-party API origin and rejects URLs with paths", () => {
    expect(
      headlessChatApiBaseUrl("https://api.opencompany.chat", "https://my.opencompany.chat"),
    ).toBe("https://api.opencompany.chat");
    expect(() =>
      headlessChatApiBaseUrl("https://api.opencompany.chat/private", "https://my.opencompany.chat"),
    ).toThrow("valid HTTP origin");
  });

  it("shares the browser session once before concurrent direct API requests", async () => {
    const calls: Array<{ url: string; credentials?: RequestCredentials; method?: string }> = [];
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: input.toString(),
        ...(init?.credentials ? { credentials: init.credentials } : {}),
        ...(init?.method ? { method: init.method } : {}),
      });
      return Response.json({ ok: true });
    });
    const fetchMock = fetchSpy as unknown as typeof fetch;
    const apiFetch = createHeadlessChatApiFetch({
      baseUrl: "https://api.opencompany.chat",
      webBaseUrl: "https://my.opencompany.chat",
      fetch: fetchMock,
      prepareSession: true,
    });

    await Promise.all([
      apiFetch("https://api.opencompany.chat/v1/conversations"),
      apiFetch("https://api.opencompany.chat/v1/read-models/chat-conversations-v1"),
    ]);

    expect(calls.filter((call) => call.url.endsWith("/api/auth/share-api-session"))).toHaveLength(
      1,
    );
    expect(calls[0]).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(calls.slice(1).every((call) => call.credentials === "include")).toBe(true);
  });

  it("does not add a session-setup waterfall for same-origin development", async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input.toString()).toBe("https://localhost:3443/v1/conversations");
      expect(init).toMatchObject({ credentials: "include" });
      return Response.json({ ok: true });
    });
    const fetchMock = fetchSpy as unknown as typeof fetch;
    const apiFetch = createHeadlessChatApiFetch({
      baseUrl: "https://localhost:3443",
      webBaseUrl: "https://localhost:3443",
      fetch: fetchMock,
      prepareSession: true,
    });

    await apiFetch("https://localhost:3443/v1/conversations");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("retries session setup after a transient failure", async () => {
    let calls = 0;
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      calls += 1;
      if (input.toString().endsWith("/api/auth/share-api-session") && calls === 1) {
        return new Response(null, { status: 503 });
      }
      return Response.json({ ok: true });
    });
    const fetchMock = fetchSpy as unknown as typeof fetch;
    const apiFetch = createHeadlessChatApiFetch({
      baseUrl: "https://api.opencompany.chat",
      webBaseUrl: "https://my.opencompany.chat",
      fetch: fetchMock,
      prepareSession: true,
    });

    await expect(apiFetch("https://api.opencompany.chat/v1/conversations")).rejects.toThrow(
      "HTTP 503",
    );
    await expect(apiFetch("https://api.opencompany.chat/v1/conversations")).resolves.toBeInstanceOf(
      Response,
    );
    expect(
      fetchSpy.mock.calls.filter(([request]) =>
        request.toString().endsWith("/api/auth/share-api-session"),
      ),
    ).toHaveLength(2);
  });
});
