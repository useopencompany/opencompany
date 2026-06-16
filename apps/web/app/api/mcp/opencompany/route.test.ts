import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPersonalMemory, searchPersonalMemory } from "@/lib/mcp/opencompany-context";
import { authenticateOpenCompanyMcpAuthorization } from "@/lib/personal/mcp-auth";
import { POST } from "./route";

vi.mock("@/lib/personal/mcp-auth", () => ({
  authenticateOpenCompanyMcpAuthorization: vi.fn(),
}));

vi.mock("@/lib/mcp/opencompany-context", () => ({
  searchPersonalMemory: vi.fn(),
  getPersonalMemory: vi.fn(),
  searchPersonalBrain: vi.fn(),
  getPersonalBrainFile: vi.fn(),
}));

const authenticateOpenCompanyMcpAuthorizationMock = vi.mocked(
  authenticateOpenCompanyMcpAuthorization,
);
const searchPersonalMemoryMock = vi.mocked(searchPersonalMemory);
const getPersonalMemoryMock = vi.mocked(getPersonalMemory);

describe("OpenCompany MCP route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticateOpenCompanyMcpAuthorizationMock.mockResolvedValue({
      tokenId: "pmcpt_123",
      workspaceId: "wks_123",
      userId: "usr_123",
      kind: "personal_token",
    });
  });

  it("requires a valid MCP bearer token or OAuth access token", async () => {
    authenticateOpenCompanyMcpAuthorizationMock.mockResolvedValue(null);

    const response = await POST(jsonRpcRequest("tools/list"));

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      'resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource"',
    );
    await expect(response.json()).resolves.toEqual({
      error: "unauthorized",
      message: "Provide a valid OpenCompany MCP bearer token or connect with OAuth.",
    });
  });

  it("returns MCP server metadata on initialize", async () => {
    const response = await POST(jsonRpcRequest("initialize"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "opencompany", version: "0.2.0" },
      },
    });
  });

  it("lists read-only OpenCompany tools", async () => {
    const response = await POST(jsonRpcRequest("tools/list"));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((tool) => tool.name)).toEqual([
      "search_memory",
      "get_memory",
      "search_personal_brain",
      "get_personal_brain_file",
    ]);
  });

  it("calls search_memory with the authenticated user scope", async () => {
    searchPersonalMemoryMock.mockResolvedValue([
      {
        path: "people/ada.md",
        title: "Ada",
        snippet: "Prefers concise updates.",
        updatedAt: "2026-06-16T10:00:00.000Z",
        score: 2,
      },
    ]);

    const response = await POST(
      jsonRpcRequest("tools/call", {
        name: "search_memory",
        arguments: { query: "Ada", limit: 5 },
      }),
    );

    expect(response.status).toBe(200);
    expect(searchPersonalMemoryMock).toHaveBeenCalledWith(
      { workspaceId: "wks_123", userId: "usr_123" },
      { query: "Ada", limit: 5 },
    );
    await expect(response.json()).resolves.toMatchObject({
      result: {
        content: [{ type: "text", text: expect.stringContaining("Prefers concise updates.") }],
        structuredContent: {
          results: [expect.objectContaining({ path: "people/ada.md" })],
        },
      },
    });
  });

  it("returns a tool error when a requested record is missing", async () => {
    getPersonalMemoryMock.mockResolvedValue(null);

    const response = await POST(
      jsonRpcRequest("tools/call", {
        name: "get_memory",
        arguments: { id: "missing" },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: {
        isError: true,
        content: [{ type: "text", text: "No memory record found for missing." }],
      },
    });
  });

  it("returns invalid params for malformed tool calls", async () => {
    const response = await POST(jsonRpcRequest("tools/call", { name: "search_memory" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: -32602,
        message: "query must be a non-empty string.",
      },
    });
  });
});

function jsonRpcRequest(method: string, params?: unknown) {
  return new Request("https://example.com/api/mcp/opencompany", {
    method: "POST",
    headers: {
      authorization: "Bearer oc_mcp_test",
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
  });
}
