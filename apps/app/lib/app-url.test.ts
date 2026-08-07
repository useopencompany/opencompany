import { getAppUrl } from "@opencompany/core/app-url";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getAppUrl", () => {
  it("normalizes the configured origin", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://opencompany.chat/");

    expect(getAppUrl()).toBe("https://opencompany.chat");
  });

  it("requires the origin in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");

    expect(() => getAppUrl()).toThrow("NEXT_PUBLIC_APP_URL is required in production.");
  });

  it.each([
    "https://opencompany.chat/settings?source=env",
    "https://user:password@opencompany.chat",
    "https://opencompany.chat/#fragment",
  ])("rejects a configured value that is not an origin: %s", (value) => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", value);

    expect(() => getAppUrl()).toThrow("NEXT_PUBLIC_APP_URL must be an HTTP(S) origin.");
  });

  it("treats a slash-only production value as missing", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "///");

    expect(() => getAppUrl()).toThrow("NEXT_PUBLIC_APP_URL is required in production.");
  });

  it("falls back to the local dev origin when unset", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");

    expect(getAppUrl()).toBe("http://localhost:3002");
  });
});
