import { GitHubUserAccessAuthError } from "@opencompany/agent/integrations/github-user";
import { createExternalEngineGatewayTicket } from "@opencompany/agent-runtime";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitHubBrokerTicket, registerGitHubBrokerRoutes } from "./github-broker";

const secret = "synthetic-runner-secret";
const capability = {
  codexChatSessionId: "session",
  codexChatTurnId: "turn",
  attemptId: "attempt",
  leaseId: "lease",
  secret,
};
const authority = { actorId: "owner" } as never;
const integration = { id: "integration", status: "connected" } as never;
const apps: ReturnType<typeof Fastify>[] = [];
function fixture() {
  const deps = {
    authorize: vi.fn(async () => authority),
    loadIntegration: vi.fn(async () => integration),
    getAccessToken: vi.fn(async () => "ghu_current"),
    fetch: vi.fn(async () => Response.json({ ok: true })),
  };
  const app = Fastify();
  apps.push(app);
  registerGitHubBrokerRoutes(app, { secret, dependencies: deps });
  const ticket = createGitHubBrokerTicket(capability).ticket;
  const request = (options: Record<string, unknown> = {}) =>
    app.inject({
      method: "GET",
      url: "/broker/github/api.github.com/user",
      headers: { "x-opencompany-github-ticket": ticket },
      ...options,
    });
  return { app, deps, ticket, request };
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("GitHub request broker", () => {
  it("accepts only the GitHub capability domain and an active attempt", async () => {
    const { request, deps } = fixture();
    expect((await request({ headers: {} })).statusCode).toBe(401);
    expect(
      (
        await request({
          headers: {
            "x-opencompany-github-ticket": createExternalEngineGatewayTicket(capability).ticket,
          },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await request({
          headers: {
            "x-opencompany-github-ticket": createGitHubBrokerTicket({
              ...capability,
              now: 0,
              ttlMs: 1,
            }).ticket,
          },
        })
      ).statusCode,
    ).toBe(401);
    // The unauthenticated request is rejected before content-type/body parsing.
    expect(
      (
        await request({
          method: "POST",
          headers: { "content-type": "application/json" },
          payload: "{",
        })
      ).statusCode,
    ).toBe(401);
    expect(deps.authorize).not.toHaveBeenCalled();
    deps.authorize.mockResolvedValueOnce(null as never);
    expect((await request()).statusCode).toBe(403);
    expect(deps.getAccessToken).not.toHaveBeenCalled();
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("resolves the owner and latest token per request and strips caller credentials", async () => {
    const { request, deps, ticket } = fixture();
    deps.getAccessToken.mockResolvedValueOnce("ghu_first").mockResolvedValueOnce("ghu_second");
    const options = {
      headers: {
        "x-opencompany-github-ticket": ticket,
        authorization: "attacker",
        cookie: "session=private",
        "x-other-secret": "private",
        "x-github-api-version": "2022-11-28",
      },
    };
    expect((await request(options)).statusCode).toBe(200);
    expect((await request(options)).statusCode).toBe(200);
    expect(deps.loadIntegration).toHaveBeenCalledWith({ userWorkosId: "owner" });
    const calls = deps.fetch.mock.calls as unknown as [URL, RequestInit][];
    expect(new Headers(calls[0]![1].headers).get("authorization")).toBe("Bearer ghu_first");
    const headers = new Headers(calls[1]![1].headers);
    expect(headers.get("authorization")).toBe("Bearer ghu_second");
    for (const key of ["cookie", "x-other-secret", "x-opencompany-github-ticket"])
      expect(headers.has(key)).toBe(false);
    expect(headers.get("x-github-api-version")).toBe("2022-11-28");
  });

  it("retries only the rejected HTTP mutation with the exact bytes, once", async () => {
    const { request, deps } = fixture();
    const sent: { body: unknown; token: string | null }[] = [];
    deps.fetch.mockImplementation(async (_url?: unknown, init?: RequestInit) => {
      sent.push({ body: init?.body, token: new Headers(init?.headers).get("authorization") });
      return sent.length === 1
        ? Response.json({ message: "Bad credentials" }, { status: 401 })
        : Response.json({ id: 1 }, { status: 201 });
    });
    deps.getAccessToken.mockResolvedValueOnce("ghu_old").mockResolvedValueOnce("ghu_new");
    const result = await request({
      method: "POST",
      payload: Buffer.from([0, 255, 1, 128]),
      headers: {
        "x-opencompany-github-ticket": createGitHubBrokerTicket(capability).ticket,
        "content-type": "application/octet-stream",
      },
    });
    expect(result.statusCode).toBe(201);
    expect(sent).toEqual([
      { body: new Uint8Array([0, 255, 1, 128]), token: "Bearer ghu_old" },
      { body: new Uint8Array([0, 255, 1, 128]), token: "Bearer ghu_new" },
    ]);
    expect(deps.getAccessToken).toHaveBeenLastCalledWith(
      { userWorkosId: "owner", integrationId: "integration" },
      expect.objectContaining({ refreshIfAccessToken: "ghu_old" }),
    );
    expect(deps.authorize).toHaveBeenCalledTimes(2);
  });

  it.each([403, 429, 500, 502])("does not replay status %s", async (status) => {
    const { request, deps } = fixture();
    deps.fetch.mockResolvedValue(Response.json({ message: "rejected" }, { status }));
    expect((await request({ method: "POST", payload: "{}" })).statusCode).toBe(status);
    expect(deps.fetch).toHaveBeenCalledOnce();
    expect(deps.getAccessToken).toHaveBeenCalledOnce();
  });

  it("does not replay transport failures or leak error contents", async () => {
    const { request, deps } = fixture();
    deps.fetch.mockRejectedValue(new Error("secret URL and token"));
    const result = await request();
    expect(result.statusCode).toBe(502);
    expect(result.body).not.toContain("secret URL");
    expect(deps.fetch).toHaveBeenCalledOnce();
  });

  it("stops after a second 401 and denies disconnected or superseded attempts", async () => {
    const { request, deps } = fixture();
    deps.fetch.mockImplementation(async () =>
      Response.json({ message: "Bad credentials" }, { status: 401 }),
    );
    expect((await request()).statusCode).toBe(401);
    expect(deps.fetch).toHaveBeenCalledTimes(2);
    deps.fetch.mockClear();
    deps.authorize.mockResolvedValueOnce(authority).mockResolvedValueOnce(null as never);
    expect((await request()).statusCode).toBe(403);
    expect(deps.fetch).toHaveBeenCalledOnce();
    deps.fetch.mockClear();
    deps.loadIntegration.mockResolvedValueOnce({
      id: "integration",
      status: "disconnected",
    } as never);
    expect((await request()).statusCode).toBe(403);
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("returns a reconnect error for rejected refresh credentials", async () => {
    const { request, deps } = fixture();
    deps.getAccessToken.mockRejectedValue(new GitHubUserAccessAuthError("sensitive detail"));
    const result = await request();
    expect(result.statusCode).toBe(403);
    expect(result.body).not.toContain("sensitive detail");
  });

  it("pins upstream hosts and does not follow redirects or forward cookies", async () => {
    const { request, deps } = fixture();
    expect((await request({ url: "/broker/github/evil.example/user" })).statusCode).toBe(400);
    expect(deps.fetch).not.toHaveBeenCalled();
    deps.fetch.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: {
          location: "https://evil.example/",
          "set-cookie": "private",
          "content-encoding": "gzip",
        },
      }),
    );
    const result = await request({
      url: "/broker/github/api.github.com/repos/org/repo/issues?per_page=1%26x",
    });
    expect(result.statusCode).toBe(302);
    expect(result.headers.location).toBe("https://evil.example/");
    expect(result.headers["set-cookie"]).toBeUndefined();
    const [url, options] = deps.fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.href).toBe("https://api.github.com/repos/org/repo/issues?per_page=1%26x");
    expect(options.redirect).toBe("manual");
  });
});
