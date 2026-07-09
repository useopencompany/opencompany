import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/mcp/[brainId]/mcp", () => {
  it("challenges missing bearer tokens with MCP resource metadata", async () => {
    vi.stubEnv("GOAT_AUTHKIT_DOMAIN", "https://example.authkit.app");

    const response = await GET(new Request("https://goat.example.com/api/mcp/goat_brain_123/mcp"), {
      params: Promise.resolve({
        brainId: "goat_brain_123",
        transport: "mcp",
      }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain(
      'resource_metadata="https://goat.example.com/.well-known/oauth-protected-resource/api/mcp/goat_brain_123/mcp"',
    );
  });

  it("rejects unsupported transports before authentication", async () => {
    const response = await GET(new Request("https://goat.example.com/api/mcp/goat_brain_123/sse"), {
      params: Promise.resolve({
        brainId: "goat_brain_123",
        transport: "sse",
      }),
    });

    expect(response.status).toBe(404);
  });
});
