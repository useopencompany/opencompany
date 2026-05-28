import { afterEach, describe, expect, it, vi } from "vitest";
import { getWorkOSRedirectUri } from "./workos";

vi.mock("@workos-inc/authkit-nextjs", () => ({
  getWorkOS: vi.fn(),
}));

describe("getWorkOSRedirectUri", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses localhost for local requests even when an external redirect uri is configured", () => {
    vi.stubEnv("NEXT_PUBLIC_WORKOS_REDIRECT_URI", "https://example.ngrok.app/auth/callback");

    expect(getWorkOSRedirectUri("http://127.0.0.1:3100/signup")).toBe(
      "http://localhost:3100/auth/callback",
    );
  });

  it("preserves a localhost request port", () => {
    expect(getWorkOSRedirectUri("http://localhost:3001/auth/sign-in")).toBe(
      "http://localhost:3001/auth/callback",
    );
  });

  it("normalizes IPv6 loopback requests to localhost", () => {
    expect(getWorkOSRedirectUri("http://[::1]:3002/signup")).toBe(
      "http://localhost:3002/auth/callback",
    );
  });

  it("uses the configured redirect uri for non-local requests", () => {
    vi.stubEnv("NEXT_PUBLIC_WORKOS_REDIRECT_URI", "https://app.example.com/auth/callback");

    expect(getWorkOSRedirectUri("https://preview.example.com/signup")).toBe(
      "https://app.example.com/auth/callback",
    );
  });

  it("falls back to the server-only redirect uri when the public one is blank", () => {
    vi.stubEnv("NEXT_PUBLIC_WORKOS_REDIRECT_URI", " ");
    vi.stubEnv("WORKOS_REDIRECT_URI", "https://server.example.com/auth/callback");

    expect(getWorkOSRedirectUri()).toBe("https://server.example.com/auth/callback");
  });
});
