import { afterEach, describe, expect, it, vi } from "vitest";
import { createRemoteMcpStaticBearerAuthProvider } from "./remote-mcp-static-bearer";
import {
  createRenderMcpClient,
  isValidRenderApiKey,
  RENDER_API_BASE_URL,
  RENDER_MCP_ENDPOINT_URL,
  validateRenderApiKey,
} from "./render-mcp";

afterEach(() => vi.unstubAllGlobals());

describe("Render MCP protocol negotiation", () => {
  it("discovers and calls tools on a server that rejects the modern protocol", async () => {
    const requests: {
      method: string;
      rpc?: string;
      version: string | null;
      session: string | null;
    }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        expect(request.url).toBe(RENDER_MCP_ENDPOINT_URL);
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        const message = request.method === "POST" ? await request.json() : undefined;
        const version = request.headers.get("mcp-protocol-version");
        requests.push({
          method: request.method,
          rpc: message?.method,
          version,
          session: request.headers.get("mcp-session-id"),
        });
        if (version === "2026-07-28") {
          return Response.json(
            {
              jsonrpc: "2.0",
              id: message?.id ?? null,
              error: {
                code: -32022,
                message:
                  'unsupported protocol version: "2026-07-28" (supported: [2025-11-25 2025-06-18 2025-03-26 2024-11-05])',
              },
            },
            { status: 400 },
          );
        }
        if (request.method === "GET") return new Response(null, { status: 405 });
        if (request.method === "DELETE") return new Response(null, { status: 204 });
        if (message?.id == null) return new Response(null, { status: 202 });
        const result =
          message.method === "initialize"
            ? {
                protocolVersion: "2025-11-25",
                capabilities: { tools: {} },
                serverInfo: { name: "render-test", version: "1" },
              }
            : message.method === "tools/list"
              ? {
                  tools: [
                    { name: "list_services", inputSchema: { type: "object", properties: {} } },
                  ],
                }
              : { content: [{ type: "text", text: "ok" }] };
        return Response.json(
          { jsonrpc: "2.0", id: message.id, result },
          { headers: { "mcp-session-id": "render-test-session" } },
        );
      }),
    );
    const client = await createRenderMcpClient({
      clientName: "render-test",
      version: "1",
      initializationOptions: { timeout: 1000, maxTotalTimeout: 1000 },
      transport: {
        type: "http",
        url: RENDER_MCP_ENDPOINT_URL,
        authProvider: createRemoteMcpStaticBearerAuthProvider({
          accessToken: "test-token",
          onAuthorizationRequired: () => {
            throw new Error("Unexpected authorization");
          },
        }),
      },
    });
    try {
      expect(await client.listTools()).toMatchObject({ tools: [{ name: "list_services" }] });
      expect(await client.callTool({ name: "list_services", arguments: {} })).toMatchObject({
        content: [{ text: "ok" }],
      });
    } finally {
      await client.close();
    }
    expect(requests.filter(({ method }) => method === "POST").map(({ rpc }) => rpc)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ]);
    expect(requests.every(({ version }) => version === "2025-11-25")).toBe(true);
    expect(requests.find(({ rpc }) => rpc === "tools/call")?.session).toBe("render-test-session");
    expect(requests.at(-1)).toMatchObject({ method: "DELETE", session: "render-test-session" });
  });
});

describe("Render MCP integration", () => {
  it("pins the provider endpoints", () => {
    expect(RENDER_MCP_ENDPOINT_URL).toBe("https://mcp.render.com/mcp");
    expect(RENDER_API_BASE_URL).toBe("https://api.render.com/v1");
  });

  it("accepts only Render-shaped API keys", () => {
    expect(isValidRenderApiKey("rnd_abcdefgh12345678")).toBe(true);
    expect(isValidRenderApiKey(" rnd_abcdefgh12345678 ")).toBe(false);
    expect(isValidRenderApiKey("sk_abcdefgh12345678")).toBe(false);
    expect(isValidRenderApiKey("rnd_short")).toBe(false);
  });

  it("validates the key against Render without returning it", async () => {
    const fetch = vi.fn(async () =>
      Response.json([
        { owner: { id: "tea_123", name: "Acme", email: "founder@example.com", type: "team" } },
      ]),
    );
    await expect(validateRenderApiKey("rnd_abcdefgh12345678", { fetch })).resolves.toEqual({
      ok: true,
      owner: { id: "tea_123", name: "Acme", email: "founder@example.com" },
    });
    expect(fetch).toHaveBeenCalledWith(`${RENDER_API_BASE_URL}/owners?limit=1`, {
      headers: { Authorization: "Bearer rnd_abcdefgh12345678" },
      signal: expect.any(AbortSignal),
    });
  });

  it("turns rejected and malformed responses into safe connection errors", async () => {
    await expect(
      validateRenderApiKey("rnd_abcdefgh12345678", {
        fetch: vi.fn(async () => new Response(null, { status: 401 })),
      }),
    ).resolves.toEqual({
      ok: false,
      error: "Render rejected this API key. Check it and try again.",
    });
    await expect(
      validateRenderApiKey("rnd_abcdefgh12345678", {
        fetch: vi.fn(async () => Response.json({ owner: {} })),
      }),
    ).resolves.toEqual({
      ok: false,
      error: "Render returned an unexpected response while validating the key.",
    });
  });
});
