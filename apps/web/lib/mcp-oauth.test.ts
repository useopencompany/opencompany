import { describe, expect, it } from "vitest";
import {
  buildUserMcpResourceMetadataPath,
  mcpProtectedResourceMetadata,
  mcpResourceIndicatorUrlFromRequest,
  mcpResourceUrlFromMetadataRequest,
  resolveAuthKitDomain,
} from "@/lib/mcp-oauth";

describe("resolveAuthKitDomain", () => {
  it("normalizes a configured AuthKit issuer origin", () => {
    expect(resolveAuthKitDomain(" https://example.authkit.app/ ")).toEqual({
      ok: true,
      domain: "https://example.authkit.app",
    });
  });

  it("rejects missing and non-origin values", () => {
    expect(resolveAuthKitDomain("")).toEqual({
      ok: false,
      error: "OPENCOMPANY_AUTHKIT_DOMAIN is not configured.",
    });
    expect(resolveAuthKitDomain("https://example.authkit.app/oauth2")).toEqual({
      ok: false,
      error: "OPENCOMPANY_AUTHKIT_DOMAIN must be a URL origin.",
    });
  });
});

describe("opencompany MCP metadata URLs", () => {
  it("builds the MCP protected-resource metadata path", () => {
    expect(buildUserMcpResourceMetadataPath()).toBe("/.well-known/oauth-protected-resource/mcp");
  });

  it("derives the MCP resource URL from path-suffixed metadata requests", () => {
    const request = new Request("http://internal.local/.well-known/oauth-protected-resource/mcp", {
      headers: {
        "x-forwarded-host": "opencompany.example.com",
        "x-forwarded-proto": "https",
      },
    });

    expect(mcpResourceUrlFromMetadataRequest(request)).toBe("https://opencompany.example.com/mcp");
  });

  it("derives the stable MCP resource indicator URL from endpoint requests", () => {
    const request = new Request("http://internal.local/mcp?cursor=1", {
      headers: {
        "x-forwarded-host": "opencompany.example.com",
        "x-forwarded-proto": "https",
      },
    });

    expect(mcpResourceIndicatorUrlFromRequest(request)).toBe("https://opencompany.example.com/mcp");
  });

  it("uses the stable MCP resource indicator in protected-resource metadata", () => {
    const request = new Request(
      "https://opencompany.example.com/.well-known/oauth-protected-resource/mcp",
    );

    expect(mcpProtectedResourceMetadata(request, "https://authkit.example.com")).toMatchObject({
      resource: "https://opencompany.example.com/mcp",
      authorization_servers: ["https://authkit.example.com"],
      bearer_methods_supported: ["header"],
    });
  });
});
