import { headers } from "next/headers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serverApiClient } from "@/lib/server-api-client";

vi.mock("next/headers", () => ({ headers: vi.fn() }));

describe("serverApiClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OPENCOMPANY_API_ORIGIN", "https://api.example.test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("uses a freshly sealed session for auth completion without losing browser preferences", async () => {
    vi.mocked(headers).mockResolvedValue(
      new Headers({
        Cookie:
          "wos-session=stale-session; goat-active-workspace=workspace_1; goat-active-brain=brain_1",
        Authorization: "Bearer incompatible-session-token",
      }) as never,
    );
    let upstream: Request | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        upstream = input instanceof Request ? input : new Request(input, init);
        return Response.json({ data: {} });
      }),
    );

    const client = await serverApiClient({
      sessionCookie: { name: "wos-session", value: "fresh/session==" },
      origin: "https://my.opencompany.chat",
    });
    await client.v1.identity.sync.$post();

    const request = upstream as unknown as Request;
    expect(request.method).toBe("POST");
    expect(new URL(request.url).pathname).toBe("/v1/identity/sync");
    expect(request.headers.get("cookie")).toBe(
      "wos-session=fresh%2Fsession%3D%3D; goat-active-workspace=workspace_1; goat-active-brain=brain_1",
    );
    expect(request.headers.get("authorization")).toBeNull();
    expect(request.headers.get("origin")).toBe("https://my.opencompany.chat");
  });
});
