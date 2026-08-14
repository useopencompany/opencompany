import { afterEach, describe, expect, it, vi } from "vitest";
import { DELETE, GET, POST } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("/mcp compatibility relay", () => {
  it.each([
    ["GET", GET],
    ["POST", POST],
    ["DELETE", DELETE],
  ] as const)("relays %s to the API-owned MCP endpoint", async (method, handler) => {
    vi.stubEnv("OPENCOMPANY_API_ORIGIN", "https://api.example.test");
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        requests.push(input instanceof Request ? input : new Request(input, init));
        return new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate":
              'Bearer resource_metadata="https://app.example.test/.well-known/oauth-protected-resource/mcp"',
          },
        });
      }),
    );

    const response = await handler(
      new Request("https://app.example.test/mcp", {
        method,
        ...(method === "POST" ? { body: "{}" } : {}),
      }),
    );

    expect(response.status).toBe(401);
    expect(requests[0]?.url).toBe("https://api.example.test/mcp");
    expect(requests[0]?.method).toBe(method);
    expect(requests[0]?.headers.get("x-forwarded-host")).toBe("app.example.test");
  });

  it("fails closed when the API origin is unavailable", async () => {
    vi.stubEnv("OPENCOMPANY_API_ORIGIN", "");
    const response = await GET(new Request("https://app.example.test/mcp"));
    expect(response.status).toBe(503);
  });
});
