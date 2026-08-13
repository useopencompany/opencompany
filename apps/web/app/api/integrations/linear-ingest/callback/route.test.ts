import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

describe("GET /api/integrations/linear-ingest/callback relay", () => {
  beforeEach(() => {
    vi.stubEnv("GOAT_API_ORIGIN", "https://api.example.test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("forwards the callback with credentials and passes the redirect through untouched", async () => {
    let upstream: Request | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        upstream = input instanceof Request ? input : new Request(input, init);
        return new Response(null, {
          status: 302,
          headers: {
            Location: "https://my.opencompany.chat/settings?integration=linear&setup=connected",
          },
        });
      }),
    );

    const response = await GET(
      new Request(
        "https://my.opencompany.chat/api/integrations/linear-ingest/callback?state=s1&code=c1",
        { headers: { Cookie: "wos-session=sealed" } },
      ),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://my.opencompany.chat/settings?integration=linear&setup=connected",
    );
    const request = upstream as unknown as Request;
    const target = new URL(request.url);
    expect(target.href.split("?")[0]).toBe(
      "https://api.example.test/integrations/linear-ingest/callback",
    );
    expect(target.searchParams.get("state")).toBe("s1");
    expect(target.searchParams.get("code")).toBe("c1");
    expect(request.headers.get("cookie")).toBe("wos-session=sealed");
  });
});
