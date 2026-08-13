import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  legacyBrowserProfileLiveView,
  legacyCompleteBrowserProfileLogin,
  legacyCreateBrowserProfile,
  legacyCreateBrowserProfileLoginSession,
  legacyDeleteBrowserProfile,
  legacyListBrowserProfiles,
} from "./browser-profile-route-adapter";

const meta = { apiVersion: "v1", protocolVersion: "1.0.0" };

describe("legacy browser profile route adapters", () => {
  beforeEach(() => {
    vi.stubEnv("GOAT_API_ORIGIN", "https://api.example.test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function stubUpstream(handler: (request: Request) => Response | Promise<Response>) {
    const calls: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        calls.push(request);
        return handler(request);
      }),
    );
    return calls;
  }

  function legacyRequest(url: string, init?: RequestInit) {
    return new Request(url, {
      ...init,
      headers: {
        Cookie: "wos-session=sealed",
        Authorization: "Bearer actor-token",
        Origin: "https://my.opencompany.chat",
        ...(init?.headers ?? {}),
      },
    });
  }

  it("remaps the typed profile list onto the legacy shape with forwarded credentials", async () => {
    const profile = {
      id: "profile_1",
      name: "Notion",
      siteHost: "notion.so",
      allowedHosts: ["notion.so"],
      status: "connected",
      active: false,
      lastUsedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const calls = stubUpstream(() => Response.json({ data: [profile], meta }));

    const response = await legacyListBrowserProfiles(
      legacyRequest("https://my.opencompany.chat/api/browser-profiles"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ profiles: [profile] });
    const upstream = calls[0]!;
    expect(new URL(upstream.url).href).toBe("https://api.example.test/v1/browser-profiles");
    expect(upstream.headers.get("cookie")).toBe("wos-session=sealed");
    expect(upstream.headers.get("authorization")).toBe("Bearer actor-token");
    expect(upstream.headers.get("origin")).toBe("https://my.opencompany.chat");
  });

  it("remaps creation onto the legacy profile envelope and forwards the body", async () => {
    const calls = stubUpstream(() =>
      Response.json({ data: { id: "profile_1", name: "Notion" }, meta }, { status: 201 }),
    );

    const response = await legacyCreateBrowserProfile(
      legacyRequest("https://my.opencompany.chat/api/browser-profiles", {
        method: "POST",
        body: JSON.stringify({ name: "Notion", url: "https://notion.so" }),
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      profile: { id: "profile_1", name: "Notion" },
    });
    const upstream = calls[0]!;
    expect(upstream.method).toBe("POST");
    await expect(upstream.json()).resolves.toEqual({ name: "Notion", url: "https://notion.so" });
  });

  it("maps typed API errors onto the legacy 400 error string", async () => {
    stubUpstream(() =>
      Response.json(
        {
          error: {
            code: "conflict",
            message: "This browser profile already has an active session.",
            requestId: "req_1",
            retryable: false,
          },
          meta,
        },
        { status: 409 },
      ),
    );

    const response = await legacyCreateBrowserProfileLoginSession(
      legacyRequest("https://my.opencompany.chat/api/browser-profiles/profile_1/login-session", {
        method: "POST",
      }),
      "profile_1",
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "This browser profile already has an active session.",
    });
  });

  it("passes through unauthenticated responses as the legacy empty 401", async () => {
    stubUpstream(() =>
      Response.json(
        { error: { code: "authentication_required", message: "Authentication required." }, meta },
        { status: 401 },
      ),
    );

    const response = await legacyListBrowserProfiles(
      legacyRequest("https://my.opencompany.chat/api/browser-profiles"),
    );
    expect(response.status).toBe(401);
    await expect(response.text()).resolves.toBe("");
  });

  it("remaps login sessions, completion, and deletion onto legacy shapes", async () => {
    const calls = stubUpstream((request) => {
      if (request.url.endsWith("/login-sessions")) {
        return Response.json(
          {
            data: {
              profileId: "profile_1",
              sessionId: "bb_1",
              liveViewUrl: "https://live.example.com/bb_1",
            },
            meta,
          },
          { status: 201 },
        );
      }
      if (request.url.includes("/complete")) {
        return Response.json({
          data: { profileId: "profile_1", sessionId: "bb_1", completed: true },
          meta,
        });
      }
      return Response.json({ data: { profileId: "profile_1", deleted: true }, meta });
    });

    const login = await legacyCreateBrowserProfileLoginSession(
      legacyRequest("https://my.opencompany.chat/api/browser-profiles/profile_1/login-session", {
        method: "POST",
      }),
      "profile_1",
    );
    expect(login.status).toBe(200);
    await expect(login.json()).resolves.toEqual({
      sessionId: "bb_1",
      liveViewUrl: "https://live.example.com/bb_1",
    });

    const complete = await legacyCompleteBrowserProfileLogin(
      legacyRequest("https://my.opencompany.chat/api/browser-profiles/profile_1/complete-login", {
        method: "POST",
        body: JSON.stringify({ sessionId: "bb_1" }),
      }),
      "profile_1",
    );
    expect(complete.status).toBe(200);
    await expect(complete.json()).resolves.toEqual({ ok: true });
    expect(calls[1]!.url).toBe(
      "https://api.example.test/v1/browser-profiles/profile_1/login-sessions/bb_1/complete",
    );

    const removed = await legacyDeleteBrowserProfile(
      legacyRequest("https://my.opencompany.chat/api/browser-profiles/profile_1", {
        method: "DELETE",
      }),
      "profile_1",
    );
    expect(removed.status).toBe(200);
    await expect(removed.json()).resolves.toEqual({ ok: true });
  });

  it("redirects live view to the resolved URL and maps failures to 404", async () => {
    stubUpstream((request) => {
      const sessionId = new URL(request.url).searchParams.get("sessionId");
      if (sessionId === "bb_1") {
        return Response.json({ data: { url: "https://live.example.com/bb_1" }, meta });
      }
      return Response.json(
        { error: { code: "not_found", message: "This browser session is not active." }, meta },
        { status: 404 },
      );
    });

    const found = await legacyBrowserProfileLiveView(
      legacyRequest(
        "https://my.opencompany.chat/api/browser-profiles/profile_1/live-view?sessionId=bb_1",
      ),
      "profile_1",
    );
    expect(found.status).toBe(302);
    expect(found.headers.get("location")).toBe("https://live.example.com/bb_1");

    const missing = await legacyBrowserProfileLiveView(
      legacyRequest(
        "https://my.opencompany.chat/api/browser-profiles/profile_1/live-view?sessionId=bb_2",
      ),
      "profile_1",
    );
    expect(missing.status).toBe(404);
  });

  it("rejects an empty complete-login session id locally with the legacy error", async () => {
    const calls = stubUpstream(() => Response.json({ data: {}, meta }));
    const response = await legacyCompleteBrowserProfileLogin(
      legacyRequest("https://my.opencompany.chat/api/browser-profiles/profile_1/complete-login", {
        method: "POST",
        body: JSON.stringify({}),
      }),
      "profile_1",
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Could not complete login." });
    expect(calls).toHaveLength(0);
  });

  it("maps a rate-limited live view to 503 instead of a dead-session 404", async () => {
    stubUpstream(() =>
      Response.json(
        { error: { code: "rate_limited", message: "Too many requests." }, meta },
        { status: 429 },
      ),
    );
    const response = await legacyBrowserProfileLiveView(
      legacyRequest(
        "https://my.opencompany.chat/api/browser-profiles/profile_1/live-view?sessionId=bb_1",
      ),
      "profile_1",
    );
    expect(response.status).toBe(503);
  });

  it("fails closed with 503 when the canonical API origin is not configured", async () => {
    vi.stubEnv("GOAT_API_ORIGIN", "");
    const response = await legacyListBrowserProfiles(
      legacyRequest("https://my.opencompany.chat/api/browser-profiles"),
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "The canonical API is unavailable.",
    });
  });
});
