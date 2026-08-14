import { afterEach, describe, expect, it, vi } from "vitest";
import { createGoatMcpService } from "./mcp-http";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("API-owned MCP service", () => {
  it("challenges missing bearer tokens against the public forwarded resource", async () => {
    vi.stubEnv("GOAT_AUTHKIT_DOMAIN", "https://example.authkit.app");
    const response = await createGoatMcpService({ gatewayApiKey: "gateway_test" }).handle(
      new Request("http://api.internal/mcp", {
        headers: {
          "x-forwarded-host": "app.example.test",
          "x-forwarded-proto": "https",
        },
      }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain(
      'resource_metadata="https://app.example.test/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it("reports missing AuthKit configuration before authentication", async () => {
    vi.stubEnv("GOAT_AUTHKIT_DOMAIN", "");
    const response = await createGoatMcpService({ gatewayApiKey: "gateway_test" }).handle(
      new Request("https://app.example.test/mcp"),
    );
    expect(response.status).toBe(503);
  });
});
