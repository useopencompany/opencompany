import { describe, expect, it } from "vitest";
import {
  buildGoatMcpEndpointPath,
  buildGoatMcpResourceMetadataPath,
  goatMcpResourceUrlFromMetadataRequest,
  resolveGoatAuthKitDomain,
} from "@/lib/mcp-oauth";

describe("resolveGoatAuthKitDomain", () => {
  it("normalizes a configured AuthKit issuer origin", () => {
    expect(resolveGoatAuthKitDomain(" https://example.authkit.app/ ")).toEqual({
      ok: true,
      domain: "https://example.authkit.app",
    });
  });

  it("rejects missing and non-origin values", () => {
    expect(resolveGoatAuthKitDomain("")).toEqual({
      ok: false,
      error: "GOAT_AUTHKIT_DOMAIN is not configured.",
    });
    expect(resolveGoatAuthKitDomain("https://example.authkit.app/oauth2")).toEqual({
      ok: false,
      error: "GOAT_AUTHKIT_DOMAIN must be a URL origin.",
    });
  });
});

describe("Goat MCP metadata URLs", () => {
  it("builds the per-brain MCP endpoint and protected-resource metadata paths", () => {
    expect(buildGoatMcpEndpointPath("goat_brain_123")).toBe("/api/mcp/goat_brain_123/mcp");
    expect(buildGoatMcpResourceMetadataPath("goat_brain_123")).toBe(
      "/.well-known/oauth-protected-resource/api/mcp/goat_brain_123/mcp",
    );
  });

  it("derives the MCP resource URL from path-suffixed metadata requests", () => {
    const request = new Request(
      "http://internal.local/.well-known/oauth-protected-resource/api/mcp/goat_brain_123/mcp",
      {
        headers: {
          "x-forwarded-host": "goat.example.com",
          "x-forwarded-proto": "https",
        },
      },
    );

    expect(goatMcpResourceUrlFromMetadataRequest(request)).toBe(
      "https://goat.example.com/api/mcp/goat_brain_123/mcp",
    );
  });
});
