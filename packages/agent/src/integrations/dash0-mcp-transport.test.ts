import { createMCPClient } from "@ai-sdk/mcp";
import { describe, expect, it, vi } from "vitest";
import {
  createDash0McpFetch,
  DASH0_MCP_ENDPOINT_URL,
  DASH0_MCP_REGIONS,
} from "./dash0-mcp-transport";
import { createRemoteMcpStaticBearerAuthProvider } from "./remote-mcp-static-bearer";

const mismatch = (expected_region = "gcp-europe-west4", actual_region = "aws-eu-west-1") =>
  Response.json(
    { error: "organization_region_mismatch", expected_region, actual_region },
    { status: 421 },
  );
const init = {
  method: "POST",
  headers: { Authorization: "Bearer test-token" },
  body: '{"method":"initialize"}',
};

describe("Dash0 regional transport", () => {
  it.each(Object.entries(DASH0_MCP_REGIONS).filter(([region]) => region !== "aws-eu-west-1"))(
    "retries the rejected request in %s and routes later MCP requests to the same endpoint",
    async (region, endpoint) => {
      const requests: {
        url: string;
        method: string;
        body: string;
        authorization: string | null;
        redirect: string;
      }[] = [];
      const fetchRequest = vi.fn(async (input: RequestInfo | URL) => {
        const request = input as Request;
        requests.push({
          url: request.url,
          method: request.method,
          body: await request.text(),
          authorization: request.headers.get("authorization"),
          redirect: request.redirect,
        });
        return requests.length === 1 ? mismatch(region) : new Response(null, { status: 202 });
      });
      const fetch = createDash0McpFetch(fetchRequest);
      await fetch(DASH0_MCP_ENDPOINT_URL, init);
      await fetch(DASH0_MCP_ENDPOINT_URL, { ...init, body: '{"method":"tools/list"}' });
      expect(requests.map(({ url }) => url)).toEqual([DASH0_MCP_ENDPOINT_URL, endpoint, endpoint]);
      expect(requests[1]).toEqual({ ...requests[0], url: endpoint });
      expect(requests.every(({ redirect }) => redirect === "error")).toBe(true);
      // The SDK also uses this fetch for OAuth. Keep token refresh at its original issuer.
      await fetch("https://api.eu-west-1.aws.dash0.com/oauth/token", {
        method: "POST",
        body: "grant_type=refresh_token",
      });
      expect(requests[3]?.url).toBe("https://api.eu-west-1.aws.dash0.com/oauth/token");
    },
  );

  it("reproduces the reported GCP mismatch through real SDK initialization, discovery, execution, and close", async () => {
    const requests: { url: string; method: string; rpc?: string; session: string | null }[] = [];
    const fetchRequest = vi.fn(async (input: RequestInfo | URL) => {
      const request = input as Request;
      expect(request.headers.get("authorization")).toBe("Bearer test-token");
      const message = request.method === "POST" ? await request.json() : undefined;
      requests.push({
        url: request.url,
        method: request.method,
        rpc: message?.method,
        session: request.headers.get("mcp-session-id"),
      });
      if (request.url === DASH0_MCP_ENDPOINT_URL) return mismatch();
      if (request.method === "DELETE") return new Response(null, { status: 204 });
      if (request.method === "GET") return new Response(null, { status: 405 });
      if (!message?.id) return new Response(null, { status: 202 });
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "dash0-test", version: "1" },
            }
          : message.method === "tools/list"
            ? {
                tools: [{ name: "getLogRecords", inputSchema: { type: "object", properties: {} } }],
              }
            : { content: [{ type: "text", text: "ok" }] };
      return Response.json(
        { jsonrpc: "2.0", id: message.id, result },
        { headers: { "mcp-session-id": "gcp-session" } },
      );
    });
    const client = await createMCPClient({
      transport: {
        type: "http",
        url: DASH0_MCP_ENDPOINT_URL,
        fetch: createDash0McpFetch(fetchRequest),
        authProvider: createRemoteMcpStaticBearerAuthProvider({
          accessToken: "test-token",
          onAuthorizationRequired: () => {
            throw new Error("Unexpected authentication");
          },
        }),
      },
    });
    expect((await client.listTools()).tools[0]?.name).toBe("getLogRecords");
    expect(await client.callTool({ name: "getLogRecords", arguments: {} })).toMatchObject({
      content: [{ text: "ok" }],
    });
    await client.close();
    expect(requests[0]?.url).toBe(DASH0_MCP_ENDPOINT_URL);
    expect(
      requests.slice(1).every(({ url }) => url === DASH0_MCP_REGIONS["gcp-europe-west4"]),
    ).toBe(true);
    expect(requests.find(({ rpc }) => rpc === "tools/list")?.session).toBe("gcp-session");
    expect(requests.at(-1)).toMatchObject({ method: "DELETE", session: "gcp-session" });
  });

  it.each([
    "https://evil.example/mcp",
    "http://api.eu-west-1.aws.dash0.com/mcp",
    "https://api.eu-west-1.aws.dash0.com.evil.example/mcp",
    `${DASH0_MCP_ENDPOINT_URL}?target=other`,
    `${DASH0_MCP_ENDPOINT_URL}#other`,
  ])("never sends credentials to %s", async (url) => {
    const network = vi.fn();
    await expect(createDash0McpFetch(network)(url, init)).rejects.toThrow();
    expect(network).not.toHaveBeenCalled();
  });

  it.each(["https://evil.example/mcp", "__proto__", "unknown-region"])(
    "rejects unreviewed region hint %s without retrying",
    async (region) => {
      const network = vi.fn(async () => mismatch(region));
      await expect(createDash0McpFetch(network)(DASH0_MCP_ENDPOINT_URL, init)).rejects.toThrow(
        "does not support",
      );
      expect(network).toHaveBeenCalledTimes(1);
    },
  );

  it("does not retry malformed errors, other statuses, or another region's response", async () => {
    for (const response of [
      new Response("not json", { status: 421 }),
      Response.json({ expected_region: "gcp-europe-west4" }, { status: 421 }),
      mismatch("gcp-europe-west4", "aws-us-west-2"),
      new Response(null, { status: 500 }),
      new Response(null, { status: 302, headers: { Location: "https://evil.example" } }),
    ]) {
      const network = vi.fn(async () => response);
      expect(await createDash0McpFetch(network)(DASH0_MCP_ENDPOINT_URL, init)).toBe(response);
      expect(network).toHaveBeenCalledTimes(1);
    }
  });

  it("makes at most one regional retry and keeps clients isolated", async () => {
    const network = vi.fn(async (_input: RequestInfo | URL) => mismatch());
    const first = createDash0McpFetch(network);
    expect((await first(DASH0_MCP_ENDPOINT_URL, init)).status).toBe(421);
    expect(network).toHaveBeenCalledTimes(2);
    await first(DASH0_MCP_ENDPOINT_URL, init);
    expect(network).toHaveBeenCalledTimes(3);
    await createDash0McpFetch(network)(DASH0_MCP_ENDPOINT_URL, init);
    expect((network.mock.calls[3]?.[0] as Request).url).toBe(DASH0_MCP_ENDPOINT_URL);
  });

  it("does not move an established session to a different region", async () => {
    const network = vi.fn(async (_input: RequestInfo | URL) => mismatch());
    await expect(
      createDash0McpFetch(network)(DASH0_MCP_ENDPOINT_URL, {
        ...init,
        headers: { ...init.headers, "mcp-session-id": "old-session" },
      }),
    ).rejects.toThrow("start a new session");
    expect(network).toHaveBeenCalledTimes(1);
  });
});
