import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

describe("GET /api/billing/reconcile relay", () => {
  beforeEach(() => vi.stubEnv("GOAT_API_ORIGIN", "https://api.example.test"));
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("preserves the cron bearer secret and response", async () => {
    let upstream: Request | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (requestInput: URL | RequestInfo, init?: RequestInit) => {
        upstream = requestInput instanceof Request ? requestInput : new Request(requestInput, init);
        return Response.json({ released: 4, failed: 0 });
      }),
    );
    const response = await GET(
      new Request("https://my.opencompany.chat/api/billing/reconcile", {
        headers: { authorization: "Bearer cron-secret" },
      }),
    );

    expect(response.status).toBe(200);
    const request = upstream as unknown as Request;
    expect(request.url).toBe("https://api.example.test/billing/reconcile");
    expect(request.headers.get("authorization")).toBe("Bearer cron-secret");
  });
});
