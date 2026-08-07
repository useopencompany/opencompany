import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/brain-capture", () => ({ captureToGoatBrainInbox: vi.fn() }));

import { GET } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /mcp", () => {
  it("challenges missing bearer tokens with MCP resource metadata", async () => {
    vi.stubEnv("GOAT_AUTHKIT_DOMAIN", "https://example.authkit.app");

    const response = await GET(new Request("https://goat.example.com/mcp"));

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain(
      'resource_metadata="https://goat.example.com/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it("reports missing AuthKit configuration before authentication", async () => {
    vi.stubEnv("GOAT_AUTHKIT_DOMAIN", "");

    const response = await GET(new Request("https://goat.example.com/mcp"));

    expect(response.status).toBe(503);
  });
});
