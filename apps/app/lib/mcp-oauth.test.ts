import { describe, expect, it } from "vitest";
import {
  buildGoatUserMcpResourceMetadataPath,
  goatMcpProtectedResourceMetadata,
  goatMcpResourceIndicatorUrlFromRequest,
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
      error: "AUTHKIT_DOMAIN is not configured.",
    });
    expect(resolveGoatAuthKitDomain("https://example.authkit.app/oauth2")).toEqual({
      ok: false,
      error: "AUTHKIT_DOMAIN must be a URL origin.",
    });
  });
});

describe("Goat MCP metadata URLs", () => {
  it("builds the MCP protected-resource metadata path", () => {
    expect(buildGoatUserMcpResourceMetadataPath()).toBe(
      "/.well-known/oauth-protected-resource/mcp",
    );
  });

  it("derives the MCP resource URL from path-suffixed metadata requests", () => {
    const request = new Request("http://internal.local/.well-known/oauth-protected-resource/mcp", {
      headers: {
        "x-forwarded-host": "goat.example.com",
        "x-forwarded-proto": "https",
      },
    });

    expect(goatMcpResourceUrlFromMetadataRequest(request)).toBe("https://goat.example.com/mcp");
  });

  it("derives the stable MCP resource indicator URL from endpoint requests", () => {
    const request = new Request("http://internal.local/mcp?cursor=1", {
      headers: {
        "x-forwarded-host": "goat.example.com",
        "x-forwarded-proto": "https",
      },
    });

    expect(goatMcpResourceIndicatorUrlFromRequest(request)).toBe("https://goat.example.com/mcp");
  });

  it("uses the stable MCP resource indicator in protected-resource metadata", () => {
    const request = new Request(
      "https://goat.example.com/.well-known/oauth-protected-resource/mcp",
    );

    expect(goatMcpProtectedResourceMetadata(request, "https://authkit.example.com")).toMatchObject({
      resource: "https://goat.example.com/mcp",
      authorization_servers: ["https://authkit.example.com"],
      bearer_methods_supported: ["header"],
    });
  });
});
