import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createConnectorMcpOAuthState,
  sanitizeConnectorMcpReturnTo,
  verifyConnectorMcpOAuthState,
} from "./oauth-state";

const input = {
  organizationId: "corg_123",
  userId: "cusr_123",
  returnTo: "/setup",
};

beforeEach(() => {
  vi.stubEnv("CONNECTOR_MCP_OAUTH_STATE_SECRET", "connector-state-secret");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("connector MCP OAuth state", () => {
  it("round-trips a signed state payload", () => {
    const state = createConnectorMcpOAuthState(input);
    const verified = verifyConnectorMcpOAuthState(state);

    expect(verified).toMatchObject(input);
    expect(typeof verified.expiresAt).toBe("number");
    expect(typeof verified.nonce).toBe("string");
  });

  it("rejects a tampered signature", () => {
    const state = createConnectorMcpOAuthState(input);
    const [body] = state.split(".");

    expect(() => verifyConnectorMcpOAuthState(`${body}.deadbeef`)).toThrow(
      "Invalid Connector MCP OAuth state signature.",
    );
  });

  it("rejects expired state", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const state = createConnectorMcpOAuthState(input);

    vi.setSystemTime(new Date("2026-01-01T00:11:00.000Z"));

    expect(() => verifyConnectorMcpOAuthState(state)).toThrow("Connector MCP OAuth state expired.");
  });

  it("requires the connector state secret env", () => {
    vi.stubEnv("CONNECTOR_MCP_OAUTH_STATE_SECRET", "");

    expect(() => createConnectorMcpOAuthState(input)).toThrow(
      "CONNECTOR_MCP_OAUTH_STATE_SECRET is required for Connector MCP OAuth.",
    );
  });

  it("falls back to setup for off-site return paths", () => {
    expect(sanitizeConnectorMcpReturnTo("//evil.example")).toBe("/setup");
    expect(sanitizeConnectorMcpReturnTo("https://evil.example")).toBe("/setup");
    expect(sanitizeConnectorMcpReturnTo("/app")).toBe("/app");
  });
});
