import { describe, expect, it } from "vitest";
import {
  buildGoatMcpEndpointPath,
  buildGoatMcpResourceMetadataPath,
  goatMcpProtectedResourceMetadata,
  goatMcpResourceIndicatorUrlFromRequest,
  goatMcpResourceUrlFromMetadataRequest,
  resolveGoatAuthKitDomain,
  workosOrganizationIdFromMcpAuth,
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

  it("derives the stable MCP resource indicator URL from endpoint requests", () => {
    const request = new Request("http://internal.local/api/mcp/goat_brain_123/mcp?cursor=1", {
      headers: {
        "x-forwarded-host": "goat.example.com",
        "x-forwarded-proto": "https",
      },
    });

    expect(goatMcpResourceIndicatorUrlFromRequest(request)).toBe(
      "https://goat.example.com/api/mcp",
    );
  });

  it("uses the stable MCP resource indicator in protected-resource metadata", () => {
    const request = new Request(
      "https://goat.example.com/.well-known/oauth-protected-resource/api/mcp/goat_brain_123/mcp",
    );

    expect(goatMcpProtectedResourceMetadata(request, "https://authkit.example.com")).toMatchObject({
      resource: "https://goat.example.com/api/mcp",
      authorization_servers: ["https://authkit.example.com"],
      bearer_methods_supported: ["header"],
    });
  });
});

describe("workosOrganizationIdFromMcpAuth", () => {
  it("extracts a selected WorkOS organization from MCP auth extras", () => {
    expect(
      workosOrganizationIdFromMcpAuth({
        token: "token",
        clientId: "user_1",
        scopes: [],
        extra: { workosOrganizationId: "org_123" },
      }),
    ).toBe("org_123");
  });

  it("returns null when no organization claim is present", () => {
    expect(
      workosOrganizationIdFromMcpAuth({
        token: "token",
        clientId: "user_1",
        scopes: [],
        extra: {},
      }),
    ).toBeNull();
  });
});
