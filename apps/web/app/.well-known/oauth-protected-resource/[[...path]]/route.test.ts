import { afterEach, describe, expect, it, vi } from "vitest";
import { GET, OPTIONS } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /.well-known/oauth-protected-resource", () => {
  it("returns stable OAuth protected resource metadata for path-suffixed requests", async () => {
    vi.stubEnv("OPENCOMPANY_AUTHKIT_DOMAIN", "https://example.authkit.app");

    const response = GET(
      new Request("https://goat.example.com/.well-known/oauth-protected-resource/mcp"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    await expect(response.json()).resolves.toEqual({
      resource: "https://goat.example.com/mcp",
      authorization_servers: ["https://example.authkit.app"],
      bearer_methods_supported: ["header"],
    });
  });

  it("returns CORS headers for metadata preflight requests", () => {
    const response = OPTIONS();

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe("GET, OPTIONS");
  });
});
