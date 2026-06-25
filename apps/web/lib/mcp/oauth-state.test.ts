import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpOAuthState, sanitizeReturnTo, verifyMcpOAuthState } from "@/lib/mcp/oauth-state";

const input = { workspaceId: "wks_1", userId: "usr_1", returnTo: "/company/integrations" };

beforeEach(() => {
  vi.stubEnv("MCP_OAUTH_STATE_SECRET", "test-state-secret");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("MCP OAuth state", () => {
  it("round-trips a signed state payload", () => {
    const state = createMcpOAuthState(input);
    const verified = verifyMcpOAuthState(state);

    expect(verified).toMatchObject(input);
    expect(typeof verified.expiresAt).toBe("number");
    expect(typeof verified.nonce).toBe("string");
  });

  it("rejects a tampered signature", () => {
    const state = createMcpOAuthState(input);
    const [body] = state.split(".");
    expect(() => verifyMcpOAuthState(`${body}.deadbeef`)).toThrow(
      "Invalid MCP OAuth state signature.",
    );
  });

  it("rejects state signed with a different secret", () => {
    const state = createMcpOAuthState(input);
    vi.stubEnv("MCP_OAUTH_STATE_SECRET", "a-different-secret");
    expect(() => verifyMcpOAuthState(state)).toThrow("Invalid MCP OAuth state signature.");
  });

  it("rejects expired state", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const state = createMcpOAuthState(input);
    vi.setSystemTime(new Date("2026-01-01T00:11:00.000Z"));
    expect(() => verifyMcpOAuthState(state)).toThrow("MCP OAuth state expired.");
  });

  it("requires the state secret env", () => {
    vi.unstubAllEnvs();
    expect(() => createMcpOAuthState(input)).toThrow("MCP_OAUTH_STATE_SECRET is required");
  });

  it("falls back to a safe return path for off-site redirects", () => {
    expect(sanitizeReturnTo("//evil.example")).toBe("/company/integrations");
    expect(sanitizeReturnTo("https://evil.example")).toBe("/company/integrations");
    expect(sanitizeReturnTo("/agents")).toBe("/agents");
  });
});
